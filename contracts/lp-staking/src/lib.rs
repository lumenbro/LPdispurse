#![no_std]

mod errors;
mod merkle;
mod rewards;
mod storage;

#[cfg(test)]
mod test;

use errors::ContractError;
use soroban_sdk::{contract, contractimpl, token, Address, BytesN, Env, Vec};
use storage::{MerkleRootData, PoolState, StakerInfo};

#[contract]
pub struct LpStakingContract;

#[contractimpl]
impl LpStakingContract {
    // ========== Admin Functions ==========

    /// One-time initialization.
    pub fn initialize(
        env: Env,
        admin: Address,
        lmnr_token: Address,
        reward_rate_per_sec: i128,
    ) -> Result<(), ContractError> {
        if storage::has_admin(&env) {
            return Err(ContractError::AlreadyInitialized);
        }

        storage::set_admin(&env, &admin);
        storage::set_lmnr_token(&env, &lmnr_token);
        storage::set_reward_rate(&env, reward_rate_per_sec);
        storage::set_pool_count(&env, 0);
        storage::extend_instance_ttl(&env);

        Ok(())
    }

    /// Register a new SDEX liquidity pool for staking.
    pub fn add_pool(env: Env, admin: Address, pool_id: BytesN<32>) -> Result<u32, ContractError> {
        Self::require_admin(&env, &admin)?;
        storage::extend_instance_ttl(&env);

        if storage::has_pool_id_index(&env, &pool_id) {
            return Err(ContractError::PoolAlreadyExists);
        }

        let index = storage::get_pool_count(&env);
        storage::set_pool_id(&env, index, &pool_id);
        storage::set_pool_id_index(&env, &pool_id, index);
        storage::set_pool_state(
            &env,
            index,
            &PoolState {
                acc_reward_per_share: 0,
                total_staked: 0,
                last_reward_time: env.ledger().timestamp(),
                prev_acc_reward_per_share: 0,
            },
        );
        storage::set_pool_count(&env, index + 1);

        Ok(index)
    }

    /// Deactivate a pool. Settles rewards first, then resets total_staked.
    /// Users can still claim pending rewards after removal.
    pub fn remove_pool(env: Env, admin: Address, pool_index: u32) -> Result<(), ContractError> {
        Self::require_admin(&env, &admin)?;
        Self::require_valid_pool(&env, pool_index)?;
        storage::extend_instance_ttl(&env);

        // Settle any accrued rewards before deactivation
        let mut state = rewards::update_pool(&env, pool_index);
        state.total_staked = 0;
        storage::set_pool_state(&env, pool_index, &state);

        Ok(())
    }

    /// Post a new Merkle root for a pool's LP snapshots.
    /// Resets total_staked — all users must re-prove to continue earning.
    pub fn set_merkle_root(
        env: Env,
        admin: Address,
        pool_index: u32,
        root: BytesN<32>,
        snapshot_ledger: u32,
    ) -> Result<(), ContractError> {
        Self::require_admin(&env, &admin)?;
        Self::require_valid_pool(&env, pool_index)?;
        storage::extend_instance_ttl(&env);

        // Settle rewards at current accumulator before resetting
        let mut state = rewards::update_pool(&env, pool_index);
        state.prev_acc_reward_per_share = state.acc_reward_per_share;
        state.total_staked = 0;
        storage::set_pool_state(&env, pool_index, &state);

        // Determine next epoch_id
        let epoch_id = if storage::has_merkle_root(&env, pool_index) {
            storage::get_merkle_root(&env, pool_index).epoch_id + 1
        } else {
            1
        };

        storage::set_merkle_root(
            &env,
            pool_index,
            &MerkleRootData {
                root,
                epoch_id,
                snapshot_ledger,
                posted_at: env.ledger().timestamp(),
            },
        );

        Ok(())
    }

    /// Update the global reward rate (LMNR stroops per second).
    /// Updates all active pools' accumulators before changing rate.
    pub fn set_reward_rate(
        env: Env,
        admin: Address,
        new_rate: i128,
    ) -> Result<(), ContractError> {
        Self::require_admin(&env, &admin)?;
        storage::extend_instance_ttl(&env);

        // Update all pools to current time before changing rate
        let pool_count = storage::get_pool_count(&env);
        for i in 0..pool_count {
            rewards::update_pool(&env, i);
        }

        storage::set_reward_rate(&env, new_rate);
        Ok(())
    }

    /// Transfer admin role to a new address.
    pub fn set_admin(env: Env, admin: Address, new_admin: Address) -> Result<(), ContractError> {
        Self::require_admin(&env, &admin)?;
        storage::extend_instance_ttl(&env);
        storage::set_admin(&env, &new_admin);
        Ok(())
    }

