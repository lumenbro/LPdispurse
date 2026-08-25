#!/usr/bin/env node
/**
 * Cross-language Merkle leaf verification.
 *
 * The contract verifies proofs against leaves it hashes itself. If the
 * TypeScript builder in lib/merkle.ts and the Rust implementation in
 * contracts/lp-staking/src/merkle.rs disagree by a single byte, every proof
 * fails on-chain and no user can stake. This script proves they agree.
 *
 * Regenerate the vectors after ANY change to either implementation:
 *   cd contracts/lp-staking
 *   cargo test print_leaf_vectors -- --nocapture | grep LEAFVEC
 * then paste the values below and run:
 *   node staking-site/scripts/verify-leaf.mjs
 */

import { createHash } from "crypto";
import { Address } from "@stellar/stellar-sdk";

// ---- Vectors emitted by the Rust test `test_print_leaf_vectors` ----
const VECTOR = {
  contract: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM",
  user: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDR4",
  poolIdHex:
    "0707070707070707070707070707070707070707070707070707070707070707",
  poolIndex: 2,
  balance: 123456789012n,
  epoch: 3n,
  expectedLeafHex:
    "fced65d08ba50f22ec6e25eeb284e225c7721c41ef4786cdbd28ee86c4ff0a09",
};

// ---- Mirror of lib/merkle.ts computeLeaf (kept inline so this script has no
// ---- build step and can run against a plain checkout) ----
const LEAF_PREFIX = 0x00;
const DOMAIN = "LPSTAKE_V2";

function sha256(b) {
  return createHash("sha256").update(b).digest();
}

function bigintToI128BE(value) {
  const buf = Buffer.alloc(16);
  let v = value;
  if (v < 0n) v = (1n << 128n) + v;
  for (let i = 15; i >= 0; i--) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

function computeLeaf(contractId, poolIndex, poolId, userAddress, balance, epoch) {
  const poolBuf = Buffer.alloc(4);
  poolBuf.writeUInt32BE(poolIndex);
  const epochBuf = Buffer.alloc(8);
  epochBuf.writeBigUInt64BE(epoch);

  return sha256(
    Buffer.concat([
      Buffer.from([LEAF_PREFIX]),
      Buffer.from(DOMAIN, "ascii"),
      new Address(contractId).toScVal().toXDR(),
      poolId,
      poolBuf,
      new Address(userAddress).toScVal().toXDR(),
      bigintToI128BE(balance),
      epochBuf,
    ])
  );
}

const got = computeLeaf(
  VECTOR.contract,
  VECTOR.poolIndex,
  Buffer.from(VECTOR.poolIdHex, "hex"),
  VECTOR.user,
  VECTOR.balance,
  VECTOR.epoch
).toString("hex");

if (got === VECTOR.expectedLeafHex) {
  console.log("PASS  TypeScript leaf matches Rust contract leaf");
  console.log(`      ${got}`);
  process.exit(0);
} else {
  console.error("FAIL  leaf mismatch — proofs would be rejected on-chain");
  console.error(`      rust: ${VECTOR.expectedLeafHex}`);
  console.error(`      ts:   ${got}`);
  process.exit(1);
}
