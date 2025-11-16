import os
from dataclasses import dataclass
from pathlib import Path
from dotenv import load_dotenv


@dataclass
class AppConfig:
    horizon_url: str
    network_passphrase: str
    lmnr_code: str
    lmnr_issuer: str
    max_discovery_pages: int
    snapshot_concurrency: int
    snapshot_pool_pause_seconds: float
    snapshot_page_limit: int
    snapshot_request_delay_seconds: float
    snapshot_min_retry_after_seconds: float
    max_ops_per_tx: int
    submit_sleep_seconds: float
    max_submit_retries: int
    retry_backoff_seconds: float
    confirm_mode: bool
    disbursement_public: str
    disbursement_secret: str | None
    data_dir: Path
    batch_size: int
    dry_run: bool
    network_label: str


def load_config() -> AppConfig:
    load_dotenv(override=True)

    data_dir = Path(os.getenv("DATA_DIR", "data")).resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "participants").mkdir(parents=True, exist_ok=True)
    (data_dir / "payout_ledger").mkdir(parents=True, exist_ok=True)

    network_label = os.getenv("STELLAR_NETWORK", "public").lower()
    if network_label == "public":
        horizon_url = os.getenv("HORIZON_URL", "https://horizon.stellar.org")
        network_passphrase = os.getenv("NETWORK_PASSPHRASE", "Public Global Stellar Network ; September 2015")
    else:
        horizon_url = os.getenv("HORIZON_URL", "https://horizon-testnet.stellar.org")
        network_passphrase = os.getenv("NETWORK_PASSPHRASE", "Test SDF Network ; September 2015")

    return AppConfig(
        horizon_url=horizon_url,
        network_passphrase=network_passphrase,
        lmnr_code=os.getenv("LMNR_CODE", "LMNR"),
        lmnr_issuer=os.getenv("LMNR_ISSUER", "GALUVE2YREE6NU4T2746XL7XORCEY5NVDJ7WADGWANUZWQJZ3PTP5PHB"),
        max_discovery_pages=int(os.getenv("MAX_DISCOVERY_PAGES", "100")),
        snapshot_concurrency=int(os.getenv("SNAPSHOT_CONCURRENCY", "2")),
        snapshot_pool_pause_seconds=float(os.getenv("SNAPSHOT_POOL_PAUSE_SECONDS", "1.0")),
        snapshot_page_limit=int(os.getenv("SNAPSHOT_PAGE_LIMIT", "50")),
        snapshot_request_delay_seconds=float(os.getenv("SNAPSHOT_REQUEST_DELAY_SECONDS", "0.5")),
        snapshot_min_retry_after_seconds=float(os.getenv("SNAPSHOT_MIN_RETRY_AFTER_SECONDS", "5.0")),
        max_ops_per_tx=int(os.getenv("MAX_OPS_PER_TX", "100")),
        submit_sleep_seconds=float(os.getenv("SUBMIT_SLEEP_SECONDS", "2")),
        max_submit_retries=int(os.getenv("MAX_SUBMIT_RETRIES", "5")),
        retry_backoff_seconds=float(os.getenv("RETRY_BACKOFF_SECONDS", "2")),
        confirm_mode=os.getenv("CONFIRM_MODE", "false").lower() in ("1", "true", "yes"),
        disbursement_public=os.getenv("DISBURSEMENT_PUBLIC", ""),
        disbursement_secret=os.getenv("DISBURSEMENT_SECRET"),
        data_dir=data_dir,
        batch_size=int(os.getenv("BATCH_SIZE", "100")),
        dry_run=os.getenv("DRY_RUN", "false").lower() in ("1", "true", "yes"),
        network_label=network_label,
    )


