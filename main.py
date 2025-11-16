import asyncio
import asyncpg
from aiogram import Bot, Dispatcher
from aiogram.fsm.storage.memory import MemoryStorage
from globals import AppContext, TELEGRAM_TOKEN
from services.streaming import StreamingService
from handlers.referrals import register_referral_handlers
from core.stellar import load_public_key
from handlers.main_menu import register_main_handlers
from handlers.copy_trading import register_copy_handlers
import logging
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
import os
from stellar_sdk import Keypair
from services.referrals import daily_payout
import socket
import json
import base64
import boto3
from botocore.exceptions import ClientError
from cryptography.fernet import Fernet

class RedactMnemonicFilter(logging.Filter):
    def filter(self, record):
        if hasattr(record, 'msg') and 'recovery_secret' in str(record.msg):
            start_idx = record.msg.find('recovery_secret')
            end_idx = record.msg.find('}', start_idx) + 1
            if end_idx > start_idx:
                record.msg = record.msg.replace(
                    record.msg[start_idx:end_idx],
                    'recovery_secret: [REDACTED]'
                )
        return True

# Configure logging (once)
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
logger.addFilter(RedactMnemonicFilter())

# Log initial environment details (once)
logger.info(f"Current working directory: {os.getcwd()}")
logger.info(f"FEE_WALLET from os.getenv at startup: {os.getenv('FEE_WALLET')}")

async def init_db_pool_nitro():
    client = boto3.client('secretsmanager', region_name='us-west-1')
    secret = client.get_secret_value(
        SecretId='arn:aws:secretsmanager:us-west-1:783906944039:secret:rds!db-2613ba5a-9276-4830-908f-5bfab8cb0497-cPGCqs'
    )
    creds = json.loads(secret['SecretString'])
    return await asyncpg.create_pool(
        user=creds['username'],
        password=creds['password'],
        database='nitro',
        host='trading-bot-db1-nitro.cz2imkksk7b4.us-west-1.rds.amazonaws.com',
        port=5432
    )

async def init_db_pool_copytrading():
    copytrading_password = os.getenv('COPYTRADING_DB_PASSWORD')
    if not copytrading_password:
        logger.error("COPYTRADING_DB_PASSWORD not found in environment variables")
        raise ValueError("COPYTRADING_DB_PASSWORD not found in environment variables")
    return await asyncpg.create_pool(
        user='botadmin',
        password=copytrading_password,
        database='copytrading',
        host='trading-bot-db2.cz2imkksk7b4.us-west-1.rds.amazonaws.com',
        port=5433
    )

def generate_data_key():
    try:
        kms_client = boto3.client('kms', region_name='us-west-1')
        response = kms_client.generate_data_key(
            KeyId='arn:aws:kms:us-west-1:961017070653:key/cd27efb2-0e00-44f5-b218-cb5a6e671a82',
            KeySpec='AES_256'
        )
        return {
            "Plaintext": response['Plaintext'],
            "CiphertextBlob": base64.b64encode(response['CiphertextBlob']).decode('utf-8')
        }
    except ClientError as e:
        logger.error(f"KMS GenerateDataKey failed: {str(e)}")
        raise

async def communicate_with_enclave(request, cid=50, port=5000):
    client = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    try:
        client.connect((cid, port))
        request_data = json.dumps(request).encode('utf-8')
        # Send length as a 4-byte binary integer (big-endian)
        length = len(request_data)
        length_prefix = length.to_bytes(4, byteorder='big')
        logger.debug(f"Sending length: {length} bytes")
        client.send(length_prefix + request_data)
        
        # Receive length prefix as a 4-byte binary integer
        length_prefix = client.recv(4)
        if len(length_prefix) != 4:
            raise ValueError("Failed to read length prefix from enclave")
        length = int.from_bytes(length_prefix, byteorder='big')
        logger.debug(f"Expecting response of length: {length}")
        
        # Receive the response data
        response_data = client.recv(length).decode('utf-8')
        response = json.loads(response_data)
        logger.debug(f"Received response from enclave: {response}")
        return response
    except Exception as e:
        logger.error(f"Enclave communication error: {str(e)}")
        raise TimeoutError(f"Failed to connect to enclave at CID {cid}, port {port}")
    finally:
        client.close()

