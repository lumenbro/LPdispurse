/**
 * TypeScript Merkle tree implementation that matches the Rust contract's
 * merkle.rs byte-for-byte. Used by the indexer to build trees off-chain.
 *
 * Leaf:  SHA-256(0x00 || pool_index_u32_be || user_address_scval_xdr || lp_balance_i128_be || epoch_id_u64_be)
 * Node:  SHA-256(0x01 || min(left, right) || max(left, right))
 */

import { createHash } from "crypto";
import { Address } from "@stellar/stellar-sdk";

const LEAF_PREFIX = 0x00;
const NODE_PREFIX = 0x01;

function sha256(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

/**
 * Encode a bigint as a 16-byte big-endian i128 (two's complement).
 */
function bigintToI128BE(value: bigint): Buffer {
  const buf = Buffer.alloc(16);
  let v = value;
  if (v < 0n) {
    v = (1n << 128n) + v;
  }
  for (let i = 15; i >= 0; i--) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

/**
 * Compute a Merkle leaf hash identical to the Rust contract's compute_leaf().
 *
 * The address is serialized as ScVal XDR — this matches Rust's `address.to_xdr(env)`.
 */
export function computeLeaf(
  poolIndex: number,
  userAddress: string,
  lpBalance: bigint,
  epochId: bigint
): Buffer {
  // 0x00 prefix
  const prefix = Buffer.from([LEAF_PREFIX]);

  // pool_index as u32 big-endian
  const poolBuf = Buffer.alloc(4);
  poolBuf.writeUInt32BE(poolIndex);

  // user address -> ScVal XDR bytes (matches Rust's Address::to_xdr)
  const addr = new Address(userAddress);
  const addrXdr = addr.toScVal().toXDR();

  // lp_balance as i128 big-endian (16 bytes)
  const balBuf = bigintToI128BE(lpBalance);

  // epoch_id as u64 big-endian (8 bytes)
  const epochBuf = Buffer.alloc(8);
  epochBuf.writeBigUInt64BE(epochId);

  return sha256(Buffer.concat([prefix, poolBuf, addrXdr, balBuf, epochBuf]));
}

/**
 * Hash two tree nodes with canonical ordering (smaller hash first).
 * Matches Rust's hash_pair().
 */
export function hashPair(a: Buffer, b: Buffer): Buffer {
  const prefix = Buffer.from([NODE_PREFIX]);
  if (a.compare(b) <= 0) {
    return sha256(Buffer.concat([prefix, a, b]));
  } else {
    return sha256(Buffer.concat([prefix, b, a]));
  }
}

/**
 * Verify a Merkle proof against a root. Client-side verification for debugging.
 */
export function verifyProof(
  leaf: Buffer,
  proof: Buffer[],
  root: Buffer
): boolean {
  let current = leaf;
  for (const sibling of proof) {
    current = hashPair(current, sibling);
  }
  return current.equals(root);
}

export interface MerkleTree {
  root: Buffer;
  /** proofs[i] is the Merkle proof for leaves[i] */
  proofs: Buffer[][];
}

/**
 * Build a Merkle tree from an array of leaf hashes.
 * Returns the root and a proof path for each leaf.
 *
 * Tree shape: left-heavy (odd nodes promote without pairing).
 * Matches the Rust test tree shapes (2, 3, 4 leaves verified).
 */
export function buildMerkleTree(leaves: Buffer[]): MerkleTree {
  if (leaves.length === 0) throw new Error("Cannot build tree from 0 leaves");
  if (leaves.length === 1) {
    return { root: Buffer.from(leaves[0]), proofs: [[]] };
  }

  const proofs: Buffer[][] = leaves.map(() => []);

  // Each node tracks which original leaf indices it represents
  let layer: { hash: Buffer; leafIndices: number[] }[] = leaves.map(
    (leaf, i) => ({
      hash: Buffer.from(leaf),
      leafIndices: [i],
    })
  );

  while (layer.length > 1) {
    const nextLayer: typeof layer = [];

    for (let i = 0; i < layer.length; i += 2) {
      if (i + 1 < layer.length) {
        const left = layer[i];
        const right = layer[i + 1];
        const parentHash = hashPair(left.hash, right.hash);

        // Add sibling hash to proof for all leaves in each subtree
        for (const idx of left.leafIndices) {
          proofs[idx].push(Buffer.from(right.hash));
        }
        for (const idx of right.leafIndices) {
          proofs[idx].push(Buffer.from(left.hash));
        }

        nextLayer.push({
          hash: parentHash,
          leafIndices: [...left.leafIndices, ...right.leafIndices],
        });
      } else {
        // Odd node: promote to next layer (no sibling at this level)
        nextLayer.push(layer[i]);
      }
    }

    layer = nextLayer;
  }

  return { root: layer[0].hash, proofs };
}
