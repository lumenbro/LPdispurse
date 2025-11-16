from stellar_sdk import Keypair, TransactionBuilder, Network, Asset, ChangeTrust, PathPaymentStrictSend, PathPaymentStrictReceive, TransactionEnvelope
from stellar_sdk.call_builder.call_builder_async import AccountsCallBuilder as AsyncAccountsCallBuilder
from stellar_sdk.call_builder.call_builder_async import TransactionsCallBuilder as AsyncTransactionsCallBuilder
from stellar_sdk.call_builder.call_builder_async import LedgersCallBuilder as AsyncLedgersCallBuilder
from stellar_sdk import Account
from stellar_sdk.client.aiohttp_client import AiohttpClient
from stellar_sdk.client.response import Response as StellarResponse
import aiohttp
import asyncio
import time
import logging

TESTNET = Network.PUBLIC_NETWORK_PASSPHRASE
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

logger.info("Loaded core/stellar.py")

async def load_public_key(self, telegram_id):
    async with self.db_pool_nitro.acquire() as conn:
        row = await conn.fetchrow("SELECT public_key FROM users WHERE telegram_id = $1", telegram_id)
        if not row:
            raise ValueError(f"No user found for telegram_id {telegram_id}")
        return row['public_key']

def parse_asset(asset_data):
    if isinstance(asset_data, dict):
        asset_type = asset_data.get("type", asset_data.get("asset_type"))
        if asset_type == "native":
            return Asset.native()
        return Asset(asset_data.get("code", asset_data.get("asset_code")),
                     asset_data.get("issuer", asset_data.get("asset_issuer")))
    return None

async def has_trustline(account, asset):
    if isinstance(account, dict):
        balances = account.get("balances", [])
    else:
        balances = account.raw_data.get("balances", [])
    for balance in balances:
        if asset.is_native() and balance["asset_type"] == "native":
            return True
        elif (balance["asset_type"] != "native" and
              balance["asset_code"] == asset.code and
              balance["asset_issuer"] == asset.issuer):
            return True
    return False

async def load_account_async(public_key, app_context):
    builder = AsyncAccountsCallBuilder(horizon_url=app_context.horizon_url, client=app_context.client).account_id(public_key)
    return await builder.call()

async def get_recommended_fee(app_context):
    try:
        ledger_builder = AsyncLedgersCallBuilder(horizon_url=app_context.horizon_url, client=app_context.client).order("desc").limit(1)
        ledger = await ledger_builder.call()
        latest_ledger = ledger["_embedded"]["records"][0]["sequence"]
        tx_builder = AsyncTransactionsCallBuilder(horizon_url=app_context.horizon_url, client=app_context.client).for_ledger(latest_ledger)
        transactions = await tx_builder.call()
        fees = [int(tx["max_fee"]) for tx in transactions["_embedded"]["records"]]
        if not fees:
            return 10000
        fees.sort()
        mid = len(fees) // 2
        return (fees[mid] + fees[mid - 1]) // 2 if len(fees) % 2 == 0 else fees[mid]
    except Exception as e:
        logger.error(f"Failed to fetch recommended fee: {str(e)}", exc_info=True)
        return 10000

async def build_and_submit_transaction(telegram_id, db_pool, operations, app_context, memo=None, base_fee=None):
    """Build and submit a transaction using the enclave for signing."""
    public_key = await app_context.load_public_key(telegram_id)
    account_data = await load_account_async(public_key, app_context)
    sequence = int(account_data["sequence"])
    account = Account(account=public_key, sequence=sequence)
    
    if base_fee is None:
        recommended_fee = await get_recommended_fee(app_context)
        base_fee = max(recommended_fee, 200 * len(operations))
    logger.info(f"Using base fee: {base_fee} stroops for {len(operations)} operations")
    
    tx_builder = TransactionBuilder(
        source_account=account,
        network_passphrase=TESTNET,
        base_fee=base_fee
    ).add_time_bounds(0, int(time.time()) + 900)
    
    for op in operations:
        tx_builder.append_operation(op)
    if memo:
        tx_builder.add_text_memo(memo)
    
    tx = tx_builder.build()
    xdr = tx.to_xdr()
    
    # Send to enclave for signing
    signed_xdr = await app_context.sign_transaction(telegram_id, xdr)
    tx_envelope = TransactionEnvelope.from_xdr(signed_xdr, TESTNET)
    
    url = f"{app_context.horizon_url}/transactions_async"
    response = await app_context.client.post(url, data={"tx": signed_xdr})
    
    if isinstance(response, dict):
        response_dict = response
    elif isinstance(response, StellarResponse):
        response_dict = response.json()
    elif isinstance(response, aiohttp.ClientResponse):
        response_dict = await response.json()
    else:
        raise Exception(f"Unexpected response type from client.post: {type(response)}")
    
    if "tx_status" not in response_dict or response_dict.get("tx_status") == "ERROR":
        logger.error(f"Transaction submission failed: {response_dict}")
        raise Exception(f"Transaction failed: {response_dict.get('title', 'Unknown error')}, details: {response_dict.get('detail', 'No details')}")
    
    logger.info(f"Transaction submitted: {response_dict}")
    return response_dict, signed_xdr

async def wait_for_transaction_confirmation(tx_hash, app_context, max_attempts=30, interval=2):
    logger.info(f"Waiting for transaction confirmation: {tx_hash}")
    attempts = 0
    while attempts < max_attempts:
        try:
            builder = AsyncTransactionsCallBuilder(horizon_url=app_context.horizon_url, client=app_context.client).transaction(tx_hash)
            tx = await builder.call()
            if tx["successful"]:
                logger.info(f"Transaction {tx_hash} confirmed successfully")
                return tx
            elif "successful" in tx and not tx["successful"]:
                logger.error(f"Transaction {tx_hash} failed: {tx.get('result_codes', 'No details')}")
                raise ValueError(f"Transaction {tx_hash} failed")
        except Exception as e:
            if "not_found" in str(e).lower():
                await asyncio.sleep(interval)
                attempts += 1
            else:
                logger.error(f"Error checking transaction {tx_hash}: {str(e)}", exc_info=True)
                raise
    raise TimeoutError(f"Transaction {tx_hash} not confirmed after {max_attempts * interval} seconds")