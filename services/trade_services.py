import logging
import asyncio
import time
from decimal import Decimal
from stellar_sdk import Asset, PathPaymentStrictReceive, PathPaymentStrictSend, ChangeTrust, Keypair, Payment
from stellar_sdk.exceptions import NotFoundError
from stellar_sdk.call_builder.call_builder_async import LedgersCallBuilder as AsyncLedgersCallBuilder
from stellar_sdk.call_builder.call_builder_async import TransactionsCallBuilder as AsyncTransactionsCallBuilder
from stellar_sdk.call_builder.call_builder_async import OrderbookCallBuilder as AsyncOrderbookCallBuilder
from stellar_sdk.call_builder.call_builder_async.orderbook_call_builder import OrderbookCallBuilder
from stellar_sdk.call_builder.call_builder_async.strict_send_paths_call_builder import StrictSendPathsCallBuilder
from stellar_sdk.call_builder.call_builder_async.strict_receive_paths_call_builder import StrictReceivePathsCallBuilder
from core.stellar import build_and_submit_transaction, has_trustline, load_account_async, parse_asset, get_recommended_fee

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.DEBUG)

def calculate_available_xlm(account):
    xlm_balance = float(next((b["balance"] for b in account["balances"] if b["asset_type"] == "native"), "0"))
    selling_liabilities = float(next((b["selling_liabilities"] for b in account["balances"] if b["asset_type"] == "native"), "0"))
    subentry_count = account["subentry_count"]
    num_sponsoring = account.get("num_sponsoring", 0)
    num_sponsored = account.get("num_sponsored", 0)
    minimum_reserve = 2 + (subentry_count + num_sponsoring - num_sponsored) * 0.5
    available_xlm = xlm_balance - selling_liabilities - minimum_reserve
    return max(available_xlm, 0)

async def wait_for_transaction_confirmation(tx_hash, app_context, max_attempts=60, interval=1):
    attempts = 0
    while attempts < max_attempts:
        try:
            builder = AsyncTransactionsCallBuilder(horizon_url=app_context.horizon_url, client=app_context.client).transaction(tx_hash)
            tx = await builder.call()
            if tx["successful"]:
                logger.info(f"Transaction {tx_hash} confirmed successfully")
                return True
            elif "successful" in tx and not tx["successful"]:
                logger.error(f"Transaction {tx_hash} failed on the network")
                raise ValueError(f"Transaction {tx_hash} failed")
        except Exception as e:
            if "404" in str(e):
                await asyncio.sleep(interval)
                attempts += 1
            else:
                logger.error(f"Error checking transaction {tx_hash}: {str(e)}", exc_info=True)
                raise
    raise ValueError(f"Transaction {tx_hash} not confirmed after {max_attempts} attempts")