    /// Transfer LMNR into the contract for reward distribution.
    pub fn fund(env: Env, funder: Address, amount: i128) -> Result<(), ContractError> {
        if amount <= 0 {
            return Err(ContractError::InvalidAmount);
        }
        funder.require_auth();

        let lmnr_token = storage::get_lmnr_token(&env);
        let token_client = token::Client::new(&env, &lmnr_token);
        token_client.transfer(&funder, &env.current_contract_address(), &amount);
        storage::extend_instance_ttl(&env);

        Ok(())
    }

    // ========== User Functions ==========

    /// Prove LP position via Merkle proof and start earning rewards.
    pub fn stake(
        env: Env,
        user: Address,
        pool_index: u32,
        lp_balance: i128,
        proof: Vec<BytesN<32>>,
    ) -> Result<(), ContractError> {
        user.require_auth();
        Self::require_valid_pool(&env, pool_index)?;
        storage::extend_instance_ttl(&env);

        if lp_balance <= 0 {
            return Err(ContractError::InvalidAmount);
        }

        // Get current Merkle root
        if !storage::has_merkle_root(&env, pool_index) {
            return Err(ContractError::NoMerkleRoot);
        }
        let merkle_data = storage::get_merkle_root(&env, pool_index);

        // Verify Merkle proof
        let leaf = merkle::compute_leaf(&env, pool_index, &user, lp_balance, merkle_data.epoch_id);
        if !merkle::verify_proof(&env, &leaf, &proof, &merkle_data.root) {
            return Err(ContractError::InvalidProof);
        }

        // Update pool accumulator
        let state = rewards::update_pool(&env, pool_index);

        // Handle existing staker
        if storage::has_staker(&env, &user, pool_index) {
            let staker = storage::get_staker(&env, &user, pool_index);

            if staker.epoch_id == merkle_data.epoch_id && staker.staked_amount > 0 {
                return Err(ContractError::AlreadyStakedThisEpoch);
            }

            // Stale epoch — preserve pending rewards, re-stake with new proof
            let pending = if staker.epoch_id == merkle_data.epoch_id {
                rewards::calculate_pending(&state, &staker)
            } else {
                rewards::calculate_pending_stale(&state, &staker)
            };

            let new_debt = rewards::compute_reward_debt(lp_balance, state.acc_reward_per_share);
            storage::set_staker(
                &env,
                &user,
                pool_index,
                &StakerInfo {
                    staked_amount: lp_balance,
                    reward_debt: new_debt,
                    pending_rewards: pending,
                    epoch_id: merkle_data.epoch_id,
                },
            );
        } else {
            let new_debt = rewards::compute_reward_debt(lp_balance, state.acc_reward_per_share);
            storage::set_staker(
                &env,
                &user,
                pool_index,
                &StakerInfo {
                    staked_amount: lp_balance,
                    reward_debt: new_debt,
                    pending_rewards: 0,
                    epoch_id: merkle_data.epoch_id,
                },
            );
        }

        // Update pool total
        let mut updated_state = storage::get_pool_state(&env, pool_index);
        updated_state.total_staked += lp_balance;
        storage::set_pool_state(&env, pool_index, &updated_state);

        Ok(())
    }

    /// Claim accumulated LMNR rewards. Returns amount claimed.
    pub fn claim(env: Env, user: Address, pool_index: u32) -> Result<i128, ContractError> {
        user.require_auth();
        Self::require_valid_pool(&env, pool_index)?;
        storage::extend_instance_ttl(&env);

        if !storage::has_staker(&env, &user, pool_index) {
            return Err(ContractError::NoStakeFound);
        }

        let state = rewards::update_pool(&env, pool_index);
        let mut staker = storage::get_staker(&env, &user, pool_index);

        // Check if staker's epoch is current
        let is_current_epoch = storage::has_merkle_root(&env, pool_index) && {
            let merkle_data = storage::get_merkle_root(&env, pool_index);
            staker.epoch_id == merkle_data.epoch_id
        };

        let pending = if is_current_epoch {
            rewards::calculate_pending(&state, &staker)
        } else {
            rewards::calculate_pending_stale(&state, &staker)
        };

        if pending <= 0 {
            return Err(ContractError::NoRewardsToClaim);
        }

        // Transfer LMNR to user
        let lmnr_token = storage::get_lmnr_token(&env);
        let token_client = token::Client::new(&env, &lmnr_token);

        let contract_balance = token_client.balance(&env.current_contract_address());
        if contract_balance < pending {
            return Err(ContractError::InsufficientRewardBalance);
        }

        token_client.transfer(&env.current_contract_address(), &user, &pending);

        // Update staker state
        if is_current_epoch {
            staker.reward_debt =
                rewards::compute_reward_debt(staker.staked_amount, state.acc_reward_per_share);
            staker.pending_rewards = 0;
        } else {
            staker.pending_rewards = 0;
        }

        storage::set_staker(&env, &user, pool_index, &staker);

        Ok(pending)
    }

