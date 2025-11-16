import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Any, Optional


@dataclass
class PoolsMap:
    path: Path

    def load(self) -> Dict[str, str]:
        if not self.path.exists():
            return {}
        with self.path.open("r", encoding="utf-8") as f:
            return json.load(f)

    def save(self, mapping: Dict[str, str]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("w", encoding="utf-8") as f:
            json.dump(mapping, f, indent=2, sort_keys=True)


def participants_path(base_dir: Path, pool_id: str) -> Path:
    return base_dir / "participants" / f"{pool_id}.json"


def write_participants_snapshot(base_dir: Path, pool_id: str, payload: Dict[str, Any]) -> None:
    path = participants_path(base_dir, pool_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)


def read_participants_snapshot(base_dir: Path, pool_id: str) -> Optional[Dict[str, Any]]:
    path = participants_path(base_dir, pool_id)
    if not path.exists():
        return None
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def payout_ledger_dir(base_dir: Path, date_str: str) -> Path:
    d = base_dir / "payout_ledger" / date_str
    d.mkdir(parents=True, exist_ok=True)
    return d


def write_payout_record(base_dir: Path, date_str: str, pool_id: str, records: List[Dict[str, Any]]) -> Path:
    dir_path = payout_ledger_dir(base_dir, date_str)
    path = dir_path / f"{pool_id}.json"
    payload = {
        "pool_id": pool_id,
        "date": date_str,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "records": records,
    }
    with path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    return path


def iso_date_utc(dt: Optional[datetime] = None) -> str:
    if dt is None:
        dt = datetime.now(timezone.utc)
    return dt.strftime("%Y-%m-%d")