async def perform_buy(telegram_id, db_pool, asset_code, asset_issuer, amount, app_context):
    if not asset_issuer.startswith('G') or len(asset_issuer) != 56:
        raise ValueError(f"Invalid issuer: {asset_issuer}")
    
    logger.info(f"Asset code: {asset_code}")
    
    asset = parse_asset({"code": asset_code, "issuer": asset_issuer})
    if asset is None:
        raise ValueError(f"Failed to parse asset: {asset_code}:{asset_issuer}")
    native_asset = Asset.native()
    
    public_key = await app_context.load_public_key(telegram_id)
    account = await load_account_async(public_key, app_context)
    
    operations = []
    trustline_needed = not await has_trustline(account, asset)
    if trustline_needed:
        logger.info(f"Adding trustline for {asset_code}")
        operations.append(ChangeTrust(asset=asset, limit="1000000000.0"))
        try:
            response, xdr = await build_and_submit_transaction(telegram_id, db_pool, operations, app_context, memo="Add Trustline")
            await wait_for_transaction_confirmation(response["hash"], app_context)
            account = await load_account_async(public_key, app_context)
        except Exception as e:
            logger.error(f"Failed to add trustline: {str(e)}", exc_info=True)
            raise
    
    available_xlm = calculate_available_xlm(account)
    asset_balance = float(next((b["balance"] for b in account["balances"] if b.get("asset_code") == asset_code and b.get("asset_issuer") == asset_issuer), "0"))
    logger.info(f"User balance: {available_xlm} XLM (available), {asset_balance} {asset_code}")
    
    dest_amount = float(amount)
    
    builder = StrictReceivePathsCallBuilder(
        horizon_url=app_context.horizon_url,
        client=app_context.client,
        source=[native_asset],
        destination_asset=asset,
        destination_amount=str(dest_amount)
    ).limit(10)
    
    logger.info(f"Querying paths: {builder.horizon_url}/paths/strict-receive with params: {builder.params}")
    paths_response = await builder.call()
    logger.info(f"Paths response: {paths_response}")
    
    paths = paths_response.get("_embedded", {}).get("records", [])
    if not paths:
        raise ValueError(f"No paths found to buy {dest_amount} {asset_code} with XLM - insufficient liquidity")
    
    paths.sort(key=lambda p: (float(p["source_amount"]), len(p["path"])))
    
    selected_path = None
    for path in paths:
        min_source_amount = float(path["source_amount"])
        logger.info(f"Evaluating path with source amount: {min_source_amount} XLM (hops: {len(path['path'])})")
        
        path_assets = [native_asset] + [Asset(p["asset_code"], p["asset_issuer"]) for p in path["path"]] + [asset]
        liquidity_ok = True
        if path["path"]:  # Skip orderbook check for direct paths
            for i in range(len(path_assets) - 1):
                selling_asset = path_assets[i]
                buying_asset = path_assets[i + 1]
                order_book_builder = OrderbookCallBuilder(
                    horizon_url=app_context.horizon_url,
                    client=app_context.client,
                    selling=selling_asset,
                    buying=buying_asset
                ).limit(10)
                order_book = await order_book_builder.call()
                asks = order_book.get("asks", [])
                if not asks:
                    logger.warning(f"No asks found for {selling_asset.code} -> {buying_asset.code} in path")
                    liquidity_ok = False
                    break
                total_dest_amount = 0.0
                for ask in asks:
                    ask_price = float(ask["price"])
                    ask_amount = float(ask["amount"])
                    total_dest_amount += ask_amount
                if total_dest_amount < dest_amount:
                    logger.warning(f"Insufficient ask amount for {selling_asset.code} -> {buying_asset.code}: available {total_dest_amount}, required {dest_amount}")
                    liquidity_ok = False
                    break
        
        if liquidity_ok:
            selected_path = path
            break
    
    if not selected_path:
        raise ValueError(f"No viable path found to buy {dest_amount} {asset_code} with XLM - insufficient liquidity in all paths")
    
    min_source_amount = float(selected_path["source_amount"])
    logger.info(f"Selected path source amount: {min_source_amount} XLM (hops: {len(selected_path['path'])})")
    
    slippage = getattr(app_context, 'slippage', 0.05)
    if selected_path["path"]:
        slippage *= 2
    send_max = max(round(min_source_amount * (1 + slippage), 7), 0.0000001)
    
    fee = await calculate_fee_and_check_balance(app_context, telegram_id, native_asset, send_max, is_send_max=True)
    if send_max + fee > available_xlm:
        raise ValueError(f"Insufficient XLM: required {send_max + fee}, available {available_xlm}")
    
    operations = [
        PathPaymentStrictReceive(
            destination=public_key,
            send_asset=native_asset,
            send_max=str(send_max),
            dest_asset=asset,
            dest_amount=str(round(dest_amount, 7)),
            path=[Asset(p["asset_code"], p["asset_issuer"]) for p in selected_path["path"]]
        ),
        Payment(
            destination=app_context.fee_wallet,
            asset=Asset.native(),
            amount=str(fee)
        )
    ]
    
    logger.info(f"Buy {dest_amount} {asset_code} with send_max {send_max} XLM + fee {fee} XLM (PPSR, slippage {slippage*100}%)")
    try:
        base_fee = await get_recommended_fee(app_context)
        response, xdr = await build_and_submit_transaction(telegram_id, db_pool, operations, app_context, memo=f"Buy {asset_code}", base_fee=base_fee)
        await wait_for_transaction_confirmation(response["hash"], app_context)
        logger.info(f"Buy successful (PPSR): {response['hash']}")
        actual_xlm_spent = float(response.get('effects', {}).get('records', [{}])[0].get('amount', min_source_amount))
        return response, actual_xlm_spent, dest_amount
    except Exception as e:
        logger.error(f"PPSR failed: {str(e)}", exc_info=True)
        if "op_too_few_offers" in str(e) or "over_sendmax" in str(e):
            send_amount = send_max
            expected_asset = send_amount / (min_source_amount / dest_amount)
            dest_min = max(round(expected_asset * (1 - slippage), 7), 0.0000001)
            fee = await calculate_fee_and_check_balance(app_context, telegram_id, native_asset, send_amount)
            operations = [
                PathPaymentStrictSend(
                    destination=public_key,
                    send_asset=native_asset,
                    send_amount=str(send_amount),
                    dest_asset=asset,
                    dest_min=str(dest_min),
                    path=[Asset(p["asset_code"], p["asset_issuer"]) for p in selected_path["path"]]
                ),
                Payment(
                    destination=app_context.fee_wallet,
                    asset=Asset.native(),
                    amount=str(fee)
                )
            ]
            logger.info(f"Fallback to PPSS: Send {send_amount} XLM for min {dest_min} {asset_code} + fee {fee} XLM (slippage {slippage*100}%)")
            try:
                response, xdr = await build_and_submit_transaction(telegram_id, db_pool, operations, app_context, memo=f"Buy {asset_code} (PPSS)", base_fee=base_fee)
                await wait_for_transaction_confirmation(response["hash"], app_context)
                logger.info(f"Buy successful (PPSS): {response['hash']}")
                actual_asset_received = float(response.get('effects', {}).get('records', [{}])[0].get('amount', dest_amount))
                actual_xlm_spent = send_amount
                return response, actual_xlm_spent, actual_asset_received
            except Exception as e2:
                logger.error(f"PPSS failed: {str(e2)}", exc_info=True)
                raise ValueError(f"Buy failed (PPSR & PPSS)")
        raise

