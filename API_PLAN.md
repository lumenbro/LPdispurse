Fetching a liquidity pool via Stellar Expert once pool ID is known, Use horizon endpoint to fetch pool id, details below.

Request URL
https://api.stellar.expert/explorer/public/liquidity-pool/f1d387f276e890ef31c85c6ab48dbd05d70e9e065fd293ec602cf2a4435425d2/holders?filter=asset-holders&limit=50&order=desc
Request Method
GET
Status Code
200 OK
Remote Address
[2606:4700:20::681a:e20]:443
Referrer Policy
no-referrerYes, the Stellar Expert API offers a more direct and efficient method to query liquidity pool participants (i.e., holders of pool shares) compared to processing operations via Horizon. While the official OpenAPI documentation at https://stellar.expert/openapi.html does not explicitly list liquidity pool endpoints (it focuses on assets, directory, and ledgers), the API supports an undocumented endpoint for this purpose, as evidenced by the successful GET request you provided.
Endpoint Details

URL Structure: https://api.stellar.expert/explorer/{network}/liquidity-pool/{pool_id}/holders
{network}: Use public for the mainnet (as in your example), or testnet for the test network.
{pool_id}: The hexadecimal ID of the liquidity pool (e.g., f1d387f276e890ef31c85c6ab48dbd05d70e9e065fd293ec602cf2a4435425d2).

Query Parameters:
filter=asset-holders: This appears required to retrieve holders treating the pool shares as an asset (since pool shares function like a synthetic asset in Stellar).
limit: Maximum number of records per page (e.g., 50; the API likely caps this at a reasonable value like 100 or 200, similar to other endpoints).
order: Sort order—use desc to get holders sorted by descending balance (largest holders first) or asc for ascending.
cursor: For pagination, set this to the paging_token of the last record from the previous response to fetch the next page.

Response Structure (JSON):
_links: Pagination links (self, prev, next with hrefs that include the cursor for easy navigation).
_embedded.records: An array of holder objects, each containing:
account: The Stellar account address (e.g., "GB35ZIXTWFVYZ64EXTW3ULQKIREF2L7OK72LMY4GRSUNHKTUWAGJ5IRK").
balance: The holder's share balance as a string (e.g., "13929139525"—this is the number of pool shares they hold).
paging_token: A base64-like string for pagination (e.g., "AAAAAz49zUUAnGkD").

No explicit total count of holders is provided; you'll need to paginate through all pages to get the full list if needed.


This endpoint provides pre-aggregated data on current share holders, avoiding the need to fetch and process the entire operation history like in Horizon. It's ideal for getting a sorted list of participants and their shares. For very large pools, implement pagination in your code to iterate through results.
If implementing in code, use an HTTP client (e.g., via Python's requests library) to make the GET request and handle pagination by following the _links.next.href until it's null.
For the specific pool in your example, the response includes holders with large balances first, such as one with over 190 billion shares. If you need details on other undocumented endpoints (like the "candles" for OHLC data), they might follow similar patterns—e.g., /liquidity-pool/{pool_id}/candles—but test them directly as the OpenAPI spec is incomplete.11 web pages585msSo the response looks like this, the issue would be fetching the pool id by human readable input somehow, like is there a way to pull the IDs first?
{
    "_links": {
        "self": {
            "href": "/explorer/public/liquidity-pool/f1d387f276e890ef31c85c6ab48dbd05d70e9e065fd293ec602cf2a4435425d2/holders?order=desc&limit=50"
        },
        "prev": {
            "href": "/explorer/public/liquidity-pool/f1d387f276e890ef31c85c6ab48dbd05d70e9e065fd293ec602cf2a4435425d2/holders?order=asc&limit=50&cursor=AAADF9eXPHwBGx2X"
        },
        "next": {
            "href": "/explorer/public/liquidity-pool/f1d387f276e890ef31c85c6ab48dbd05d70e9e065fd293ec602cf2a4435425d2/holders?order=desc&limit=50&cursor=AAAAAz49zUUAnGkD"
        }
    },
    "_embedded": {
        "records": [
            {
                "balance": "3400936143996",
                "account": "GBW67QYLJQEWWCA3XZFIK4BMHARIWEYLEVBJPSW6L7NUNM7YQ7TMKXUH",
                "paging_token": "AAADF9eXPHwBGx2X"
            },
            {
                "balance": "2044239858724",
                "account": "GCO2XO4SQLU7MNV3YIUN3MIORGMTIS6X3GPIU3CSIERMLEPJ5IG3RVX3",
                "paging_token": "AAAB2/YwzCQBGx2r"
            },
            {
                "balance": "190832911362",
                "account": "GDBXUUFIYNVGL7V7BATR7DLEPSGBT3REUMKWWCD4P3E6SU7HIFJAQ7UD",
                "paging_token": "AAAALG6HJAIBBOYr"
            },
            {
                "balance": "15929523395",
                "account": "GCBT4REH74AIHC67OD7MSL5UUCXNVFNRT6P4MFEFU2QW5D5FMRW4EK3S",
                "paging_token": "AAAAA7V5PMMAtGq2"
            },
            {
                "balance": "13929139525",
                "account": "GB35ZIXTWFVYZ64EXTW3ULQKIREF2L7OK72LMY4GRSUNHKTUWAGJ5IRK",
                "paging_token": "AAAAAz49zUUAnGkD"
            }
        ]
    }
}
 
Then somehow get a percentage of total?To fetch a liquidity pool ID using human-readable inputs (e.g., the asset pair like "XLM" and "ASSHAT:GBLAHGLKZIP62E6X5P5U7I3FWFLRPMRS64QOMFGOCYRS62BATNZANOGF" for your example pool), use the Horizon API's /liquidity_pools endpoint with query parameters specifying the reserves. This returns a list of matching pools (typically just one per unordered asset pair in Stellar's AMM design). Here's how:
Endpoint Details

