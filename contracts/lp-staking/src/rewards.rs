use soroban_sdk::Env;

use crate::storage::{self, PoolState, StakerInfo};

/// Precision multiplier for accumulated reward per share (1e18).
const PRECISION: i128 = 1_000_000_000_000_000_000;

/// Update the pool's accumulated reward per share to the current time.
/// Returns the updated PoolState.
pub fn update_pool(env: &Env, pool_index: u32) -> PoolState {
    let mut state = storage::get_pool_state(env, pool_index);
    let now = env.ledger().timestamp();
    let reward_rate = storage::get_reward_rate(env);

    if now > state.last_reward_time && state.total_staked > 0 && reward_rate > 0 {
        let elapsed = (now - state.last_reward_time) as i128;
        let new_rewards = elapsed * reward_rate;
        state.acc_reward_per_share += (new_rewards * PRECISION) / state.total_staked;
    }

    state.last_reward_time = now;
    storage::set_pool_state(env, pool_index, &state);
    state
}

/// Calculate pending rewards for a staker based on the current pool state.
/// Does NOT update pool state — caller must call update_pool first.
pub fn calculate_pending(pool_state: &PoolState, staker: &StakerInfo) -> i128 {
    if staker.staked_amount == 0 {
        return staker.pending_rewards;
    }

    let accumulated = (staker.staked_amount * pool_state.acc_reward_per_share) / PRECISION;
    let pending = accumulated - staker.reward_debt;
    staker.pending_rewards + pending
}

/// View-only: simulate the accumulated reward per share at the current time
/// without writing to storage. Used for pending_reward queries.
pub fn simulate_acc_reward(env: &Env, pool_index: u32) -> i128 {
    let state = storage::get_pool_state(env, pool_index);
    let now = env.ledger().timestamp();
    let reward_rate = storage::get_reward_rate(env);

    let mut acc = state.acc_reward_per_share;
    if now > state.last_reward_time && state.total_staked > 0 && reward_rate > 0 {
        let elapsed = (now - state.last_reward_time) as i128;
        let new_rewards = elapsed * reward_rate;
        acc += (new_rewards * PRECISION) / state.total_staked;
    }
    acc
}

/// Calculate pending rewards for a stale staker using the previous epoch's accumulator snapshot.
/// Stale stakers earned rewards up to the epoch change but not after.
pub fn calculate_pending_stale(pool_state: &PoolState, staker: &StakerInfo) -> i128 {
    if staker.staked_amount == 0 {
        return staker.pending_rewards;
    }

    let accumulated =
        (staker.staked_amount * pool_state.prev_acc_reward_per_share) / PRECISION;
    let pending = accumulated - staker.reward_debt;
    staker.pending_rewards + pending
}

/// Compute the reward_debt for a staker given their staked amount and current accumulator.
pub fn compute_reward_debt(staked_amount: i128, acc_reward_per_share: i128) -> i128 {
    (staked_amount * acc_reward_per_share) / PRECISION
}