async def perform_sell(telegram_id, db_pool, asset_code, asset_issuer, amount, app_context):
    if not asset_issuer.startswith('G') or len(asset_issuer) != 56:
        raise ValueError(f"Invalid issuer: {asset_issuer}")
    
    logger.info(f"Asset code: {asset_code}")
    
    asset = parse_asset({"code": asset_code, "issuer": asset_issuer})
    if asset is None:
        raise ValueError(f"Invalid asset: {asset_code}:{asset_issuer}")
    native_asset = Asset.native()
    
    public_key = await app_context.load_public_key(telegram_id)
    account = await load_account_async(public_key, app_context)
    
    balance = float(next((b["balance"] for b in account["balances"] if b.get("asset_code") == asset_code and b.get("asset_issuer") == asset_issuer), "0"))
    available_xlm = calculate_available_xlm(account)
    logger.info(f"User balance: {available_xlm} XLM (available), {balance} {asset_code}")
    
    send_amount = min(float(amount), balance) if balance > 0 else 0
    if send_amount <= 0:
        raise ValueError(f"No {asset_code} available to sell")
    
    fee = await calculate_fee_and_check_balance(app_context, telegram_id, asset, send_amount)
    
    builder = StrictSendPathsCallBuilder(
        horizon_url=app_context.horizon_url,
        client=app_context.client,
        source_asset=asset,
        source_amount=str(Decimal(str(send_amount)).quantize(Decimal('0.0000001'))),
        destination=[native_asset]
    ).limit(10)
    
    logger.info(f"Querying paths: {builder.horizon_url}/paths/strict-send with params: {builder.params}")
    paths_response = await builder.call()
    logger.info(f"Paths response: {paths_response}")
    
    paths = paths_response.get("_embedded", {}).get("records", [])
    if not paths:
        raise ValueError(f"No paths found to sell {send_amount} {asset_code} for XLM - insufficient liquidity")
    
    paths.sort(key=lambda p: (-float(p["destination_amount"]), len(p["path"])))
    
    selected_path = None
    for path in paths:
        max_dest_amount = float(path["destination_amount"])
        logger.info(f"Evaluating path with destination amount: {max_dest_amount} XLM (hops: {len(path['path'])})")
        
        path_assets = [asset] + [Asset(p["asset_code"], p["asset_issuer"]) for p in path["path"]] + [native_asset]
        liquidity_ok = True
        if path["path"]:  # Skip orderbook check for direct paths
            for i in range(len(path_assets) - 1):
                selling_asset = path_assets[i]
                buying_asset = path_assets[i + 1]
                order_book_builder = OrderbookCallBuilder(
                    horizon_url=app_context.horizon_url,
                    client=app_context.client,
                    selling=selling_asset,
                    buying=buying_asset
                ).limit(10)
                order_book = await order_book_builder.call()
                bids = order_book.get("bids", [])
                if not bids:
                    logger.warning(f"No bids found for {selling_asset.code} -> {buying_asset.code} in path")
                    liquidity_ok = False
                    break
                total_source_amount = 0.0
                for bid in bids:
                    bid_price = float(bid["price"])
                    bid_amount = float(bid["amount"])
                    if bid_price == 0.0:
                        logger.warning(f"Invalid bid price (zero) for {selling_asset.code} -> {buying_asset.code}, skipping bid")
                        continue
                    source_amount = bid_amount / bid_price
                    total_source_amount += source_amount
                if total_source_amount < send_amount:
                    logger.warning(f"Insufficient bid amount for {selling_asset.code} -> {buying_asset.code}: available {total_source_amount}, required {send_amount}")
                    liquidity_ok = False
                    break
        
        if liquidity_ok:
            selected_path = path
            break
    
    if not selected_path:
        raise ValueError(f"No viable path found to sell {send_amount} {asset_code} for XLM - insufficient liquidity in all paths")
    
    max_dest_amount = float(selected_path["destination_amount"])
    logger.info(f"Selected path destination amount: {max_dest_amount} XLM (hops: {len(selected_path['path'])})")
    
    slippage = getattr(app_context, 'slippage', 0.05)
    if selected_path["path"]:
        slippage *= 2
    dest_min = max(round(max_dest_amount * (1 - slippage), 7), 0.0000001)
    logger.info(f"Expected to receive at least {dest_min} XLM for selling {send_amount} {asset_code}")
    
    operations = [
        PathPaymentStrictSend(
            destination=public_key,
            send_asset=asset,
            send_amount=str(round(send_amount, 7)),
            dest_asset=native_asset,
            dest_min=str(dest_min),
            path=[Asset(p["asset_code"], p["asset_issuer"]) for p in selected_path["path"]]
        ),
        Payment(
            destination=app_context.fee_wallet,
            asset=Asset.native(),
            amount=str(fee)
        )
    ]
    
    logger.info(f"Sell {send_amount} {asset_code} for min {dest_min} XLM + fee {fee} XLM (PPSS, slippage {slippage*100}%)")
    try:
        base_fee = await get_recommended_fee(app_context)
        response, xdr = await build_and_submit_transaction(telegram_id, db_pool, operations, app_context, memo=f"Sell {asset_code}", base_fee=base_fee)
        await wait_for_transaction_confirmation(response["hash"], app_context)
        logger.info(f"Sell successful (PPSS): {response['hash']}")
        actual_xlm_received = float(response.get('effects', {}).get('records', [{}])[0].get('amount', max_dest_amount))
        return response, actual_xlm_received, send_amount
    except Exception as e:
        logger.error(f"Sell failed: {str(e)}", exc_info=True)
        raise ValueError(f"Sell failed (PPSS)")

