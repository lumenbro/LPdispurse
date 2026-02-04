use soroban_sdk::{contracttype, Address, BytesN, Env};

// Storage TTL constants (in ledgers, ~5 seconds each)
const INSTANCE_TTL_THRESHOLD: u32 = 17_280; // ~1 day
const INSTANCE_TTL_EXTEND: u32 = 518_400; // ~30 days
const PERSISTENT_TTL_THRESHOLD: u32 = 17_280; // ~1 day
const PERSISTENT_TTL_EXTEND: u32 = 518_400; // ~30 days

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    LmnrToken,
    RewardRatePerSec,
    PoolCount,
    PoolId(u32),
    PoolIdIndex(BytesN<32>),
    PoolState(u32),
    MerkleRoot(u32),
    Staker(Address, u32),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PoolState {
    pub acc_reward_per_share: i128,
    pub total_staked: i128,
    pub last_reward_time: u64,
    pub prev_acc_reward_per_share: i128, // Accumulator snapshot at last epoch change
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MerkleRootData {
    pub root: BytesN<32>,
    pub epoch_id: u64,
    pub snapshot_ledger: u32,
    pub posted_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StakerInfo {
    pub staked_amount: i128,
    pub reward_debt: i128,
    pub pending_rewards: i128,
    pub epoch_id: u64,
}

// --- Instance storage helpers (Admin, LmnrToken, RewardRate, PoolCount) ---

pub fn has_admin(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::Admin)
}

pub fn get_admin(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Admin).unwrap()
}

pub fn set_admin(env: &Env, admin: &Address) {
    env.storage().instance().set(&DataKey::Admin, admin);
}

pub fn get_lmnr_token(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::LmnrToken).unwrap()
}

pub fn set_lmnr_token(env: &Env, token: &Address) {
    env.storage().instance().set(&DataKey::LmnrToken, token);
}

pub fn get_reward_rate(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::RewardRatePerSec)
        .unwrap_or(0)
}

pub fn set_reward_rate(env: &Env, rate: i128) {
    env.storage()
        .instance()
        .set(&DataKey::RewardRatePerSec, &rate);
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

pub fn extend_instance_ttl(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
}

// --- Persistent storage helpers (PoolId, PoolState, MerkleRoot, Staker) ---

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

pub fn get_pool_id_index(env: &Env, pool_id: &BytesN<32>) -> u32 {
    let key = DataKey::PoolIdIndex(pool_id.clone());
    env.storage().persistent().get(&key).unwrap()
}

pub fn set_pool_id_index(env: &Env, pool_id: &BytesN<32>, index: u32) {
    let key = DataKey::PoolIdIndex(pool_id.clone());
    env.storage().persistent().set(&key, &index);
    extend_persistent(env, &key);
}

pub fn get_pool_state(env: &Env, index: u32) -> PoolState {
    let key = DataKey::PoolState(index);
    let state: PoolState = env.storage().persistent().get(&key).unwrap_or(PoolState {
        acc_reward_per_share: 0,
        total_staked: 0,
        last_reward_time: 0,
        prev_acc_reward_per_share: 0,
    });
    extend_persistent(env, &key);
    state
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

fn extend_persistent(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
}
