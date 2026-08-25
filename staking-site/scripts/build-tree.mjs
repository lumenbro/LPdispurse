#!/usr/bin/env node
/**
 * Build a full multi-leaf Merkle tree and emit root + per-holder proofs.
 * Mirrors contracts/lp-staking/src/merkle.rs and lib/merkle.ts.
 *
 * Usage:
 *   node build-tree.mjs <contractId> <poolIndex> <poolIdHex> <epoch> G1:bal1 G2:bal2 ...
 *
 * Emits JSON: { root, totalLp, holders: [{ address, balance, proof: [hex...] }] }
 */

import { createHash } from "crypto";
import { Address } from "@stellar/stellar-sdk";

const [, , contractId, poolIndexStr, poolIdHex, epochStr, ...pairs] = process.argv;
if (!contractId || !poolIndexStr || !poolIdHex || !epochStr || pairs.length === 0) {
  console.error(
    "usage: build-tree.mjs <contractId> <poolIndex> <poolIdHex> <epoch> G:bal [G:bal ...]"
  );
  process.exit(2);
}

const LEAF_PREFIX = 0x00;
const NODE_PREFIX = 0x01;
const DOMAIN = "LPSTAKE_V2";

const sha256 = (b) => createHash("sha256").update(b).digest();

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

function hashPair(a, b) {
  const p = Buffer.from([NODE_PREFIX]);
  return a.compare(b) <= 0
    ? sha256(Buffer.concat([p, a, b]))
    : sha256(Buffer.concat([p, b, a]));
}

/** Left-heavy tree; odd node promotes unpaired. Matches merkle.rs test builder. */
function buildMerkleTree(leaves) {
  if (leaves.length === 1) return { root: Buffer.from(leaves[0]), proofs: [[]] };
  const proofs = leaves.map(() => []);
  let layer = leaves.map((h, i) => ({ hash: Buffer.from(h), idx: [i] }));

  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      if (i + 1 < layer.length) {
        const L = layer[i];
        const R = layer[i + 1];
        for (const k of L.idx) proofs[k].push(Buffer.from(R.hash));
        for (const k of R.idx) proofs[k].push(Buffer.from(L.hash));
        next.push({ hash: hashPair(L.hash, R.hash), idx: [...L.idx, ...R.idx] });
      } else {
        next.push(layer[i]);
      }
    }
    layer = next;
  }
  return { root: layer[0].hash, proofs };
}

function verifyProof(leaf, proof, root) {
  let cur = leaf;
  for (const s of proof) cur = hashPair(cur, s);
  return cur.equals(root);
}

const poolId = Buffer.from(poolIdHex, "hex");
const poolIndex = Number(poolIndexStr);
const epoch = BigInt(epochStr);

const holders = pairs.map((p) => {
  const [address, bal] = p.split(":");
  return { address, balance: BigInt(bal) };
});

const leaves = holders.map((h) =>
  computeLeaf(contractId, poolIndex, poolId, h.address, h.balance, epoch)
);
const tree = buildMerkleTree(leaves);

// Self-check every proof before anything reaches the chain.
for (let i = 0; i < leaves.length; i++) {
  if (!verifyProof(leaves[i], tree.proofs[i], tree.root)) {
    console.error(`proof ${i} (${holders[i].address}) failed local verification`);
    process.exit(1);
  }
}

console.log(
  JSON.stringify({
    root: tree.root.toString("hex"),
    totalLp: holders.reduce((a, h) => a + h.balance, 0n).toString(),
    holders: holders.map((h, i) => ({
      address: h.address,
      balance: h.balance.toString(),
      proof: tree.proofs[i].map((b) => b.toString("hex")),
    })),
  })
);