    /// Stop earning rewards. Pending rewards are preserved for later claiming.
    pub fn unstake(env: Env, user: Address, pool_index: u32) -> Result<(), ContractError> {
        user.require_auth();
        Self::require_valid_pool(&env, pool_index)?;
        storage::extend_instance_ttl(&env);

        if !storage::has_staker(&env, &user, pool_index) {
            return Err(ContractError::NoStakeFound);
        }

        let state = rewards::update_pool(&env, pool_index);
        let staker = storage::get_staker(&env, &user, pool_index);

        // Check if staker's epoch is current for reward calculation
        let is_current_epoch = storage::has_merkle_root(&env, pool_index) && {
            let merkle_data = storage::get_merkle_root(&env, pool_index);
            staker.epoch_id == merkle_data.epoch_id
        };

        let pending = if is_current_epoch {
            rewards::calculate_pending(&state, &staker)
        } else {
            rewards::calculate_pending_stale(&state, &staker)
        };

        // Remove from pool total if still in current epoch
        if is_current_epoch && staker.staked_amount > 0 {
            let mut updated_state = storage::get_pool_state(&env, pool_index);
            updated_state.total_staked -= staker.staked_amount;
            storage::set_pool_state(&env, pool_index, &updated_state);
        }

        if pending > 0 {
            // Keep staker record with zero stake but pending rewards
            storage::set_staker(
                &env,
                &user,
                pool_index,
                &StakerInfo {
                    staked_amount: 0,
                    reward_debt: 0,
                    pending_rewards: pending,
                    epoch_id: staker.epoch_id,
                },
            );
        } else {
            storage::remove_staker(&env, &user, pool_index);
        }

        Ok(())
    }

    // ========== View Functions ==========

    /// Query unclaimed rewards for a user in a pool.
    pub fn pending_reward(env: Env, user: Address, pool_index: u32) -> i128 {
        if !storage::has_staker(&env, &user, pool_index) {
            return 0;
        }

        let staker = storage::get_staker(&env, &user, pool_index);

        let is_current_epoch = storage::has_merkle_root(&env, pool_index) && {
            let merkle_data = storage::get_merkle_root(&env, pool_index);
            staker.epoch_id == merkle_data.epoch_id
        };

        if !is_current_epoch {
            let state = storage::get_pool_state(&env, pool_index);
            return rewards::calculate_pending_stale(&state, &staker);
        }

        let simulated_acc = rewards::simulate_acc_reward(&env, pool_index);
        let accumulated = (staker.staked_amount * simulated_acc) / 1_000_000_000_000_000_000i128;
        let pending = accumulated - staker.reward_debt;
        staker.pending_rewards + pending
    }

    /// Query stake details for a user.
    pub fn get_staker_info(env: Env, user: Address, pool_index: u32) -> StakerInfo {
        storage::get_staker(&env, &user, pool_index)
    }

    /// Query pool accumulator state.
    pub fn get_pool_state(env: Env, pool_index: u32) -> PoolState {
        storage::get_pool_state(&env, pool_index)
    }

    /// Query current epoch Merkle root for a pool.
    pub fn get_merkle_root(env: Env, pool_index: u32) -> MerkleRootData {
        storage::get_merkle_root(&env, pool_index)
    }

    /// Number of registered pools.
    pub fn get_pool_count(env: Env) -> u32 {
        storage::get_pool_count(&env)
    }

    /// Pool hash at a given index.
    pub fn get_pool_id(env: Env, pool_index: u32) -> BytesN<32> {
        storage::get_pool_id(&env, pool_index)
    }

    /// Contract's LMNR balance available for rewards.
    pub fn reward_balance(env: Env) -> i128 {
        let lmnr_token = storage::get_lmnr_token(&env);
        let token_client = token::Client::new(&env, &lmnr_token);
        token_client.balance(&env.current_contract_address())
    }

    // ========== Internal Helpers ==========

    fn require_admin(env: &Env, caller: &Address) -> Result<(), ContractError> {
        caller.require_auth();
        let admin = storage::get_admin(env);
        if *caller != admin {
            return Err(ContractError::Unauthorized);
        }
        Ok(())
    }

    fn require_valid_pool(env: &Env, pool_index: u32) -> Result<(), ContractError> {
        let count = storage::get_pool_count(env);
        if pool_index >= count {
            return Err(ContractError::PoolNotFound);
        }
        Ok(())
    }
}
