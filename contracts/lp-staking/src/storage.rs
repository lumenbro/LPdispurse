use soroban_sdk::{contracttype, Address, BytesN, Env};

use crate::errors::ContractError;

// Storage TTL constants (in ledgers, ~5 seconds each).
const INSTANCE_TTL_THRESHOLD: u32 = 17_280; // ~1 day
const INSTANCE_TTL_EXTEND: u32 = 518_400; // ~30 days

// Persistent entries refresh eagerly (~6 day threshold rather than ~1 day) so a
// single touch well before expiry keeps economically-live state warm.
//
// Archival is NOT data loss: from Protocol 23 onward an archived persistent
// entry is auto-restored before contract execution when the transaction carries
// the restoration data, so contract code cannot observe an archived entry as
// "missing". Archival therefore costs restore fees and client-side simulation
// support, not correctness. The `*Missing` errors below exist to refuse to
// operate on genuinely absent state rather than silently substituting zeros.
const PERSISTENT_TTL_THRESHOLD: u32 = 103_680; // ~6 days
const PERSISTENT_TTL_EXTEND: u32 = 518_400; // ~30 days

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    /// Two-step admin transfer target (L-4): set by propose_admin, consumed by accept_admin.
    PendingAdmin,
    /// Minimal-privilege role allowed to call update_stake only (cron key).
    Operator,
    /// Minimal-privilege role allowed to call set_merkle_root only. Lets the
    /// automation post snapshots without holding admin, so handing off admin
    /// never disturbs the cron (and vice versa).
    Poster,
    LmnrToken,
    PoolCount,
    /// Cached sum of active pools' rates so the view never loops (L-NEW-4).
    TotalEmissionRate,
    PoolId(u32),
    PoolIdIndex(BytesN<32>),
    PoolState(u32),
    MerkleRoot(u32),
    Staker(Address, u32),
    /// (pool_index, epoch_id) -> acc_reward_per_share FROZEN at the moment that
    /// epoch ended. This is the H-1 fix: stale stakers settle against the
    /// snapshot for THEIR OWN epoch, which never moves again, instead of a
    /// single pool-wide "previous accumulator" that advanced every epoch.
    EpochEndAcc(u32, u64),
    /// (user, pool) -> the last epoch in which this user successfully proved a
    /// position. Kept SEPARATE from StakerInfo and never deleted by
    /// reconciliation, unstake, or claim, so a spent Merkle proof can never be
    /// replayed after the staker record is zeroed or removed.
    LastProvenEpoch(Address, u32),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PoolState {
    pub acc_reward_per_share: i128,
    /// Sum of PROVEN stakes. Observability only — it is deliberately NOT the
    /// reward denominator (see MerkleRootData::total_lp), so a stale staker who
    /// never re-proves cannot dilute the users who did (H-NEW-2).
    pub total_staked: i128,
    pub last_reward_time: u64,
    /// Per-pool emission rate in reward-token stroops per second (Option A).
    pub reward_rate: i128,
    /// Undistributed numerator carried between updates so repeated small
    /// updates cannot silently discard emission to flooring (M-NEW-2).
    pub reward_remainder: i128,
    /// False once remove_pool is called: no new stakes/roots, no accrual.
    /// Existing stakers can still claim and unstake.
    pub active: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MerkleRootData {
    pub root: BytesN<32>,
    pub epoch_id: u64,
    pub snapshot_ledger: u32,
    pub posted_at: u64,
    /// Authenticated total LP in the pool at snapshot time — the REWARD
    /// DENOMINATOR for this epoch. Mirrors the original Python bot's
    /// `percent = balance / total_shares`: a staker earns
    /// `rate * (their_lp / total_lp)`. LP holders who never prove simply leave
    /// their slice unclaimed in the contract; nobody can be diluted by a stale
    /// position that is still sitting in `total_staked`.
    pub total_lp: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StakerInfo {
    pub staked_amount: i128,
    pub reward_debt: i128,
    pub pending_rewards: i128,
    pub epoch_id: u64,
}

// --- Instance storage (Admin, Operator, LmnrToken, PoolCount) ---

pub fn has_admin(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::Admin)
}

pub fn get_admin(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Admin).unwrap()
}

pub fn set_admin(env: &Env, admin: &Address) {
    env.storage().instance().set(&DataKey::Admin, admin);
}

pub fn get_pending_admin(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::PendingAdmin)
}

pub fn set_pending_admin(env: &Env, admin: &Address) {
    env.storage().instance().set(&DataKey::PendingAdmin, admin);
}

pub fn remove_pending_admin(env: &Env) {
    env.storage().instance().remove(&DataKey::PendingAdmin);
}

pub fn get_operator(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::Operator)
}

pub fn set_operator(env: &Env, operator: &Address) {
    env.storage().instance().set(&DataKey::Operator, operator);
}

pub fn get_poster(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::Poster)
}

pub fn set_poster(env: &Env, poster: &Address) {
    env.storage().instance().set(&DataKey::Poster, poster);
}

pub fn get_lmnr_token(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::LmnrToken).unwrap()
}

pub fn set_lmnr_token(env: &Env, token: &Address) {
    env.storage().instance().set(&DataKey::LmnrToken, token);
}

