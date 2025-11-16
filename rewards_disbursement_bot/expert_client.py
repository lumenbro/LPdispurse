from typing import Dict, List, Optional, Tuple
import aiohttp
import logging
import asyncio
import random

from .config import load_config


logger = logging.getLogger(__name__)


class StellarExpertClient:
    def __init__(self, network_label: str = "public") -> None:
        self.network_label = network_label
        self.base_url = f"https://api.stellar.expert/explorer/{self.network_label}"

    async def get_pool_overview(self, pool_id: str) -> Dict:
        url = f"{self.base_url}/liquidity-pool/{pool_id}"
        headers = {"User-Agent": "photonbot-lp-rewards/1.0"}
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=40), headers=headers) as session:
            async with session.get(url) as resp:
                resp.raise_for_status()
                return await resp.json()

    async def get_pool_holders(
        self,
        pool_id: str,
        limit: int = 100,
        order: str = "desc",
    ) -> Tuple[List[Dict], Optional[str]]:
        url = f"{self.base_url}/liquidity-pool/{pool_id}/holders"
        params = {"filter": "asset-holders", "limit": str(limit), "order": order}
        headers = {"User-Agent": "photonbot-lp-rewards/1.0"}
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=40), headers=headers) as session:
            async with session.get(url, params=params) as resp:
                resp.raise_for_status()
                data = await resp.json()
                records = data.get("_embedded", {}).get("records", [])
                next_href = data.get("_links", {}).get("next", {}).get("href")
                return records, next_href

    async def get_pool_holders_paginated(self, pool_id: str) -> List[Dict]:
        headers = {"User-Agent": "photonbot-lp-rewards/1.0"}
        timeout = aiohttp.ClientTimeout(total=60)
        backoff = 1.0
        max_backoff = 10.0
        all_records: List[Dict] = []
        cfg = load_config()
        page_limit = max(1, int(getattr(cfg, "snapshot_page_limit", 50)))
        req_delay = max(0.0, float(getattr(cfg, "snapshot_request_delay_seconds", 0.5)))
        min_retry_after = max(0.0, float(getattr(cfg, "snapshot_min_retry_after_seconds", 5.0)))

        async with aiohttp.ClientSession(timeout=timeout, headers=headers) as session:
            # First page
            url = f"{self.base_url}/liquidity-pool/{pool_id}/holders"
            params = {"filter": "asset-holders", "limit": str(page_limit), "order": "desc"}
            next_href: Optional[str] = None
            while True:
                try:
                    # polite initial delay with jitter
                    if req_delay:
                        await asyncio.sleep(req_delay + random.uniform(0, req_delay))
                    logger.info("Expert holders request (first page): pool=%s limit=%s order=desc", pool_id, page_limit)
                    async with session.get(url, params=params, timeout=timeout) as resp:
                        if resp.status == 429:
                            retry_after = resp.headers.get("Retry-After")
                            delay = float(retry_after) if retry_after else max(min_retry_after, backoff)
                            logger.warning("429 from Stellar Expert, sleeping %.2fs", delay)
                            await asyncio.sleep(delay)
                            backoff = min(max_backoff, backoff * 1.5)
                            continue
                        resp.raise_for_status()
                        data = await resp.json()
                        recs = data.get("_embedded", {}).get("records", [])
                        logger.info("Expert holders received %d records (first page)", len(recs))
                        all_records.extend(recs)
                        next_href = data.get("_links", {}).get("next", {}).get("href")
                        break
                except aiohttp.ClientResponseError as e:
                    if 500 <= e.status < 600:
                        logger.warning("Expert 5xx (%d), retrying in %.2fs", e.status, backoff)
                        await asyncio.sleep(backoff)
                        backoff = min(max_backoff, backoff * 1.5)
                        continue
                    raise

            # Subsequent pages
            last_href: Optional[str] = None
            while next_href:
                # guard against stuck pagination (same href repeating)
                if last_href == next_href:
                    logger.warning("Expert holders next href not advancing, stopping pagination: %s", next_href)
                    break
                absolute = f"https://api.stellar.expert{next_href}"
                while True:
                    try:
                        if req_delay:
                            await asyncio.sleep(req_delay + random.uniform(0, req_delay))
                        logger.info("Expert holders request (next): %s", absolute)
                        async with session.get(absolute, timeout=timeout) as resp:
                            if resp.status == 429:
                                retry_after = resp.headers.get("Retry-After")
                                delay = float(retry_after) if retry_after else max(min_retry_after, backoff)
                                logger.warning("429 from Stellar Expert (paged), sleeping %.2fs", delay)
                                await asyncio.sleep(delay)
                                backoff = min(max_backoff, backoff * 1.5)
                                continue
                            resp.raise_for_status()
                            data = await resp.json()
                            recs = data.get("_embedded", {}).get("records", [])
                            logger.info("Expert holders received %d records (page)", len(recs))
                            if not recs:
                                logger.info("No records on page; stopping pagination")
                                next_href = None
                                break
                            all_records.extend(recs)
                            new_next = data.get("_links", {}).get("next", {}).get("href")
                            if not new_next or new_next == next_href:
                                logger.info("Next href not present or unchanged; stopping pagination")
                                next_href = None
                                break
                            last_href = next_href
                            next_href = new_next
                            # extra tiny jitter after page
                            if req_delay:
                                await asyncio.sleep(random.uniform(0, req_delay))
                            break
                    except aiohttp.ClientResponseError as e:
                        if 500 <= e.status < 600:
                            logger.warning("Expert 5xx (%d) on page, retrying in %.2fs", e.status, backoff)
                            await asyncio.sleep(backoff)
                            backoff = min(max_backoff, backoff * 1.5)
                            continue
                        raise

        logger.info("Fetched %d holders for pool %s", len(all_records), pool_id)
        return all_records