async def generate_keypair(telegram_id, db_pool):
    # Generate data key on the parent side
    kms_response = generate_data_key()
    data_key = kms_response["Plaintext"]
    encrypted_data_key = kms_response["CiphertextBlob"]

    request = {
        "action": "generate",
        "telegram_id": str(telegram_id),
        "data_key": base64.b64encode(data_key).decode('utf-8'),
        "encrypted_data_key": encrypted_data_key
    }
    response = await communicate_with_enclave(request)
    if "error" in response:
        raise ValueError(response["error"])

    async with db_pool.acquire() as conn:
        exists = await conn.fetchval(
            "SELECT telegram_id FROM users WHERE telegram_id = $1", int(telegram_id)
        )
        if exists:
            await conn.execute(
                "UPDATE users SET public_key = $1, encrypted_secret = $2, encrypted_data_key = $3 "
                "WHERE telegram_id = $4",
                response["public_key"],
                response["encrypted_secret"],
                response["encrypted_data_key"],
                int(telegram_id)
            )
            logger.info(f"Updated user in nitro.db with telegram_id {telegram_id}")
        else:
            await conn.execute(
                "INSERT INTO users (telegram_id, public_key, encrypted_secret, encrypted_data_key) "
                "VALUES ($1, $2, $3, $4)",
                int(telegram_id),
                response["public_key"],
                response["encrypted_secret"],
                response["encrypted_data_key"]
            )
            logger.info(f"Inserted user into nitro.db with telegram_id {telegram_id}")
    return response  # Return the full response dictionary

async def sign_transaction(telegram_id, transaction_xdr, db_pool):
    async with db_pool.acquire() as conn:
        user_data = await conn.fetchrow(
            "SELECT public_key, encrypted_secret, encrypted_data_key FROM users WHERE telegram_id = $1",
            int(telegram_id)
        )
        if not user_data:
            logger.error(f"No keypair found for telegram_id {telegram_id}")
            raise ValueError(f"No keypair found for telegram_id {telegram_id}")

    # Retrieve temporary AWS credentials from the parent instance
    session = boto3.Session()
    credentials = session.get_credentials()
    aws_credentials = {
        "aws_access_key_id": credentials.access_key,
        "aws_secret_access_key": credentials.secret_key,
        "aws_session_token": credentials.token
    }

    request = {
        "action": "sign",
        "public_key": user_data["public_key"],
        "encrypted_secret": user_data["encrypted_secret"],
        "encrypted_data_key": user_data["encrypted_data_key"],
        "transaction_xdr": transaction_xdr,
        "aws_credentials": aws_credentials  # Pass credentials to the enclave
    }
    response = await communicate_with_enclave(request)
    if "error" in response:
        logger.error(f"Enclave signing error for telegram_id {telegram_id}: {response['error']}")
        raise ValueError(response["error"])
    return response["signed_transaction"]

async def shutdown(app_context, streaming_service):
    logger.info("Initiating shutdown...")
    if streaming_service:
        for chat_id in list(streaming_service.tasks.keys()):
            try:
                await streaming_service.stop_streaming(chat_id)
            except Exception as e:
                logger.warning(f"Failed to stop streaming for chat_id {chat_id}: {str(e)}")
    for task in app_context.tasks:
        if not task.done():
            task.cancel()
    await asyncio.gather(*app_context.tasks, return_exceptions=True)
    await app_context.shutdown()
    if app_context.bot:
        await app_context.bot.session.close()
    logger.info("Bot stopped gracefully.")

