/**
 * TypeScript Merkle tree implementation that matches the Rust contract's
 * merkle.rs byte-for-byte. Used by the indexer to build trees off-chain.
 *
 * CONTRACT v2 LEAF FORMAT — if this and merkle.rs ever diverge by a single
 * byte, EVERY proof fails on-chain. Cross-checked by scripts/verify-leaf.mjs
 * against hashes printed by the Rust test `test_print_leaf_vectors`.
 *
 * Leaf: SHA-256(
 *         0x00
 *      || "LPSTAKE_V2"                (domain tag, 10 ASCII bytes)
 *      || contract_address_scval_xdr  (binds proofs to ONE deployment)
 *      || pool_id                     (raw 32 bytes, NOT XDR-wrapped)
 *      || pool_index_u32_be
 *      || user_address_scval_xdr
 *      || lp_balance_i128_be
 *      || epoch_id_u64_be
 *   )
 * Node: SHA-256(0x01 || min(left, right) || max(left, right))
 */

import { createHash } from "crypto";
import { Address } from "@stellar/stellar-sdk";

const LEAF_PREFIX = 0x00;
const NODE_PREFIX = 0x01;

/** Must equal merkle.rs DOMAIN. */
export const DOMAIN = "LPSTAKE_V2";

/** Must equal merkle.rs MAX_PROOF_LEN. */
export const MAX_PROOF_LEN = 32;

/** Must equal lib.rs MIN_STAKE / MAX_STAKE. */
export const MIN_STAKE = 10_000_000n;
export const MAX_STAKE = 1_000_000_000_000_000_000_000n;

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
 * Addresses are serialized as ScVal XDR, matching Rust's `address.to_xdr(env)`.
 * `poolId` is appended as RAW 32 bytes (Rust converts BytesN<32> -> Bytes and
 * appends it directly; it is NOT XDR-wrapped).
 *
 * @param contractId  the staking contract's C... address — leaves are bound to
 *                    a single deployment, so proofs cannot be replayed onto
 *                    another instance.
 * @param poolId      the 32-byte pool identifier registered via add_pool.
 */