pub fn get_pool_count(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::PoolCount)
        .unwrap_or(0)
}

pub fn set_pool_count(env: &Env, count: u32) {
    env.storage().instance().set(&DataKey::PoolCount, &count);
}

pub fn get_total_emission_rate(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::TotalEmissionRate)
        .unwrap_or(0)
}

pub fn set_total_emission_rate(env: &Env, rate: i128) {
    env.storage()
        .instance()
        .set(&DataKey::TotalEmissionRate, &rate);
}

pub fn extend_instance_ttl(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
}

// --- Persistent storage ---

pub fn get_pool_id(env: &Env, index: u32) -> BytesN<32> {
    let key = DataKey::PoolId(index);
    env.storage().persistent().get(&key).unwrap()
}

pub fn set_pool_id(env: &Env, index: u32, pool_id: &BytesN<32>) {
    let key = DataKey::PoolId(index);
    env.storage().persistent().set(&key, pool_id);
    extend_persistent(env, &key);
}

pub fn has_pool_id_index(env: &Env, pool_id: &BytesN<32>) -> bool {
    env.storage()
        .persistent()
        .has(&DataKey::PoolIdIndex(pool_id.clone()))
}

pub fn set_pool_id_index(env: &Env, pool_id: &BytesN<32>, index: u32) {
    let key = DataKey::PoolIdIndex(pool_id.clone());
    env.storage().persistent().set(&key, &index);
    extend_persistent(env, &key);
}

/// Returns an error rather than silently defaulting to a zeroed pool if the
/// entry is archived (H-3). Zeroed state would corrupt reward accounting.
pub fn get_pool_state(env: &Env, index: u32) -> Result<PoolState, ContractError> {
    let key = DataKey::PoolState(index);
    let state: PoolState = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(ContractError::PoolStateMissing)?;
    extend_persistent(env, &key);
    Ok(state)
}

pub fn set_pool_state(env: &Env, index: u32, state: &PoolState) {
    let key = DataKey::PoolState(index);
    env.storage().persistent().set(&key, state);
    extend_persistent(env, &key);
}

pub fn has_merkle_root(env: &Env, pool_index: u32) -> bool {
    env.storage()
        .persistent()
        .has(&DataKey::MerkleRoot(pool_index))
}

pub fn get_merkle_root(env: &Env, pool_index: u32) -> MerkleRootData {
    let key = DataKey::MerkleRoot(pool_index);
    let data: MerkleRootData = env.storage().persistent().get(&key).unwrap();
    extend_persistent(env, &key);
    data
}

pub fn set_merkle_root(env: &Env, pool_index: u32, data: &MerkleRootData) {
    let key = DataKey::MerkleRoot(pool_index);
    env.storage().persistent().set(&key, data);
    extend_persistent(env, &key);
}

pub fn has_staker(env: &Env, user: &Address, pool_index: u32) -> bool {
    env.storage()
        .persistent()
        .has(&DataKey::Staker(user.clone(), pool_index))
}

pub fn get_staker(env: &Env, user: &Address, pool_index: u32) -> StakerInfo {
    let key = DataKey::Staker(user.clone(), pool_index);
    let info: StakerInfo = env.storage().persistent().get(&key).unwrap();
    extend_persistent(env, &key);
    info
}

pub fn set_staker(env: &Env, user: &Address, pool_index: u32, info: &StakerInfo) {
    let key = DataKey::Staker(user.clone(), pool_index);
    env.storage().persistent().set(&key, info);
    extend_persistent(env, &key);
}

pub fn remove_staker(env: &Env, user: &Address, pool_index: u32) {
    let key = DataKey::Staker(user.clone(), pool_index);
    env.storage().persistent().remove(&key);
}

// --- Per-epoch frozen accumulator snapshots (H-1 fix) ---

pub fn set_epoch_end_acc(env: &Env, pool_index: u32, epoch_id: u64, acc: i128) {
    let key = DataKey::EpochEndAcc(pool_index, epoch_id);
    env.storage().persistent().set(&key, &acc);
    extend_persistent(env, &key);
}

pub fn get_epoch_end_acc(
    env: &Env,
    pool_index: u32,
    epoch_id: u64,
) -> Result<i128, ContractError> {
    let key = DataKey::EpochEndAcc(pool_index, epoch_id);
    let acc: i128 = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(ContractError::EpochSnapshotMissing)?;
    extend_persistent(env, &key);
    Ok(acc)
}

pub fn get_last_proven_epoch(env: &Env, user: &Address, pool_index: u32) -> u64 {
    let key = DataKey::LastProvenEpoch(user.clone(), pool_index);
    let v: u64 = env.storage().persistent().get(&key).unwrap_or(0);
    if v != 0 {
        extend_persistent(env, &key);
    }
    v
}

pub fn set_last_proven_epoch(env: &Env, user: &Address, pool_index: u32, epoch_id: u64) {
    let key = DataKey::LastProvenEpoch(user.clone(), pool_index);
    env.storage().persistent().set(&key, &epoch_id);
    extend_persistent(env, &key);
}

fn extend_persistent(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
}