async def schedule_daily_payout(app_context, streaming_service, chat_id=None):
    if chat_id is None:
        admin_id = os.getenv("ADMIN_TELEGRAM_ID")
        if admin_id is None:
            logger.error("ADMIN_TELEGRAM_ID not set in environment variables")
            return
        try:
            chat_id = int(admin_id)
        except ValueError:
            logger.error(f"Invalid ADMIN_TELEGRAM_ID: {admin_id} (must be an integer)")
            return

    while not app_context.shutdown_flag.is_set():
        now = datetime.now(ZoneInfo("UTC"))
        next_run = now.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
        logger.info("Next payout scheduled for %s UTC", next_run)
        await asyncio.sleep((next_run - now).total_seconds())
        logger.info("Running daily payout at %s UTC", datetime.now(ZoneInfo("UTC")))
        try:
            await daily_payout(app_context.db_pool_nitro, app_context.db_pool_copytrading, app_context.bot, chat_id, app_context)
        except Exception as e:
            logger.error(f"Daily payout failed: {str(e)}", exc_info=True)
            if chat_id:
                await app_context.bot.send_message(chat_id, f"Daily payout failed: {str(e)}")

async def enclave_signer(telegram_id, transaction_xdr, db_pool):
    """A signing function compatible with AssembledTransactionAsync that uses the enclave."""
    signed_xdr = await sign_transaction(telegram_id, transaction_xdr, db_pool)
    return signed_xdr

async def setup_fee_wallet(app_context):
    disbursement_wallet_secret = os.getenv("DISBURSEMENT_WALLET_SECRET")
    if not disbursement_wallet_secret:
        logger.error("DISBURSEMENT_WALLET_SECRET not found in .env")
        raise ValueError("DISBURSEMENT_WALLET_SECRET not found in .env")

    disbursement_wallet_public = os.getenv("DISBURSEMENT_WALLET")
    if not disbursement_wallet_public:
        logger.error("DISBURSEMENT_WALLET not found in .env")
        raise ValueError("DISBURSEMENT_WALLET not found in .env")

    fee_keypair = Keypair.from_secret(disbursement_wallet_secret)
    fee_public_key = fee_keypair.public_key
    fee_telegram_id = -1

    if fee_public_key != disbursement_wallet_public:
        logger.error(f"DISBURSEMENT_WALLET_SECRET does not match DISBURSEMENT_WALLET public key: {fee_public_key} != {disbursement_wallet_public}")
        raise ValueError("DISBURSEMENT_WALLET_SECRET does not match DISBURSEMENT_WALLET public key")

    if not app_context.fee_wallet:
        logger.error("FEE_WALLET not found in .env")
        raise ValueError("FEE_WALLET not found in .env")
    try:
        Keypair.from_public_key(app_context.fee_wallet)
    except Exception:
        raise ValueError("Invalid FEE_WALLET address")

    # Generate keypair in the enclave
    response = await generate_keypair(fee_telegram_id, app_context.db_pool_nitro)
    if "error" in response:
        raise ValueError(response["error"])

    encrypted_data_key = response["encrypted_data_key"]

    kms_client = boto3.client('kms', region_name='us-west-1')
    response = kms_client.decrypt(
        CiphertextBlob=base64.b64decode(encrypted_data_key)
    )
    data_key = response['Plaintext']
    logger.debug("Decryption of encrypted_data_key successful")

    cipher = Fernet(base64.urlsafe_b64encode(data_key))
    encrypted_secret = cipher.encrypt(fee_keypair.secret.encode()).hex()

    async with app_context.db_pool_nitro.acquire() as conn:
        exists = await conn.fetchval(
            "SELECT telegram_id FROM users WHERE telegram_id = $1", fee_telegram_id
        )
        if exists:
            await conn.execute(
                "UPDATE users SET public_key = $1, encrypted_secret = $2, encrypted_data_key = $3 "
                "WHERE telegram_id = $4",
                fee_public_key,
                encrypted_secret,
                encrypted_data_key,
                fee_telegram_id
            )
            logger.info(f"Updated fee wallet in nitro.db with telegram_id {fee_telegram_id}")
        else:
            await conn.execute(
                "INSERT INTO users (telegram_id, public_key, encrypted_secret, encrypted_data_key) "
                "VALUES ($1, $2, $3, $4)",
                fee_telegram_id,
                fee_public_key,
                encrypted_secret,
                encrypted_data_key
            )
            logger.info(f"Inserted fee wallet into nitro.db with telegram_id {fee_telegram_id}")

    app_context.fee_telegram_id = fee_telegram_id

