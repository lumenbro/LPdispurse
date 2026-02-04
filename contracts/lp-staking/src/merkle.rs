use soroban_sdk::xdr::ToXdr;
use soroban_sdk::{Address, Bytes, BytesN, Env, Vec};

const LEAF_PREFIX: u8 = 0x00;
const NODE_PREFIX: u8 = 0x01;

/// Compute a Merkle leaf hash for an LP position.
///
/// leaf = SHA-256(0x00 || pool_index_u32_be || user_address_xdr || lp_balance_i128_be || epoch_id_u64_be)
pub fn compute_leaf(
    env: &Env,
    pool_index: u32,
    user: &Address,
    lp_balance: i128,
    epoch_id: u64,
) -> BytesN<32> {
    let mut data = Bytes::new(env);

    // Domain separator for leaf
    data.push_back(LEAF_PREFIX);

    // Pool index (4 bytes big-endian)
    let pool_bytes = pool_index.to_be_bytes();
    for b in pool_bytes {
        data.push_back(b);
    }

    // User address as XDR
    let user_bytes = user.to_xdr(env);
    data.append(&user_bytes);

    // LP balance (16 bytes big-endian)
    let balance_bytes = lp_balance.to_be_bytes();
    for b in balance_bytes {
        data.push_back(b);
    }

    // Epoch ID (8 bytes big-endian)
    let epoch_bytes = epoch_id.to_be_bytes();
    for b in epoch_bytes {
        data.push_back(b);
    }

    env.crypto().sha256(&data).into()
}

/// Verify a Merkle proof against a known root.
///
/// Uses canonical ordering: internal node = SHA-256(0x01 || min(left, right) || max(left, right))
pub fn verify_proof(env: &Env, leaf: &BytesN<32>, proof: &Vec<BytesN<32>>, root: &BytesN<32>) -> bool {
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

    // Canonical ordering: smaller hash first
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