async def perform_withdraw(telegram_id, db_pool, asset, amount, destination, app_context):
    public_key = await app_context.load_public_key(telegram_id)
    account = await load_account_async(public_key, app_context)

    try:
        Keypair.from_public_key(destination)
    except:
        raise ValueError("Invalid destination address")

    fee = await get_recommended_fee(app_context) / 10000000
    if asset.is_native():
        current_xlm = float(next((b["balance"] for b in account["balances"] if b["asset_type"] == "native"), "0"))
        base_reserve = 2 + (account["subentry_count"] + account.get("num_sponsoring", 0) - account.get("num_sponsored", 0)) * 0.5
        max_withdrawable = current_xlm - base_reserve - fee
        if amount > max_withdrawable:
            raise ValueError(f"Insufficient XLM: maximum withdrawable is {max_withdrawable} XLM")
    else:
        asset_balance = float(next((b["balance"] for b in account["balances"] if b["asset_code"] == asset.code and b["asset_issuer"] == asset.issuer), "0"))
        if amount > asset_balance:
            raise ValueError(f"Insufficient {asset.code} balance: {asset_balance}")
        available_xlm = calculate_available_xlm(account)
        if available_xlm < fee:
            raise ValueError("Insufficient XLM for transaction fee")

    operations = [Payment(
        destination=destination,
        asset=asset,
        amount=str(round(amount, 7))
    )]

    response, xdr = await build_and_submit_transaction(telegram_id, db_pool, operations, app_context, memo="Withdrawal")
    await wait_for_transaction_confirmation(response["hash"], app_context)
    return response

