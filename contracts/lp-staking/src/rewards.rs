use soroban_sdk::{Env, U256};

use crate::errors::ContractError;
use crate::storage::{self, PoolState, StakerInfo};

/// Precision multiplier for accumulated reward per share (1e18).
pub const PRECISION: i128 = 1_000_000_000_000_000_000;

/// Hard ceiling on `acc_reward_per_share`.
///
/// Together with MAX_STAKE this keeps `stake * acc / PRECISION` provably inside
/// i128 forever: 1e21 * 1e35 / 1e18 = 1e38 < i128::MAX (~1.7e38). Accrual stops
/// at the ceiling instead of erroring, so the pool degrades gracefully rather
/// than wedging permanently (H-NEW-3) — which matters because there is no
/// upgrade path.
pub const MAX_ACC_REWARD_PER_SHARE: i128 = 100_000_000_000_000_000_000_000_000_000_000_000; // 1e35

/// floor(a * b / denom) via a 256-bit intermediate; a,b >= 0, denom > 0.
pub fn mul_div_floor(env: &Env, a: i128, b: i128, denom: i128) -> Result<i128, ContractError> {
    if a < 0 || b < 0 || denom <= 0 {
        return Err(ContractError::MathOverflow);
    }
    if a == 0 || b == 0 {
        return Ok(0);
    }
    let prod = U256::from_u128(env, a as u128)
        .checked_mul(&U256::from_u128(env, b as u128))
        .ok_or(ContractError::MathOverflow)?;
    let quot = prod
        .checked_div(&U256::from_u128(env, denom as u128))
        .ok_or(ContractError::MathOverflow)?;
    let out = quot.to_u128().ok_or(ContractError::MathOverflow)?;
    if out > i128::MAX as u128 {
        return Err(ContractError::MathOverflow);
    }
    Ok(out as i128)
}

/// Compute `(quotient, remainder)` of `(elapsed * rate * PRECISION + carry) / denom`
/// entirely in 256-bit space. The remainder is carried into the next update so
/// flooring cannot silently destroy emission across many small updates (M-NEW-2).
///
/// Returns `None` for the quotient when it would exceed i128, letting the caller
/// clamp to the accumulator ceiling rather than fail.
fn accrue(
    env: &Env,
    elapsed: i128,
    rate: i128,
    carry: i128,
    denom: i128,
) -> Result<(Option<i128>, i128), ContractError> {
    if elapsed <= 0 || rate <= 0 || denom <= 0 || carry < 0 {
        return Err(ContractError::MathOverflow);
    }
    let numer = U256::from_u128(env, elapsed as u128)
        .checked_mul(&U256::from_u128(env, rate as u128))
        .ok_or(ContractError::MathOverflow)?
        .checked_mul(&U256::from_u128(env, PRECISION as u128))
        .ok_or(ContractError::MathOverflow)?
        .checked_add(&U256::from_u128(env, carry as u128))
        .ok_or(ContractError::MathOverflow)?;

    let d = U256::from_u128(env, denom as u128);
    let quot = numer.checked_div(&d).ok_or(ContractError::MathOverflow)?;
    let rem = numer
        .checked_rem_euclid(&d)
        .ok_or(ContractError::MathOverflow)?;

    let rem_i = rem.to_u128().ok_or(ContractError::MathOverflow)? as i128;
    let quot_i = match quot.to_u128() {
        Some(q) if q <= i128::MAX as u128 => Some(q as i128),
        _ => None,
    };
    Ok((quot_i, rem_i))
}

