from typing import Dict, List, Tuple
import logging

from .horizon_client import HorizonClient
from .state import PoolsMap
from .config import load_config


logger = logging.getLogger(__name__)


def asset_native() -> Dict[str, str]:
    return {"type": "native"}


def asset(code: str, issuer: str) -> Dict[str, str]:
    asset_type = "credit_alphanum4" if len(code) <= 4 else "credit_alphanum12"
    return {"type": asset_type, "code": code, "issuer": issuer}


def reserve_label(code: str | None, issuer: str | None) -> str:
    if code is None:
        return "XLM"
    if issuer:
        return f"{code}:{issuer}"
    return code


async def discover_pools_for_lmnr(
        horizon: HorizonClient,
        lmnr_code: str,
        lmnr_issuer: str,
        pools_map: PoolsMap,
        rebuild: bool = False,
) -> Dict[str, str]:
    """
    Enumerate liquidity pools and filter those that include LMNR, mapping
    '<OTHER>-LMNR' (and reverse) to pool id. OTHER will be 'XLM' for native,
    or 'CODE:ISSUER' for credit assets to avoid ambiguity across issuers.
    """
    existing = pools_map.load()
    updated = {} if rebuild else dict(existing)

    cursor = None
    total_seen = 0
    page = 0
    cfg = load_config()
    max_pages = max(1, int(getattr(cfg, "max_discovery_pages", 100)))

    import aiohttp
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=40)) as session:
        while True:
            page += 1
            data = await horizon.list_liquidity_pools(limit=200, cursor=cursor, order="asc", session=session)
            records = data.get("_embedded", {}).get("records", [])
            total_seen += len(records)
            logger.info("Discovery scanning page %d, %d records (total seen %d)", page, len(records), total_seen)
            for rec in records:
                pool_id = rec.get("id")
                reserves = rec.get("reserves", [])
                if not pool_id or len(reserves) != 2:
                    continue
                # Identify if this pool contains LMNR based on 'asset' string ("native" or "CODE:ISSUER")
                r0, r1 = reserves[0], reserves[1]

                def asset_str(r: dict) -> str | None:
                    if "asset" in r and r["asset"]:
                        return r["asset"]
                    # fallback to older/hybrid representations
                    a_type = r.get("asset_type")
                    if a_type == "native":
                        return "native"
                    code = r.get("asset_code")
                    issuer = r.get("asset_issuer")
                    if code and issuer:
                        return f"{code}:{issuer}"
                    return None

                a0 = asset_str(r0)
                a1 = asset_str(r1)
                lmnr_key = f"{lmnr_code}:{lmnr_issuer}"

                if a0 == lmnr_key:
                    other_asset = a1
                elif a1 == lmnr_key:
                    other_asset = a0
                else:
                    continue

                # Build labels for mapping
                if other_asset == "native":
                    other_label = "XLM"
                else:
                    other_label = other_asset  # already CODE:ISSUER

                label = f"{other_label}-{lmnr_code}"
                rev = f"{lmnr_code}-{other_label}"
                # Always set/overwrite to ensure stale IDs are corrected
                prev = updated.get(label)
                if prev != pool_id:
                    updated[label] = pool_id
                prev_rev = updated.get(rev)
                if prev_rev != pool_id:
                    updated[rev] = pool_id

            # pagination
            next_href = data.get("_links", {}).get("next", {}).get("href")
            if not next_href or "cursor=" not in next_href:
                break
            cursor_val = next_href.split("cursor=", 1)[1]
            if "&" in cursor_val:
                cursor_val = cursor_val.split("&", 1)[0]
            cursor = cursor_val

            if page >= max_pages:
                logger.warning("Stopping discovery after %d pages (safety cap).", max_pages)
                break

    if updated != existing:
        pools_map.save(updated)
        logger.info("Updated pools map with %d entries (scanned %d pools)", len(updated), total_seen)
    else:
        logger.info("No new pools discovered (scanned %d pools)", total_seen)

    return updated


