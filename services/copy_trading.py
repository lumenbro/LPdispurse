import asyncio
import aiohttp
from decimal import Decimal
from stellar_sdk import Asset, PathPaymentStrictSend, PathPaymentStrictReceive, Payment, ChangeTrust
from stellar_sdk.call_builder.call_builder_async import OperationsCallBuilder as AsyncOperationsCallBuilder
from stellar_sdk.call_builder.call_builder_async import EffectsCallBuilder as AsyncEffectsCallBuilder
from stellar_sdk.call_builder.call_builder_async import StrictSendPathsCallBuilder
import logging
from core.stellar import build_and_submit_transaction, has_trustline, load_account_async, parse_asset
from services.trade_services import wait_for_transaction_confirmation, calculate_fee_and_check_balance
from services.referrals import log_xlm_volume, calculate_referral_shares

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

async def get_xlm_equivalent(app_context, asset, amount):
    if asset.is_native():
        return amount
    try:
        builder = StrictSendPathsCallBuilder(
            horizon_url=app_context.horizon_url,
            client=app_context.client,
            source_asset=asset,
            source_amount=str(Decimal(str(amount)).quantize(Decimal('0.0000001'))),
            destination=[Asset.native()]
        ).limit(1)
        paths_response = await builder.call()
        paths = paths_response.get("_embedded", {}).get("records", [])
        if paths:
            return float(paths[0]["destination_amount"])
        else:
            logger.warning(f"No paths found for {asset.code}:{asset.issuer} to XLM. Assuming 0 XLM volume.")
            return 0.0
    except Exception as e:
        logger.warning(f"Error fetching paths for {asset.code}:{asset.issuer}: {str(e)}")
        return 0.0

