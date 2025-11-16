import asyncio
import logging
from types import SimpleNamespace

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from .config import load_config
from .logging_setup import setup_logging
from .cli import cmd_discover, cmd_snapshot, cmd_payout


logger = logging.getLogger(__name__)


async def job_daily_discover_and_snapshot() -> None:
    cfg = load_config()
    logger.info("Starting daily discover + snapshot job")
    await cmd_discover(SimpleNamespace(rebuild=False))
    max_pools = getattr(cfg, "snapshot_concurrency", 2)
    await cmd_snapshot(SimpleNamespace(pool_id=None, max_pools=max_pools))
    logger.info("Finished daily discover + snapshot job")


async def job_hourly_payouts() -> None:
    logger.info("Starting hourly payout job")
    await cmd_payout(SimpleNamespace(dry_run=False))
    logger.info("Finished hourly payout job")


async def run_scheduler_async() -> None:
    setup_logging()
    _cfg = load_config()
    scheduler = AsyncIOScheduler(timezone="UTC")

    scheduler.add_job(
        job_daily_discover_and_snapshot,
        CronTrigger(hour=0, minute=10),
        name="daily_discover_snapshot",
        misfire_grace_time=3600,
    )
    scheduler.add_job(
        job_hourly_payouts,
        CronTrigger(minute=0),
        name="hourly_payouts",
        misfire_grace_time=1800,
    )

    scheduler.start()
    logger.info("Scheduler started (UTC). Press Ctrl+C to exit.")
    try:
        while True:
            await asyncio.sleep(3600)
    except (KeyboardInterrupt, asyncio.CancelledError):
        logger.info("Scheduler stopping...")
        scheduler.shutdown(wait=False)