/// Advance the pool's accumulator to the current ledger time and persist it.
///
/// The denominator is the CURRENT EPOCH'S authenticated `total_lp` from the
/// posted Merkle root — not `total_staked`. That is what stops stale positions
/// from diluting active stakers (H-NEW-2) and makes a staker's share exactly
/// `their_lp / total_lp`, matching the original Python bot.
///
/// Inactive pools do not accrue, and with no root posted there is no
/// denominator, so no accrual happens until the first epoch begins.
pub fn update_pool(env: &Env, pool_index: u32) -> Result<PoolState, ContractError> {
    let mut state = storage::get_pool_state(env, pool_index)?;
    let now = env.ledger().timestamp();

    if !state.active || now <= state.last_reward_time || state.reward_rate <= 0 {
        state.last_reward_time = now;
        storage::set_pool_state(env, pool_index, &state);
        return Ok(state);
    }

    let total_lp = current_total_lp(env, pool_index);
    if total_lp > 0 && state.acc_reward_per_share < MAX_ACC_REWARD_PER_SHARE {
        let elapsed = (now - state.last_reward_time) as i128;
        let (quot, rem) = accrue(
            env,
            elapsed,
            state.reward_rate,
            state.reward_remainder,
            total_lp,
        )?;
        match quot {
            Some(delta) => {
                let next = state
                    .acc_reward_per_share
                    .checked_add(delta)
                    .unwrap_or(MAX_ACC_REWARD_PER_SHARE);
                if next >= MAX_ACC_REWARD_PER_SHARE {
                    state.acc_reward_per_share = MAX_ACC_REWARD_PER_SHARE;
                    state.reward_remainder = 0;
                } else {
                    state.acc_reward_per_share = next;
                    state.reward_remainder = rem;
                }
            }
            None => {
                // Quotient beyond i128: clamp rather than wedge.
                state.acc_reward_per_share = MAX_ACC_REWARD_PER_SHARE;
                state.reward_remainder = 0;
            }
        }
    }

    state.last_reward_time = now;
    storage::set_pool_state(env, pool_index, &state);
    Ok(state)
}

/// The current epoch's reward denominator, or 0 when no root has been posted.
pub fn current_total_lp(env: &Env, pool_index: u32) -> i128 {
    if storage::has_merkle_root(env, pool_index) {
        storage::get_merkle_root(env, pool_index).total_lp
    } else {
        0
    }
}

/// Pending rewards settled against a CALLER-SUPPLIED accumulator.
///
/// The caller picks the accumulator: live for a current-epoch staker, or the
/// frozen `EpochEndAcc` snapshot for their own epoch if stale (H-1).
pub fn calculate_pending(
    env: &Env,
    acc_reward_per_share: i128,
    staker: &StakerInfo,
) -> Result<i128, ContractError> {
    if staker.staked_amount == 0 {
        return Ok(staker.pending_rewards);
    }

    let accumulated = mul_div_floor(env, staker.staked_amount, acc_reward_per_share, PRECISION)?;
    // Debt can exceed accumulated only via boundary rounding; never negative.
    let delta = if accumulated > staker.reward_debt {
        accumulated - staker.reward_debt
    } else {
        0
    };

    staker
        .pending_rewards
        .checked_add(delta)
        .ok_or(ContractError::MathOverflow)
}

/// Reward debt for a given stake at a given accumulator.
pub fn compute_reward_debt(
    env: &Env,
    staked_amount: i128,
    acc_reward_per_share: i128,
) -> Result<i128, ContractError> {
    mul_div_floor(env, staked_amount, acc_reward_per_share, PRECISION)
}

/// View-only: accumulator projected to now without writing storage.
pub fn simulate_acc_reward(env: &Env, pool_index: u32) -> Result<i128, ContractError> {
    let state = storage::get_pool_state(env, pool_index)?;
    let now = env.ledger().timestamp();

    if !state.active || now <= state.last_reward_time || state.reward_rate <= 0 {
        return Ok(state.acc_reward_per_share);
    }

    let total_lp = current_total_lp(env, pool_index);
    if total_lp <= 0 || state.acc_reward_per_share >= MAX_ACC_REWARD_PER_SHARE {
        return Ok(state.acc_reward_per_share);
    }

    let elapsed = (now - state.last_reward_time) as i128;
    let (quot, _) = accrue(
        env,
        elapsed,
        state.reward_rate,
        state.reward_remainder,
        total_lp,
    )?;
    Ok(match quot {
        Some(delta) => state
            .acc_reward_per_share
            .checked_add(delta)
            .unwrap_or(MAX_ACC_REWARD_PER_SHARE)
            .min(MAX_ACC_REWARD_PER_SHARE),
        None => MAX_ACC_REWARD_PER_SHARE,
    })
}