async def process_trade_signal(wallet, tx, chat_id, telegram_id, app_context):
    if "successful" not in tx or not tx["successful"]:
        logger.info(f"Transaction {tx['hash']} not successful, skipping.")
        return
    
    operations_builder = AsyncOperationsCallBuilder(horizon_url=app_context.horizon_url, client=app_context.client).for_transaction(tx["hash"])
    operations_response = await operations_builder.call()
    operations = operations_response["_embedded"]["records"]
    logger.info(f"Operations for transaction {tx['hash']}: {operations}")
    
    for op in operations:
        logger.info(f"Processing operation: {op}")
        
        op_source = op.get("source_account", tx["source_account"])
        if op_source != wallet:
            logger.info(f"Operation source {op_source} does not match wallet {wallet}, skipping.")
            continue
        
        account_dict = await load_account_async(await app_context.load_public_key(telegram_id), app_context)
        
        async with app_context.db_pool_copytrading.acquire() as conn:
            user_data = await conn.fetchrow(
                "SELECT multiplier, fixed_amount, slippage FROM copy_trading WHERE user_id = $1 AND wallet_address = $2",
                telegram_id, wallet
            )
        if not user_data:
            logger.error(f"No user data for user_id {telegram_id} and wallet {wallet}")
            return
        multiplier = float(user_data['multiplier'])
        fixed_amount = float(user_data['fixed_amount']) if user_data['fixed_amount'] is not None else None
        slippage = float(user_data['slippage'])
        logger.info(f"Slippage: {slippage}, Multiplier: {multiplier}, Fixed Amount: {fixed_amount}")
        
        operations_to_submit = []
        send_asset_code = "Unknown"
        dest_asset_code = "Unknown"
        original_send_amount = 0.0
        original_dest_min = 0.0
        original_received = 0.0
        send_amount_final = None
        dest_min_final = None
        send_max_final = None
        dest_amount_final = None
        
        if op["type"] == "path_payment_strict_send":
            send_asset = parse_asset({"asset_type": op["source_asset_type"], "asset_code": op.get("source_asset_code"), "asset_issuer": op.get("source_asset_issuer")})
            dest_asset = parse_asset({"asset_type": op["asset_type"], "asset_code": op.get("asset_code"), "asset_issuer": op.get("asset_issuer")})
            send_asset_code = "XLM" if send_asset.is_native() else send_asset.code
            dest_asset_code = "XLM" if dest_asset.is_native() else dest_asset.code
            
            original_send_amount = float(op["source_amount"])
            original_dest_min = float(op["destination_min"])
            original_received = float(op["amount"])
            path = [parse_asset(p) for p in op.get("path", [])]
            logger.info(f"PathPaymentStrictSend: send {original_send_amount} {send_asset_code}, receive at least {original_dest_min} {dest_asset_code}")
            
            send_amount = fixed_amount if fixed_amount is not None else original_send_amount * multiplier
            send_amount_final = round(send_amount, 7)
            scaled_dest_min = original_dest_min * multiplier  # Corrected: Use original_dest_min
            # Ensure scaled_dest_min is at least 1 stroop (0.0000001)
            scaled_dest_min = max(scaled_dest_min, 0.0000001)
            balance = float(next((b["balance"] for b in account_dict["balances"] if b.get("asset_type") == ("native" if send_asset.is_native() else "credit_alphanum4") and (send_asset.is_native() or (b["asset_code"] == send_asset.code and b["asset_issuer"] == send_asset.issuer))), "0"))
            
            if balance < send_amount_final:
                logger.warning(f"Insufficient {send_asset_code} balance ({balance} < {send_amount_final}). Using max: {balance}")
                send_amount_final = round(balance, 7)
                if send_amount_final <= 0:
                    raise ValueError(f"No {send_asset_code} available to trade")
                dest_min_final = round(scaled_dest_min * (send_amount_final / original_send_amount) * (1 - slippage), 7)
                min_acceptable = scaled_dest_min * (send_amount_final / original_send_amount) * 0.75
                dest_min_final = max(dest_min_final, round(min_acceptable, 7))
            else:
                dest_min_final = round(scaled_dest_min * (send_amount_final / original_send_amount) * (1 - slippage), 7)
                min_acceptable = scaled_dest_min * (send_amount_final / original_send_amount) * 0.75
                dest_min_final = max(dest_min_final, round(min_acceptable, 7))
            
            fee = await calculate_fee_and_check_balance(app_context, None, send_asset, send_amount_final)  # No keypair needed
            for asset in [send_asset, dest_asset]:
                if not await has_trustline(account_dict, asset):
                    logger.info(f"Adding trustline for {asset.code}")
                    operations_to_submit.append(ChangeTrust(asset=asset, limit="1000000000.0"))
                    account_dict = await load_account_async(await app_context.load_public_key(telegram_id), app_context)
            operations_to_submit.extend([
                PathPaymentStrictSend(
                    destination=await app_context.load_public_key(telegram_id),
                    send_asset=send_asset,
                    send_amount=str(send_amount_final),
                    dest_asset=dest_asset,
                    dest_min=str(dest_min_final),
                    path=path
                ),
                Payment(
                    destination=app_context.fee_wallet,
                    asset=Asset.native(),
                    amount=str(fee)
                )
            ])
            memo_text = f"Copy {wallet[-5:]} PPSend"
        
        elif op["type"] == "path_payment_strict_receive":
            send_asset = parse_asset({"asset_type": op["source_asset_type"], "asset_code": op.get("source_asset_code"), "asset_issuer": op.get("source_asset_issuer")})
            dest_asset = parse_asset({"asset_type": op["asset_type"], "asset_code": op.get("asset_code"), "asset_issuer": op.get("asset_issuer")})
            send_asset_code = "XLM" if send_asset.is_native() else send_asset.code
            dest_asset_code = "XLM" if dest_asset.is_native() else dest_asset.code
            
            original_send_max = float(op["source_max"])
            original_dest_amount = float(op["amount"])
            original_received = original_dest_amount
            path = [parse_asset(p) for p in op.get("path", [])]
            logger.info(f"PathPaymentStrictReceive: receive {original_dest_amount} {dest_asset_code}, send max {original_send_max} {send_asset_code}")
            
            dest_amount = fixed_amount if fixed_amount is not None else original_dest_amount * multiplier
            dest_amount_final = round(dest_amount, 7)
            send_max_final = round(original_send_max * (dest_amount_final / original_dest_amount) * (1 + slippage), 7)
            balance = float(next((b["balance"] for b in account_dict["balances"] if b.get("asset_type") == ("native" if send_asset.is_native() else "credit_alphanum4") and (send_asset.is_native() or (b["asset_code"] == send_asset.code and b["asset_issuer"] == send_asset.issuer))), "0"))
            
            if balance < send_max_final:
                logger.warning(f"Insufficient {send_asset_code} balance ({balance} < {send_max_final}). Adjusting to max: {balance}")
                send_max_final = round(balance, 7)
                if send_max_final <= 0:
                    raise ValueError(f"No {send_asset_code} available to trade")
                dest_amount_final = round(dest_amount * (send_max_final / original_send_max), 7)
            
            fee = await calculate_fee_and_check_balance(app_context, None, send_asset, send_max_final)  # No keypair needed
            for asset in [send_asset, dest_asset]:
                if not await has_trustline(account_dict, asset):
                    logger.info(f"Adding trustline for {asset.code}")
                    operations_to_submit.append(ChangeTrust(asset=asset, limit="1000000000.0"))
                    account_dict = await load_account_async(await app_context.load_public_key(telegram_id), app_context)
            operations_to_submit.extend([
                PathPaymentStrictReceive(
                    destination=await app_context.load_public_key(telegram_id),
                    send_asset=send_asset,
                    send_max=str(send_max_final),
                    dest_asset=dest_asset,
                    dest_amount=str(dest_amount_final),
                    path=path
                ),
                Payment(
                    destination=app_context.fee_wallet,
                    asset=Asset.native(),
                    amount=str(fee)
                )
            ])
            memo_text = f"Copy {wallet[-5:]} PPReceive"
        
        else:
            logger.info(f"Operation type {op['type']} not supported for copying, skipping.")
            continue
        
        try:
            logger.info(f"Submitting: Send {send_amount_final or send_max_final} {send_asset_code} for target {dest_min_final or dest_amount_final} {dest_asset_code}, Service Fee: {fee} XLM")
            response, xdr = await build_and_submit_transaction(
                telegram_id,  # Use telegram_id instead of keypair
                app_context.db_pool_nitro,
                operations_to_submit,
                app_context,
                memo=memo_text,
                base_fee=None
            )
            await wait_for_transaction_confirmation(response["hash"], app_context)
            
            if send_amount_final is not None:
                xlm_volume = await get_xlm_equivalent(app_context, send_asset, send_amount_final)
            else:
                xlm_volume = await get_xlm_equivalent(app_context, send_asset, send_max_final)
            await log_xlm_volume(telegram_id, xlm_volume, response["hash"], app_context.db_pool_copytrading)
            
            async with app_context.db_pool_copytrading.acquire() as conn:
                has_referrer = await conn.fetchval(
                    "SELECT referrer_id FROM referrals WHERE referee_id = $1", telegram_id
                )
            fee = xlm_volume * (0.009 if has_referrer else 0.01)
            logger.info(f"Calculated referral fee for user {telegram_id}: {fee} XLM (XLM volume: {xlm_volume})")
            await calculate_referral_shares(app_context.db_pool_copytrading, telegram_id, fee)
            
            effects_builder = AsyncEffectsCallBuilder(horizon_url=app_context.horizon_url, client=app_context.client).for_transaction(response["hash"])
            effects_response = await effects_builder.call()
            received_amount = 0.0
            for effect in effects_response["_embedded"]["records"]:
                if effect["type"] == "account_credited" and (
                    (effect.get("asset_type") == "native" and dest_asset.is_native()) or
                    (effect.get("asset_code") == dest_asset.code and effect.get("asset_issuer") == dest_asset.issuer)
                ):
                    received_amount = float(effect["amount"])
                    break
            
            sent_amount = send_amount_final if send_amount_final is not None else send_max_final
            target_amount = dest_min_final if dest_min_final is not None else dest_amount_final
            network_fee = float(response.get("fee_charged", 100)) / 10000000
            service_fee = fee
            total_fee = service_fee + network_fee
        
            message = (
                f"Copied trade from {wallet[-5:]}\n"
                f"Original: Sent {original_send_amount or original_send_max} {send_asset_code}, for {original_dest_min or original_received} {dest_asset_code}\n"
                f"Copied: Sent {sent_amount} {send_asset_code}, Target: {target_amount} {dest_asset_code}\n"
                f"Received: {received_amount} {dest_asset_code}\n"
                f"Fee: {total_fee:.7f} XLM (Network: {network_fee:.7f} XLM, Service: {service_fee:.7f} XLM)\n"
                f"Tx: {response['hash']}\n"
            )
            await app_context.bot.send_message(chat_id, message)
        
        except Exception as e:
            error_msg = str(e) if str(e) else "Failed to submit transaction."
            logger.error(f"Error copying trade: {error_msg}", exc_info=True)
            await asyncio.wait_for(
                app_context.bot.send_message(chat_id, f"Error copying trade: {error_msg}. This may be due to low liquidity; consider increasing slippage tolerance."),
                timeout=5
            )
