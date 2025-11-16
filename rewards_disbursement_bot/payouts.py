from typing import List, Dict, Any, Tuple
import logging
import asyncio

from stellar_sdk import Asset, Keypair, TransactionEnvelope
from stellar_sdk.operation import Payment

from core.stellar import build_and_submit_transaction, wait_for_transaction_confirmation  # type: ignore


logger = logging.getLogger(__name__)


class AppContextAdapter:
    """
    Adapter matching the expectations of core.stellar.build_and_submit_transaction:
    - horizon_url
    - client (aiohttp-like)
    - load_public_key(telegram_id)
    - sign_transaction(telegram_id, xdr)

    For now, we assume DISBURSEMENT_PUBLIC/SECRET are loaded elsewhere and a signing
    path is provided. If a signing enclave isn't present, you can plug in direct
    signing here later.
    """

    def __init__(self, horizon_url, client, disbursement_public, signer, network_passphrase: str | None = None, disbursement_secret: str | None = None):
        self.horizon_url = horizon_url
        self.client = client
        self._public = disbursement_public
        self._signer = signer
        self._network_passphrase = network_passphrase
        self._secret = disbursement_secret

    async def load_public_key(self, _telegram_id):
        return self._public

    async def sign_transaction(self, _telegram_id, xdr: str) -> str:
        # Prefer injected signer callback if provided
        if self._signer:
            return await self._signer(xdr)
        # Fallback: sign locally with DISBURSEMENT_SECRET if available
        if not self._secret or not self._network_passphrase:
            raise RuntimeError("No signer configured. Provide signer callback or DISBURSEMENT_SECRET + network_passphrase.")
        kp = Keypair.from_secret(self._secret)
        envelope = TransactionEnvelope.from_xdr(xdr, self._network_passphrase)
        envelope.sign(kp)
        return envelope.to_xdr()


async def build_lmnr_payments(
    payouts: List[Dict[str, Any]],
    lmnr_code: str,
    lmnr_issuer: str,
) -> List[Payment]:
    asset = Asset(lmnr_code, lmnr_issuer)
    ops: List[Payment] = []
    for item in payouts:
        amount = item["hourly_amount_lmnr"]
        dest = item["account"]
        ops.append(Payment(destination=dest, asset=asset, amount=str(amount)))
    return ops


async def submit_batched_payments(
    app_context_adapter: AppContextAdapter,
    db_pool_nitro,
    payouts: List[Dict[str, Any]],
    lmnr_code: str,
    lmnr_issuer: str,
    batch_size: int,
    memo_text: str | None = None,
    max_ops_per_tx: int = 100,
    submit_sleep_seconds: float = 2.0,
    max_submit_retries: int = 5,
    retry_backoff_seconds: float = 2.0,
    confirm_mode: bool = False,
) -> List[Tuple[Dict[str, Any], Dict[str, Any]]]:
    """
    Returns list of tuples: (payout_item, submission_response)
    """
    results: List[Tuple[Dict[str, Any], Dict[str, Any]]] = []
    batch: List[Dict[str, Any]] = []

    # Respect per-tx max ops; batch_size is a higher-level logical batch size, but we will chunk by max_ops_per_tx
    for i, item in enumerate(payouts):
        batch.append(item)
        if len(batch) == batch_size or i == len(payouts) - 1:
            # chunk batch into tx-sized pieces
            start_index = 0
            while start_index < len(batch):
                chunk = batch[start_index:start_index + max_ops_per_tx]
                start_index += max_ops_per_tx

                ops = await build_lmnr_payments(chunk, lmnr_code, lmnr_issuer)

                # retry loop
                attempt = 0
                while True:
                    attempt += 1
                    try:
                        response, _signed = await build_and_submit_transaction(
                            telegram_id=0,
                            db_pool=db_pool_nitro,
                            operations=ops,
                            app_context=app_context_adapter,
                            memo=memo_text or "LP Rewards Hourly",
                        )
                        tx_hash = response.get("hash")
                        tx_status = response.get("tx_status")
                        for b in chunk:
                            results.append((b, response))
                        logger.info("Submitted tx chunk with %d ops (status=%s)", len(chunk), tx_status)

                        if confirm_mode and tx_hash:
                            try:
                                await wait_for_transaction_confirmation(tx_hash, app_context_adapter, max_attempts=30, interval=2)
                            except Exception as e:
                                logger.warning("Confirmation check failed for %s: %s", tx_hash, str(e))

                        # sleep between tx submissions to ease sequencing/fee pressure
                        await asyncio.sleep(submit_sleep_seconds)
                        break
                    except Exception as e:
                        # If Horizon instructs TRY_AGAIN_LATER it usually appears in response, but here we are in exception path. Retry regardless up to max attempts.
                        if attempt <= max_submit_retries:
                            delay = retry_backoff_seconds * attempt
                            logger.warning("Submit attempt %d failed (%s). Retrying in %.1fs", attempt, str(e), delay)
                            await asyncio.sleep(delay)
                            continue
                        logger.error("Batch submit failed permanently for %d ops: %s", len(chunk), str(e))
                        for b in chunk:
                            results.append((b, {"error": str(e)}))
                        break
            batch = []

    return results


