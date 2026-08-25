#!/usr/bin/env node
/**
 * Compute a v2 Merkle leaf hash from the command line.
 * Mirrors contracts/lp-staking/src/merkle.rs compute_leaf().
 *
 * Usage:
 *   node compute-leaf.mjs <contractId> <poolIndex> <poolIdHex> <userG> <balance> <epoch>
 * Prints the leaf hash as hex.
 *
 * For a single-leaf tree the root EQUALS the leaf and the proof is empty,
 * which is what the testnet dry run relies on.
 */

import { createHash } from "crypto";
import { Address } from "@stellar/stellar-sdk";

const [, , contractId, poolIndexStr, poolIdHex, userAddr, balanceStr, epochStr] =
  process.argv;

if (!contractId || !poolIndexStr || !poolIdHex || !userAddr || !balanceStr || !epochStr) {
  console.error(
    "usage: compute-leaf.mjs <contractId> <poolIndex> <poolIdHex> <userG> <balance> <epoch>"
  );
  process.exit(2);
}

const LEAF_PREFIX = 0x00;
const DOMAIN = "LPSTAKE_V2";

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

const poolId = Buffer.from(poolIdHex, "hex");
if (poolId.length !== 32) {
  console.error(`poolId must be 32 bytes, got ${poolId.length}`);
  process.exit(2);
}

const poolBuf = Buffer.alloc(4);
poolBuf.writeUInt32BE(Number(poolIndexStr));

const epochBuf = Buffer.alloc(8);
epochBuf.writeBigUInt64BE(BigInt(epochStr));

const leaf = createHash("sha256")
  .update(
    Buffer.concat([
      Buffer.from([LEAF_PREFIX]),
      Buffer.from(DOMAIN, "ascii"),
      new Address(contractId).toScVal().toXDR(),
      poolId,
      poolBuf,
      new Address(userAddr).toScVal().toXDR(),
      bigintToI128BE(BigInt(balanceStr)),
      epochBuf,
    ])
  )
  .digest("hex");

console.log(leaf);
