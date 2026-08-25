#!/usr/bin/env bash
# End-to-end testnet dry run for lp-staking v2.
#
# Validates the FULL flow against a real deployed contract before mainnet:
#   deploy (constructor) -> add_pool -> fund -> post root -> stake with a real
#   Merkle proof -> accrue -> pending -> claim -> operator reconcile (allowed
#   down / rejected up) -> epoch transition -> stale settlement frozen.
#
# NOTE: this needs NO liquidity pools and NO paired assets. The contract never
# reads on-chain LP state -- pool_id is just a 32-byte identifier -- so a single
# test asset (the reward token) is enough.
#
# Single-leaf trees are used: root == leaf, proof is empty. That still exercises
# the exact v2 leaf format against the real contract, which is the highest-risk
# integration.
#
# Usage:  bash scripts/testnet-dryrun.sh
# Re-run: set FRESH=1 to regenerate keys/contract.

set -euo pipefail

NET=testnet
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WASM="$ROOT_DIR/contracts/lp-staking/target/wasm32v1-none/release/lp_staking.wasm"
LEAF="$ROOT_DIR/staking-site/scripts/compute-leaf.mjs"
STATE="$ROOT_DIR/.blueprint/.testnet-dryrun.env"

ADMIN=lp2-admin-test
OPERATOR=lp2-operator-test
USER=lp2-user-test
ISSUER=lp2-issuer-test

RATE=462962963                 # ~4000 tokens/day at 7 decimals
STAKE=100000000000             # 10,000.0 units
POOL_ID_HEX=$(printf 'ab%.0s' {1..32})   # 32 bytes of 0xab

say()  { printf '\n\033[1;36m=== %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  OK\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m  FAIL\033[0m %s\n' "$*"; exit 1; }
# Assert an invocation FAILS (for negative tests).
expect_fail() {
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then
    fail "$desc -- expected rejection but the call SUCCEEDED"
  else
    ok "$desc (correctly rejected)"
  fi
}

[ -f "$WASM" ] || fail "WASM not built. Run: cd contracts/lp-staking && cargo build --target wasm32v1-none --release --locked"
[ -f "$LEAF" ] || fail "missing $LEAF"

say "1. Keys"
for k in "$ADMIN" "$OPERATOR" "$USER" "$ISSUER"; do
  if [ "${FRESH:-0}" = "1" ] || ! stellar keys address "$k" >/dev/null 2>&1; then
    stellar keys generate --network "$NET" --fund "$k" >/dev/null 2>&1 || true
  fi
  printf '  %-20s %s\n' "$k" "$(stellar keys address "$k")"
done
ADMIN_G=$(stellar keys address "$ADMIN")
OPERATOR_G=$(stellar keys address "$OPERATOR")
USER_G=$(stellar keys address "$USER")
ISSUER_G=$(stellar keys address "$ISSUER")

say "2. Reward token (test asset -> SAC)"
ASSET="TLMNR:$ISSUER_G"
stellar contract asset deploy --asset "$ASSET" --source "$ISSUER" --network "$NET" >/dev/null 2>&1 || true
SAC=$(stellar contract id asset --asset "$ASSET" --network "$NET")
ok "SAC $SAC"

# Classic assets need a trustline on every G-account that will hold them.
# (Contract addresses do NOT — the SAC keeps a contract balance instead.)
for k in "$ADMIN" "$USER"; do
  stellar tx new change-trust --source-account "$k" --network "$NET" \
    --line "$ASSET" >/dev/null 2>&1 || true
  ok "trustline: $k"
done

# Give the admin a balance to fund the contract with.
stellar contract invoke --id "$SAC" --source "$ISSUER" --network "$NET" -- \
  mint --to "$ADMIN_G" --amount 1000000000000 >/dev/null
ok "minted 100,000 TLMNR to admin"

say "3. Deploy contract (atomic constructor)"
CONTRACT=$(stellar contract deploy --wasm "$WASM" --source "$ADMIN" --network "$NET" -- \
  --admin "$ADMIN_G" --operator "$OPERATOR_G" --lmnr_token "$SAC" 2>/dev/null | tail -1)
[ -n "$CONTRACT" ] || fail "deploy failed"
ok "contract $CONTRACT"

inv()  { stellar contract invoke --id "$CONTRACT" --source "$1" --network "$NET" -- "${@:2}"; }
invq() { inv "$@" 2>/dev/null; }

say "4. Roles set by constructor"
[ "$(invq "$ADMIN" get_admin)" = "\"$ADMIN_G\"" ] && ok "admin" || fail "admin mismatch"
ok "operator $(invq "$ADMIN" get_operator)"

say "5. add_pool"
IDX=$(invq "$ADMIN" add_pool --admin "$ADMIN_G" --pool_id "$POOL_ID_HEX" --reward_rate "$RATE")
ok "pool index $IDX, rate $(invq "$ADMIN" get_pool_rate --pool_index 0)"
ok "total_emission_rate $(invq "$ADMIN" total_emission_rate)"

say "6. Fund reward pool"
invq "$ADMIN" fund --funder "$ADMIN_G" --amount 500000000000 >/dev/null
ok "reward_balance $(invq "$ADMIN" reward_balance)"

say "7. Post epoch-1 root (single leaf: root == leaf, empty proof)"
CUR_LEDGER=$(curl -s "https://horizon-testnet.stellar.org/" | python3 -c 'import sys,json;print(json.load(sys.stdin)["history_latest_ledger"])')
LEAF1=$(node "$LEAF" "$CONTRACT" 0 "$POOL_ID_HEX" "$USER_G" "$STAKE" 1)
ok "leaf/root $LEAF1"
invq "$ADMIN" set_merkle_root --admin "$ADMIN_G" --pool_index 0 \
  --root "$LEAF1" --snapshot_ledger "$CUR_LEDGER" --total_lp "$STAKE" >/dev/null
