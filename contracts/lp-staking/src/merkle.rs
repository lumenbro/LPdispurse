use soroban_sdk::xdr::ToXdr;
use soroban_sdk::{Address, Bytes, BytesN, Env, Vec};

const LEAF_PREFIX: u8 = 0x00;
const NODE_PREFIX: u8 = 0x01;

/// Domain tag so leaves can never be reinterpreted by another protocol/version.
const DOMAIN: &[u8] = b"LPSTAKE_V2";

/// Upper bound on proof length (2^32 leaves). Bounds worst-case CPU and matches
/// the off-chain tree builder's spec.
pub const MAX_PROOF_LEN: u32 = 32;

/// Compute a Merkle leaf hash for an LP position.
///
/// leaf = SHA-256(
///     0x00 || "LPSTAKE_V2"
///          || contract_address_xdr   <- binds proofs to THIS deployment (L-1)
///          || pool_id (32 bytes)     <- binds to the real pool, not just index
///          || pool_index_u32_be
///          || user_address_xdr
///          || lp_balance_i128_be
///          || epoch_id_u64_be
/// )
///
/// NOTE: the off-chain tree builder (staking-site cron) MUST hash leaves
/// identically or every proof will fail verification.
pub fn compute_leaf(
    env: &Env,
    pool_index: u32,
    pool_id: &BytesN<32>,
    user: &Address,
    lp_balance: i128,
    epoch_id: u64,
) -> BytesN<32> {
    let mut data = Bytes::new(env);

    data.push_back(LEAF_PREFIX);

    // Domain separator
    for b in DOMAIN {
        data.push_back(*b);
    }

    // Bind to this contract instance
    let contract_bytes = env.current_contract_address().to_xdr(env);
    data.append(&contract_bytes);

    // Bind to the actual pool id
    let pool_id_bytes: Bytes = pool_id.clone().into();
    data.append(&pool_id_bytes);

    // Pool index (4 bytes big-endian)
    for b in pool_index.to_be_bytes() {
        data.push_back(b);
    }

    // User address as XDR
    let user_bytes = user.to_xdr(env);
    data.append(&user_bytes);

    // LP balance (16 bytes big-endian)
    for b in lp_balance.to_be_bytes() {
        data.push_back(b);
    }

    // Epoch ID (8 bytes big-endian)
    for b in epoch_id.to_be_bytes() {
        data.push_back(b);
    }

    env.crypto().sha256(&data).into()
}

/// Verify a Merkle proof against a known root.
///
/// Uses canonical ordering: internal node = SHA-256(0x01 || min(l, r) || max(l, r)).
/// Sorted-pair hashing removes left/right direction from the proof; a non-member
/// proof still requires a SHA-256 collision/preimage.
pub fn verify_proof(
    env: &Env,
    leaf: &BytesN<32>,
    proof: &Vec<BytesN<32>>,
    root: &BytesN<32>,
) -> bool {
    if proof.len() > MAX_PROOF_LEN {
        return false;
    }

    let mut current = leaf.clone();
    for i in 0..proof.len() {
        let sibling = proof.get(i).unwrap();
        current = hash_pair(env, &current, &sibling);
    }
    current == *root
}

/// Hash two nodes together with canonical ordering (smaller first).
fn hash_pair(env: &Env, a: &BytesN<32>, b: &BytesN<32>) -> BytesN<32> {
    let mut data = Bytes::new(env);
    data.push_back(NODE_PREFIX);

    let a_bytes: Bytes = a.clone().into();
    let b_bytes: Bytes = b.clone().into();

    if a_bytes <= b_bytes {
        data.append(&a_bytes);
        data.append(&b_bytes);
    } else {
        data.append(&b_bytes);
        data.append(&a_bytes);
    }

    env.crypto().sha256(&data).into()
}