URL Structure: https://horizon.stellar.org/liquidity_pools
Query Parameters (specify both reserves; order doesn't matter as "a" and "b"):
reserve_a_asset_type: Type of the first asset (native for XLM, credit_alphanum4 for 4-char codes, or credit_alphanum12 for 12-char codes).
reserve_a_asset_code: The asset code (e.g., XLM—omit for native; or ASSHAT).
reserve_a_asset_issuer: The issuer account (e.g., GBLAHGLKZIP62E6X5P5U7I3FWFLRPMRS64QOMFGOCYRS62BATNZANOGF; omit for native).
reserve_b_asset_type: Same as above for the second asset.
reserve_b_asset_code: Same as above.
reserve_b_asset_issuer: Same as above.
Additional params: limit (up to 200), order (asc or desc), cursor (for pagination if many results).

Response Structure (JSON): Includes _embedded.records with pool details like id (the hex ID you need), total_shares, reserves, etc. Extract the id from the first (or only) record.

Example request for your pool's assets (XLM native and ASSHAT from issuer GBLAHGLKZIP62E6X5P5U7I3FWFLRPMRS64QOMFGOCYRS62BATNZANOGF):
textGET https://horizon.stellar.org/liquidity_pools?reserve_a_asset_type=native&reserve_b_asset_type=credit_alphanum12&reserve_b_asset_code=ASSHAT&reserve_b_asset_issuer=GBLAHGLKZIP62E6X5P5U7I3FWFLRPMRS64QOMFGOCYRS62BATNZANOGF
This returns the pool with ID f1d387f276e890ef31c85c6ab48dbd05d70e9e065fd293ec602cf2a4435425d2. Use an SDK (e.g., JavaScript or Python Stellar SDK) for easier querying if implementing in code.
Stellar Expert doesn't have a documented API endpoint for this, but you can achieve similar by browsing their web interface (e.g., search for the asset pair on https://stellar.expert/explorer/public/markets) and extracting the pool ID from the page. However, Horizon is more reliable and direct for programmatic use.
Calculating Percentage of Total Shares
The Stellar Expert API provides pre-aggregated total_shares (or "shares" in their response) in the main liquidity pool endpoint, so you don't need to sum holders manually. Fetch it first, then compute percentages for holders.

Fetch Total Shares:
Endpoint: https://api.stellar.expert/explorer/public/liquidity-pool/{pool_id}
Response includes "shares": "5723825776612" (for your example; this is the total pool shares).

Fetch Holders (as before): Paginate through /liquidity-pool/{pool_id}/holders?filter=asset-holders&limit=50&order=desc to get all records if needed.
Compute Percentages (client-side):
For each holder: (balance / total_shares) * 100.
Example for your provided holders (using total_shares = 5723825776612):
GBW67QYLJQEWWCA3XZFIK4BMHARIWEYLEVBJPSW6L7NUNM7YQ7TMKXUH: (3400936143996 / 5723825776612) * 100 ≈ 59.43%
GCO2XO4SQLU7MNV3YIUN3MIORGMTIS6X3GPIU3CSIERMLEPJ5IG3RVX3: (2044239858724 / 5723825776612) * 100 ≈ 35.72%
GDBXUUFIYNVGL7V7BATR7DLEPSGBT3REUMKWWCD4P3E6SU7HIFJAQ7UD: (190832911362 / 5723825776612) * 100 ≈ 3.33%
GCBT4REH74AIHC67OD7MSL5UUCXNVFNRT6P4MFEFU2QW5D5FMRW4EK3S: (15929523395 / 5723825776612) * 100 ≈ 0.28%
GB35ZIXTWFVYZ64EXTW3ULQKIREF2L7OK72LMY4GRSUNHKTUWAGJ5IRK: (13929139525 / 5723825776612) * 100 ≈ 0.24%

Total adds up to ~99% (remainder likely in unpaged holders or rounding).


If the pool has many holders, paginate fully and compute on your end. Use big integers in code to avoid precision issues with large numbers.11 web pages672msTo make a bot that distributes rewards hourly based on LP share percentage from a daily fixed amount, say 4000 LMNR