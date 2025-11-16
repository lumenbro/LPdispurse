from typing import Dict, List, Any
from datetime import datetime, timezone
import logging

from .expert_client import StellarExpertClient
from .state import write_participants_snapshot


logger = logging.getLogger(__name__)


async def snapshot_participants_for_pool(
    expert: StellarExpertClient,
    base_dir,
    pool_id: str,
) -> Dict[str, Any]:
    overview = await expert.get_pool_overview(pool_id)
    total_shares = overview.get("shares")
    holders = await expert.get_pool_holders_paginated(pool_id)

    payload = {
        "pool_id": pool_id,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "total_shares": str(total_shares) if total_shares is not None else None,
        "records": holders,
    }
    write_participants_snapshot(base_dir, pool_id, payload)
    logger.info("Wrote participants snapshot for %s with %d holders", pool_id, len(holders))
    return payload


