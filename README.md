## LP Rewards Disbursement Bot

This bot discovers LMNR AMM pools, snapshots holders via Stellar Expert, calculates hourly rewards (4000 LMNR/day per pool), and prepares disbursement transactions.

### Setup
1. Create `.env` based on:
   - STELLAR_NETWORK=public
   - HORIZON_URL=https://horizon.stellar.org
   - NETWORK_PASSPHRASE=Public Global Stellar Network ; September 2015
   - LMNR_CODE=LMNR
   - LMNR_ISSUER=GALUVE2YREE6NU4T2746XL7XORCEY5NVDJ7WADGWANUZWQJZ3PTP5PHB
   - DISBURSEMENT_PUBLIC=<public-key>
   - DISBURSEMENT_SECRET=<secret-or-use-enclave>
   - DATA_DIR=data
   - BATCH_SIZE=100
   - DRY_RUN=true

2. Install requirements:

```bash
pip install -r requirements.txt
```

### Commands

```bash
python -m rewards_disbursement_bot.cli discover
python -m rewards_disbursement_bot.cli snapshot
python -m rewards_disbursement_bot.cli payout --dry-run
```

The `data/` directory will contain `pools.json`, per-pool `participants/<pool_id>.json`, and hourly `payout_ledger/<date>/<pool_id>.json`.

### Notes
- Payout submission is wired to use `core/stellar.build_and_submit_transaction` but requires a signer implementation; currently the CLI defaults to dry-run and a placeholder signer. Integrate your signer or enclave to enable live submissions.
- For pool discovery, common pairs (XLM/USDC/USDT with LMNR) are seeded; extend as needed.