export function computeLeaf(
  contractId: string,
  poolIndex: number,
  poolId: Buffer,
  userAddress: string,
  lpBalance: bigint,
  epochId: bigint
): Buffer {
  if (poolId.length !== 32) {
    throw new Error(`poolId must be 32 bytes, got ${poolId.length}`);
  }

  const prefix = Buffer.from([LEAF_PREFIX]);
  const domain = Buffer.from(DOMAIN, "ascii");

  // contract address -> ScVal XDR (Rust: env.current_contract_address().to_xdr)
  const contractXdr = new Address(contractId).toScVal().toXDR();

  // pool_index as u32 big-endian
  const poolBuf = Buffer.alloc(4);
  poolBuf.writeUInt32BE(poolIndex);

  // user address -> ScVal XDR bytes
  const addrXdr = new Address(userAddress).toScVal().toXDR();

  // lp_balance as i128 big-endian (16 bytes)
  const balBuf = bigintToI128BE(lpBalance);

  // epoch_id as u64 big-endian (8 bytes)
  const epochBuf = Buffer.alloc(8);
  epochBuf.writeBigUInt64BE(epochId);

  return sha256(
    Buffer.concat([
      prefix,
      domain,
      contractXdr,
      poolId,
      poolBuf,
      addrXdr,
      balBuf,
      epochBuf,
    ])
  );
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

// ============================================================================
// Snapshot invariants
//
// These are NOT enforceable on-chain. The contract checks each leaf balance
// against total_lp individually, but nothing verifies that the SUM of the
// leaves is consistent with the declared denominator. A root containing ten
// users at 100 each while declaring total_lp = 100 would accrue 10x the
// intended emission, irreversibly, for that epoch. Treat a failure here as a
// hard stop: never post the root.
// ============================================================================

export interface SnapshotEntry {
  address: string;
  /** LP balance in stroops at the snapshot ledger. */
  balance: bigint;
}

export interface SnapshotInvariantOptions {
  /** True when `entries` covers EVERY LP holder in the pool, in which case the
   *  sum must equal total_lp exactly rather than merely not exceeding it. */
  exhaustive?: boolean;
}

/**
 * Validate a snapshot before it is turned into a Merkle root.
 * Throws on the first violation.
 */
export function assertSnapshotInvariants(
  entries: SnapshotEntry[],
  totalLp: bigint,
  opts: SnapshotInvariantOptions = {}
): void {
  if (entries.length === 0) {
    throw new Error("snapshot invariant: no entries");
  }

  // total_lp must be inside the contract's accepted bounds.
  if (totalLp < MIN_STAKE || totalLp > MAX_STAKE) {
    throw new Error(
      `snapshot invariant: total_lp ${totalLp} outside [${MIN_STAKE}, ${MAX_STAKE}]`
    );
  }

  const seen = new Set<string>();
  let sum = 0n;

  for (const e of entries) {
    // One leaf per (pool, address, epoch).
    const key = e.address.toUpperCase();
    if (seen.has(key)) {
      throw new Error(`snapshot invariant: duplicate address ${e.address}`);
    }
    seen.add(key);

    if (e.balance <= 0n) {
      throw new Error(
        `snapshot invariant: non-positive balance for ${e.address}`
      );
    }
    if (e.balance < MIN_STAKE) {
      throw new Error(
        `snapshot invariant: ${e.address} balance ${e.balance} below MIN_STAKE ${MIN_STAKE} — the contract would reject this stake`
      );
    }
    if (e.balance > MAX_STAKE) {
      throw new Error(
        `snapshot invariant: ${e.address} balance ${e.balance} above MAX_STAKE`
      );
    }
    if (e.balance > totalLp) {
      throw new Error(
        `snapshot invariant: ${e.address} balance ${e.balance} exceeds total_lp ${totalLp}`
      );
    }

    sum += e.balance;
  }

  // THE critical one: aggregate emission must not exceed the configured rate.
  if (sum > totalLp) {
    throw new Error(
      `snapshot invariant: sum of balances ${sum} exceeds total_lp ${totalLp} — ` +
        `this would over-emit by ${Number((sum * 100n) / totalLp) / 100}x for the epoch`
    );
  }
  if (opts.exhaustive && sum !== totalLp) {
    throw new Error(
      `snapshot invariant: exhaustive snapshot sum ${sum} != total_lp ${totalLp}`
    );
  }
}

/**
 * Validate the epoch metadata that accompanies a root.
 * `MAX_SNAPSHOT_AGE` mirrors the contract constant (~7 days of ledgers).
 */
export const MAX_SNAPSHOT_AGE = 120_960;

export function assertSnapshotLedger(
  snapshotLedger: number,
  currentLedger: number,
  previousSnapshotLedger: number | null
): void {
  if (!Number.isInteger(snapshotLedger) || snapshotLedger < 0) {
    throw new Error(`snapshot invariant: bad snapshot_ledger ${snapshotLedger}`);
  }
  if (snapshotLedger > currentLedger) {
    throw new Error(
      `snapshot invariant: snapshot_ledger ${snapshotLedger} is in the future (current ${currentLedger})`
    );
  }
  if (currentLedger - snapshotLedger > MAX_SNAPSHOT_AGE) {
    throw new Error(
      `snapshot invariant: snapshot_ledger ${snapshotLedger} older than MAX_SNAPSHOT_AGE (${MAX_SNAPSHOT_AGE})`
    );
  }
  if (
    previousSnapshotLedger !== null &&
    snapshotLedger <= previousSnapshotLedger
  ) {
    throw new Error(
      `snapshot invariant: snapshot_ledger ${snapshotLedger} must exceed previous ${previousSnapshotLedger}`
    );
  }
}

/**
 * Locally verify every generated proof against the root before posting it.
 * Catches a leaf-format drift between this file and merkle.rs before it can
 * reach the chain and break every stake.
 */
export function assertProofsValid(
  leaves: Buffer[],
  tree: MerkleTree
): void {
  if (tree.proofs.length !== leaves.length) {
    throw new Error("proof invariant: proof count != leaf count");
  }
  for (let i = 0; i < leaves.length; i++) {
    if (tree.proofs[i].length > MAX_PROOF_LEN) {
      throw new Error(
        `proof invariant: proof ${i} length ${tree.proofs[i].length} exceeds MAX_PROOF_LEN ${MAX_PROOF_LEN}`
      );
    }
    if (!verifyProof(leaves[i], tree.proofs[i], tree.root)) {
      throw new Error(`proof invariant: proof ${i} does not verify against root`);
    }
  }
}
