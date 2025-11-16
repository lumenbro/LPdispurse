from typing import Dict, List, Optional
import aiohttp
import logging


logger = logging.getLogger(__name__)


class HorizonClient:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")

    async def list_liquidity_pools(
        self,
        limit: int = 200,
        cursor: str | None = None,
        order: str = "asc",
        session: aiohttp.ClientSession | None = None,
    ) -> dict:
        params = {"limit": str(limit), "order": order}
        if cursor:
            params["cursor"] = cursor
        url = f"{self.base_url}/liquidity_pools"
        if session is None:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=40)) as _session:
                async with _session.get(url, params=params) as resp:
                    resp.raise_for_status()
                    return await resp.json()
        else:
            async with session.get(url, params=params) as resp:
                resp.raise_for_status()
                return await resp.json()

    async def get_liquidity_pools_by_reserves(
        self,
        reserve_a: Dict[str, str],
        reserve_b: Dict[str, str],
        limit: int = 200,
    ) -> List[dict]:
        params = {}
        # reserve_a
        params["reserve_a_asset_type"] = reserve_a["type"]
        if reserve_a["type"] != "native":
            params["reserve_a_asset_code"] = reserve_a["code"]
            params["reserve_a_asset_issuer"] = reserve_a["issuer"]
        # reserve_b
        params["reserve_b_asset_type"] = reserve_b["type"]
        if reserve_b["type"] != "native":
            params["reserve_b_asset_code"] = reserve_b["code"]
            params["reserve_b_asset_issuer"] = reserve_b["issuer"]

        params["limit"] = str(limit)
        url = f"{self.base_url}/liquidity_pools"
        async with aiohttp.ClientSession() as session:
            async with session.get(url, params=params, timeout=30) as resp:
                resp.raise_for_status()
                data = await resp.json()
                records = data.get("_embedded", {}).get("records", [])
                logger.info("Horizon returned %d pools for reserves", len(records))
                return records