async def get_estimated_xlm_value(asset, amount, app_context):
    if asset.is_native():
        return amount
    try:
        # Convert amount to Decimal for precise formatting
        amount_decimal = Decimal(str(amount)).quantize(Decimal('0.0000001'))
        # Format as fixed-point string to avoid scientific notation (e.g., "0.0000005", not "5e-07")
        amount_str = format(amount_decimal, 'f')
        builder = StrictSendPathsCallBuilder(
            horizon_url=app_context.horizon_url,
            client=app_context.client,
            source_asset=asset,
            source_amount=amount_str,
            destination=[Asset.native()]
        ).limit(1)
        paths_response = await builder.call()
        paths = paths_response.get("_embedded", {}).get("records", [])
        if paths:
            best_path = paths[0]
            return float(best_path["destination_amount"])
        else:
            logger.warning(f"No paths found for {asset.code}:{asset.issuer} to XLM. Using default fee estimation.")
            return 0.0  # Fallback to avoid blocking; fee will be minimal
    except Exception as e:
        logger.error(f"Error fetching paths for {asset.code}:{asset.issuer}: {str(e)}", exc_info=True)
        return 0.0  # Fallback to avoid blocking

async def calculate_fee_and_check_balance(app_context, telegram_id, send_asset, send_amount, is_send_max=False):
    public_key = await app_context.load_public_key(telegram_id) if telegram_id else app_context.fee_wallet
    account = await load_account_async(public_key, app_context)
    
    if send_asset.is_native():
        fee = round(0.01 * send_amount, 7)
    else:
        estimated_xlm = await get_estimated_xlm_value(send_asset, send_amount, app_context)
        fee = round(0.01 * estimated_xlm, 7)
    
    available_xlm = calculate_available_xlm(account)
    total_required = send_amount + fee if send_asset.is_native() and is_send_max else fee
    
    if available_xlm < total_required:
        raise ValueError(f"Insufficient XLM: required {total_required}, available {available_xlm}")
    
    return fee

async def perform_add_trustline(telegram_id, db_pool, asset_code, asset_issuer, app_context):
    asset = parse_asset({"code": asset_code, "issuer": asset_issuer})
    if asset is None:
        raise ValueError(f"Invalid asset: {asset_code}:{asset_issuer}")
    
    public_key = await app_context.load_public_key(telegram_id)
    account = await load_account_async(public_key, app_context)
    
    if await has_trustline(account, asset):
        raise ValueError(f"Trustline already exists for {asset_code}:{asset_issuer}")
    
    available_xlm = calculate_available_xlm(account)
    fee = await get_recommended_fee(app_context) / 10000000
    if available_xlm < fee + 0.5:
        raise ValueError(f"Insufficient XLM for trustline: need {fee + 0.5}, available {available_xlm}")
    
    operations = [ChangeTrust(asset=asset, limit="1000000000.0")]
    
    response, xdr = await build_and_submit_transaction(
        telegram_id, db_pool, operations, app_context, memo=f"Add Trust {asset_code}"
    )
    await wait_for_transaction_confirmation(response["hash"], app_context)
    return response

async def perform_remove_trustline(telegram_id, db_pool, asset_code, asset_issuer, app_context):
    asset = parse_asset({"code": asset_code, "issuer": asset_issuer})
    if asset is None:
        raise ValueError(f"Invalid asset: {asset_code}:{asset_issuer}")
    
    public_key = await app_context.load_public_key(telegram_id)
    account = await load_account_async(public_key, app_context)
    
    if not await has_trustline(account, asset):
        raise ValueError(f"No trustline exists for {asset_code}:{asset_issuer}")
    
    asset_balance = float(next(
        (b["balance"] for b in account["balances"] if b.get("asset_code") == asset_code and b.get("asset_issuer") == asset_issuer),
        "0"
    ))
    if asset_balance > 0:
        raise ValueError(f"Cannot remove trustline: {asset_balance} {asset_code} remaining")
    
    available_xlm = calculate_available_xlm(account)
    fee = await get_recommended_fee(app_context) / 10000000
    if available_xlm < fee:
        raise ValueError(f"Insufficient XLM for transaction fee: need {fee}, available {available_xlm}")
    
    operations = [ChangeTrust(asset=asset, limit="0")]
    
    response, xdr = await build_and_submit_transaction(
        telegram_id, db_pool, operations, app_context, memo=f"Remove Trust {asset_code}"
    )
    await wait_for_transaction_confirmation(response["hash"], app_context)
    return response