ok "root posted, epoch $(invq "$ADMIN" get_merkle_root --pool_index 0 | python3 -c 'import sys,json;print(json.load(sys.stdin)["epoch_id"])')"
ok "epoch total_lp $(invq "$ADMIN" get_epoch_total_lp --pool_index 0)"

say "8. Stake with a REAL proof (validates leaf format on-chain)"
invq "$USER" stake --user "$USER_G" --pool_index 0 --lp_balance "$STAKE" --proof '[]' >/dev/null \
  || fail "stake rejected -- LEAF FORMAT MISMATCH between merkle.ts and merkle.rs"
ok "stake accepted -> leaf format verified against the deployed contract"

say "9. Negative tests"
expect_fail "replay the same epoch-1 proof" \
  stellar contract invoke --id "$CONTRACT" --source "$USER" --network "$NET" -- \
  stake --user "$USER_G" --pool_index 0 --lp_balance "$STAKE" --proof '[]'
expect_fail "operator withdraw" \
  stellar contract invoke --id "$CONTRACT" --source "$OPERATOR" --network "$NET" -- \
  withdraw --admin "$OPERATOR_G" --amount 1000
expect_fail "operator set_pool_rate" \
  stellar contract invoke --id "$CONTRACT" --source "$OPERATOR" --network "$NET" -- \
  set_pool_rate --admin "$OPERATOR_G" --pool_index 0 --new_rate 1
expect_fail "operator INCREASE stake" \
  stellar contract invoke --id "$CONTRACT" --source "$OPERATOR" --network "$NET" -- \
  update_stake --caller "$OPERATOR_G" --user "$USER_G" --pool_index 0 --new_amount $((STAKE * 2))

say "10. Accrual"
echo "  waiting 45s for ledger time to advance..."
sleep 45
PENDING=$(invq "$ADMIN" pending_reward --user "$USER_G" --pool_index 0)
ok "pending_reward $PENDING"
[ "$PENDING" != "0" ] || fail "no rewards accrued -- check rate/total_lp"

say "11. Claim"
invq "$USER" claim --user "$USER_G" --pool_index 0 >/dev/null
ok "claimed; TLMNR balance $(stellar contract invoke --id "$SAC" --source "$USER" --network "$NET" -- balance --id "$USER_G" 2>/dev/null)"

say "12. Operator DECREASE (allowed)"
invq "$OPERATOR" update_stake --caller "$OPERATOR_G" --user "$USER_G" --pool_index 0 \
  --new_amount $((STAKE / 2)) >/dev/null
ok "staked_amount now $(invq "$ADMIN" get_staker_info --user "$USER_G" --pool_index 0 | python3 -c 'import sys,json;print(json.load(sys.stdin)["staked_amount"])')"

say "13. Epoch 2 transition -> stale settlement must freeze"
CUR_LEDGER=$(curl -s "https://horizon-testnet.stellar.org/" | python3 -c 'import sys,json;print(json.load(sys.stdin)["history_latest_ledger"])')
OTHER=$(stellar keys address "$ISSUER")
LEAF2=$(node "$LEAF" "$CONTRACT" 0 "$POOL_ID_HEX" "$OTHER" "$STAKE" 2)
invq "$ADMIN" set_merkle_root --admin "$ADMIN_G" --pool_index 0 \
  --root "$LEAF2" --snapshot_ledger "$CUR_LEDGER" --total_lp "$STAKE" >/dev/null
ok "epoch 2 posted"
FROZEN=$(invq "$ADMIN" pending_reward --user "$USER_G" --pool_index 0)
echo "  stale pending right after transition: $FROZEN"
echo "  waiting 45s -- a stale staker must NOT accrue further..."
sleep 45
FROZEN2=$(invq "$ADMIN" pending_reward --user "$USER_G" --pool_index 0)
echo "  stale pending after waiting:          $FROZEN2"
[ "$FROZEN" = "$FROZEN2" ] && ok "stale settlement is FROZEN (H-1 fix confirmed on-chain)" \
  || fail "stale staker accrued across an epoch boundary -- H-1 REGRESSION"

say "14. Operator cannot renew a stale record"
invq "$OPERATOR" update_stake --caller "$OPERATOR_G" --user "$USER_G" --pool_index 0 \
  --new_amount $((STAKE / 4)) >/dev/null
EPOCH_AFTER=$(invq "$ADMIN" get_staker_info --user "$USER_G" --pool_index 0 | python3 -c 'import sys,json;print(json.load(sys.stdin)["epoch_id"])')
[ "$EPOCH_AFTER" = "1" ] && ok "record stayed in epoch 1 (H-R2-1 fix confirmed on-chain)" \
  || fail "operator advanced a stale record to epoch $EPOCH_AFTER -- H-R2-1 REGRESSION"

cat > "$STATE" <<EOF
TESTNET_CONTRACT=$CONTRACT
TESTNET_SAC=$SAC
TESTNET_ADMIN=$ADMIN_G
TESTNET_OPERATOR=$OPERATOR_G
TESTNET_USER=$USER_G
TESTNET_POOL_ID=$POOL_ID_HEX
EOF

say "DONE — all on-chain checks passed"
echo "State written to $STATE"
echo "Explorer: https://stellar.expert/explorer/testnet/contract/$CONTRACT"
