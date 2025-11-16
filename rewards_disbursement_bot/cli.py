import asyncio
import json
import logging
from argparse import ArgumentParser
from pathlib import Path
from typing import Dict, Any, List

from stellar_sdk.client.aiohttp_client import AiohttpClient

from .config import load_config
from .logging_setup import setup_logging
from .horizon_client import HorizonClient
from .expert_client import StellarExpertClient
from .discovery import discover_pools_for_lmnr
from .participants import snapshot_participants_for_pool
from .state import PoolsMap, read_participants_snapshot, write_payout_record, iso_date_utc
from .calculator import compute_percentages_and_hourly


async def signer_noop(xdr: str) -> str:
    raise RuntimeError("Signing enclave not configured. Provide a signer implementation.")


async def cmd_discover(args) -> None:
    cfg = load_config()
    pools_map = PoolsMap(cfg.data_dir / "pools.json")
    horizon = HorizonClient(cfg.horizon_url)
    await discover_pools_for_lmnr(
        horizon,
        cfg.lmnr_code,
        cfg.lmnr_issuer,
        pools_map,
        rebuild=bool(getattr(args, "rebuild", False)),
    )


async def cmd_snapshot(args) -> None:
    cfg = load_config()
    pools_map = PoolsMap(cfg.data_dir / "pools.json")
    mapping = pools_map.load()
    if not mapping:
        print("No pools in pools.json. Run discover first.")
        return
    expert = StellarExpertClient(cfg.network_label)
    # Allow narrowing to a single pool via arg for testing
    target_pool_id = getattr(args, "pool_id", None)
    max_pools = getattr(args, "max_pools", None)
    items = mapping.items()
    if target_pool_id:
        items = [(k, v) for (k, v) in items if v == target_pool_id]
        if not items:
            print(f"Pool id {target_pool_id} not found in pools.json")
            return
    count = 0
    for label, pool_id in items:
        if max_pools and count >= int(max_pools):
            break
        try:
            print(f"Snapshotting {label} ({pool_id})...")
            await snapshot_participants_for_pool(expert, cfg.data_dir, pool_id)
            count += 1
            # polite pause between pools to avoid rate limits
            await asyncio.sleep(cfg.snapshot_pool_pause_seconds)
        except Exception as e:
            logging.error("Snapshot failed for %s (%s): %s", label, pool_id, str(e))
            # continue to next


async def cmd_payout(args) -> None:
    from .payouts import AppContextAdapter, submit_batched_payments
    cfg = load_config()
    pools_map = PoolsMap(cfg.data_dir / "pools.json")
    mapping = pools_map.load()
    if not mapping:
        print("No pools in pools.json. Run discover first.")
        return

    def human_readable_memo(label: str) -> str:
        # Convert "USDC:ISSUER-LMNR" -> "USDC LMNR LP"; keep only codes, drop issuers
        parts = label.split("-")
        codes = []
        for p in parts:
            code = p.split(":", 1)[0]
            codes.append(code)
        memo = " ".join(codes) + " LP"
        # Stellar text memo max 28 bytes
        return memo[:28]

    # Build app context adapter for transaction submission
    client = AiohttpClient()
    try:
        signer = None if cfg.disbursement_secret else signer_noop
        ctx = AppContextAdapter(
            cfg.horizon_url,
            client,
            cfg.disbursement_public,
            signer,
            network_passphrase=cfg.network_passphrase,
            disbursement_secret=cfg.disbursement_secret,
        )

        date_str = iso_date_utc()
        seen_pool_ids = set()
        for label, pool_id in mapping.items():
            # Avoid processing the same pool_id twice when multiple labels map to it
            if pool_id in seen_pool_ids:
                logging.info("Skipping duplicate pool_id already processed: %s (%s)", pool_id, label)
                continue
            seen_pool_ids.add(pool_id)
            snapshot = read_participants_snapshot(cfg.data_dir, pool_id)
            if not snapshot or not snapshot.get("records"):
                logging.warning("No snapshot for pool %s (%s), skip.", label, pool_id)
                continue
            payouts = compute_percentages_and_hourly(snapshot)
            memo_text = human_readable_memo(label)

            if args.dry_run or cfg.dry_run:
                preview = [
                    {"account": p["account"], "hourly_amount_lmnr": p["hourly_amount_lmnr"]}
                    for p in payouts[:10]
                ]
                print(f"[DRY-RUN] {label} ({pool_id}) first 10 payouts:", json.dumps(preview, indent=2))
                write_payout_record(cfg.data_dir, date_str, pool_id, payouts)
                continue

            # Placeholder db_pool for compatibility with core.stellar signature
            db_pool_nitro = None
            results = await submit_batched_payments(
                app_context_adapter=ctx,
                db_pool_nitro=db_pool_nitro,
                payouts=payouts,
                lmnr_code=cfg.lmnr_code,
                lmnr_issuer=cfg.lmnr_issuer,
                batch_size=cfg.batch_size,
                memo_text=memo_text,
                max_ops_per_tx=cfg.max_ops_per_tx,
                submit_sleep_seconds=cfg.submit_sleep_seconds,
                max_submit_retries=cfg.max_submit_retries,
                retry_backoff_seconds=cfg.retry_backoff_seconds,
                confirm_mode=cfg.confirm_mode,
            )
            # Persist payout ledger including tx responses
            records = []
            for p, resp in results:
                records.append(
                    {
                        "account": p["account"],
                        "hourly_amount_lmnr": p["hourly_amount_lmnr"],
                        "response": resp,
                    }
                )
            write_payout_record(cfg.data_dir, date_str, pool_id, records)
    finally:
        # ensure aiohttp client is closed to avoid warnings
        try:
            await client.close()
        except Exception:
            pass


def build_parser() -> ArgumentParser:
    parser = ArgumentParser(prog="rewards_disbursement_bot", description="LP Rewards Disbursement Bot")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_discover = sub.add_parser("discover")
    p_discover.add_argument("--rebuild", action="store_true", help="Rebuild pools.json from scratch")
    p_snapshot = sub.add_parser("snapshot")
    p_snapshot.add_argument("--pool-id", help="Snapshot only this pool id", default=None)
    p_snapshot.add_argument("--max-pools", help="Limit number of pools processed this run", default=None)
    p_payout = sub.add_parser("payout")
    p_payout.add_argument("--dry-run", action="store_true", default=False)
    sub.add_parser("run-scheduler")

    return parser


async def main_async() -> None:
    parser = build_parser()
    parser.add_argument("--verbose", action="store_true", help="Enable verbose debug logging")
    args = parser.parse_args()

    setup_logging(level=(logging.DEBUG if args.verbose else logging.INFO))
    if args.cmd == "discover":
        await cmd_discover(args)
    elif args.cmd == "snapshot":
        await cmd_snapshot(args)
    elif args.cmd == "payout":
        await cmd_payout(args)
    elif args.cmd == "run-scheduler":
        from .scheduler import run_scheduler_async
        await run_scheduler_async()


def main() -> None:
    asyncio.run(main_async())


if __name__ == "__main__":
    main()