async def run_master():
    db_pool_nitro = await init_db_pool_nitro()
    db_pool_copytrading = await init_db_pool_copytrading()

    app_context = AppContext(db_pool_nitro=db_pool_nitro, db_pool_copytrading=db_pool_copytrading)
    app_context.bot = Bot(token=TELEGRAM_TOKEN)
    storage = MemoryStorage()
    app_context.dp = Dispatcher(storage=storage)

    app_context.fee_wallet = os.getenv("FEE_WALLET")
    logger.info(f"Loaded FEE_WALLET into app_context: {app_context.fee_wallet}")
    if not app_context.fee_wallet:
        raise ValueError("FEE_WALLET not found in .env")
    try:
        Keypair.from_public_key(app_context.fee_wallet)
    except Exception:
        raise ValueError("Invalid FEE_WALLET address")

    # Setup the fee wallet in nitro.db
    await setup_fee_wallet(app_context)

    # Attach generate_keypair
    async def wrapped_generate_keypair(telegram_id):
        return await generate_keypair(telegram_id, app_context.db_pool_nitro)
    app_context.generate_keypair = wrapped_generate_keypair

    # Attach sign_transaction
    async def wrapped_sign_transaction(telegram_id, transaction_xdr):
        return await sign_transaction(telegram_id, transaction_xdr, app_context.db_pool_nitro)
    app_context.sign_transaction = wrapped_sign_transaction

    # Attach transaction_signer for AssembledTransactionAsync
    async def wrapped_enclave_signer(telegram_id, transaction_xdr):
        return await enclave_signer(telegram_id, transaction_xdr, app_context.db_pool_nitro)
    app_context.transaction_signer = wrapped_enclave_signer

    # Keep load_public_key
    async def wrapped_load_public_key(telegram_id):
        return await load_public_key(app_context, telegram_id)
    app_context.load_public_key = wrapped_load_public_key

    app_context.slippage = 0.05
    app_context.shutdown_flag = asyncio.Event()
    app_context.tasks = []

    streaming_service = StreamingService(app_context)
    register_main_handlers(app_context.dp, app_context, streaming_service)
    register_copy_handlers(dp=app_context.dp, streaming_service=streaming_service, app_context=app_context)
    register_referral_handlers(app_context.dp, app_context)

    await app_context.bot.delete_webhook(drop_pending_updates=True)
    logger.info("Dropped pending updates to prevent stale command processing")

    max_retries = float('inf')
    retry_delay = 1
    max_delay = 60
    retry_count = 0

    # Schedule the daily payout task
    app_context.tasks.append(asyncio.create_task(schedule_daily_payout(app_context, streaming_service, chat_id=5014800072)))

    while retry_count < max_retries:
        try:
            await app_context.dp.start_polling(app_context.bot)
            break
        except Exception as e:
            logger.error(f"Polling failed: {str(e)}")
            retry_count += 1
            delay = min(retry_delay * (2 ** retry_count), max_delay)
            logger.warning(f"Retrying in {delay} seconds (attempt {retry_count})...")
            await asyncio.sleep(delay)
        except (KeyboardInterrupt, asyncio.CancelledError):
            await shutdown(app_context, streaming_service)
            logger.info("Bot stopped gracefully.")
            break

if __name__ == "__main__":
    asyncio.run(run_master())
