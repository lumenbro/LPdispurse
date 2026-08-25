#![no_std]

//! LP staking rewards distributor (v2).
//!
//! NON-CUSTODIAL: users never deposit LP tokens. They prove an LP position with
//! a Merkle proof against an admin-posted per-epoch root; their LP stays in
//! their own wallet. The only value held by this contract is the reward pool
//! that the admin funds and stakers claim from.
//!
//! NON-UPGRADEABLE by design: there is deliberately no `upgrade` entry point.
//! An upgradeable WASM would let a compromised admin swap in code that adds
//! hostile sub-invocations to a user's `claim` authorization. Because nothing
//! is locked in this contract, migration is cheap: deploy a new instance,
//! `withdraw` the reward pool, re-fund, and have users re-prove.
//!
//! `withdraw` deliberately performs NO accumulator math, so an arithmetic fault
//! in the reward path can never strand the reward pool.

mod errors;
mod events;
mod merkle;
mod rewards;
mod storage;

#[cfg(test)]
mod test;

use errors::ContractError;
use soroban_sdk::{contract, contractimpl, token, Address, BytesN, Env, Vec};
use storage::{MerkleRootData, PoolState, StakerInfo};

/// Upper bound on a pool's emission rate, in reward-token stroops per second.
/// 1e12 stroops/sec is ~100,000 tokens/sec at 7 decimals — far above any real
/// configuration. Together with MIN_STAKE this keeps the accumulator provably
/// inside i128 (H-4), so a bad rate can never wedge the contract.
pub const MAX_REWARD_RATE: i128 = 1_000_000_000_000;

/// Minimum non-zero stake (1.0 unit at 7 decimals). Also the floor for an
/// epoch's `total_lp`, bounding how fast the accumulator can climb.
pub const MIN_STAKE: i128 = 10_000_000;

/// Maximum accepted stake / epoch total_lp (1e21 stroops = 1e14 tokens at 7
/// decimals, far above any real LP supply).
///
/// Without this, a stake could be accepted while `stake * acc / PRECISION` still
/// fit i128 and then become permanently unsettleable as the accumulator grew —
/// bricking claim/unstake/update_stake for that record forever (H-NEW-3). With
/// MAX_STAKE and rewards::MAX_ACC_REWARD_PER_SHARE the product is provably
/// bounded: 1e21 * 1e35 / 1e18 = 1e38 < i128::MAX.
pub const MAX_STAKE: i128 = 1_000_000_000_000_000_000_000;

/// Reject snapshots older than ~7 days (at ~5s/ledger).
pub const MAX_SNAPSHOT_AGE: u32 = 120_960;

#[contract]
pub struct LpStakingContract;

#[contractimpl]
impl LpStakingContract {
    // ========== Construction ==========

    /// Atomic initialization at deploy time (C-1). There is no separate
    /// `initialize`, so there is no window in which a third party can claim
    /// admin of a freshly deployed instance.
    pub fn __constructor(env: Env, admin: Address, operator: Address, lmnr_token: Address) {
        storage::set_admin(&env, &admin);
        storage::set_operator(&env, &operator);
        storage::set_lmnr_token(&env, &lmnr_token);
        storage::set_pool_count(&env, 0);
        storage::extend_instance_ttl(&env);
    }

    // ========== Admin: pools ==========

    /// Register a new SDEX liquidity pool with its own emission rate.
    pub fn add_pool(
        env: Env,
        admin: Address,
        pool_id: BytesN<32>,
        reward_rate: i128,
    ) -> Result<u32, ContractError> {
        Self::require_admin(&env, &admin)?;
        storage::extend_instance_ttl(&env);
        Self::require_valid_rate(reward_rate)?;

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
                reward_rate,
                reward_remainder: 0,
                active: true,
            },
        );
        storage::set_pool_count(&env, index + 1);
        Self::bump_emission_total(&env, 0, reward_rate)?;

        events::PoolAdded {
            pool_index: index,
            pool_id,
            reward_rate,
        }
        .publish(&env);

        Ok(index)
    }

    /// Deactivate a pool: settles accrual, then stops it permanently.
    ///
    /// Unlike v1 this does NOT zero `total_staked` (which corrupted accounting
    /// and could go negative) and the pool cannot be silently reactivated by a
    /// new staker — H-2. Existing stakers may still `claim` and `unstake`.
    pub fn remove_pool(env: Env, admin: Address, pool_index: u32) -> Result<(), ContractError> {
        Self::require_admin(&env, &admin)?;
        Self::require_valid_pool(&env, pool_index)?;
        storage::extend_instance_ttl(&env);

        let mut state = rewards::update_pool(&env, pool_index)?;
        if !state.active {
            return Err(ContractError::PoolInactive);
        }
        state.active = false;
        let freed_rate = state.reward_rate;
        storage::set_pool_state(&env, pool_index, &state);
        Self::bump_emission_total(&env, freed_rate, 0)?;

        events::PoolRemoved { pool_index }.publish(&env);
        Ok(())
    }

    /// Set one pool's emission rate. Settles only that pool, so the cost is
    /// bounded regardless of how many pools exist (no all-pool loop — M-5).
    pub fn set_pool_rate(
        env: Env,
        admin: Address,
        pool_index: u32,
        new_rate: i128,
    ) -> Result<(), ContractError> {
        Self::require_admin(&env, &admin)?;
        Self::require_valid_pool(&env, pool_index)?;
        storage::extend_instance_ttl(&env);
        Self::require_valid_rate(new_rate)?;

        let mut state = rewards::update_pool(&env, pool_index)?;
        if !state.active {
            return Err(ContractError::PoolInactive);
        }
        let old_rate = state.reward_rate;
        state.reward_rate = new_rate;
        storage::set_pool_state(&env, pool_index, &state);
        Self::bump_emission_total(&env, old_rate, new_rate)?;

        events::RateChanged {
            pool_index,
            old_rate,
            new_rate,
        }
        .publish(&env);
        Ok(())
    }

    /// Post a new Merkle root, starting the next epoch for this pool.
    ///
    /// Before advancing, the current accumulator is frozen into
    /// `EpochEndAcc(pool, ending_epoch)`. Stale stakers settle against their own
    /// epoch's frozen value forever after — the H-1 fix.
    pub fn set_merkle_root(
        env: Env,
        admin: Address,
        pool_index: u32,
        root: BytesN<32>,
        snapshot_ledger: u32,
        total_lp: i128,
    ) -> Result<(), ContractError> {
        Self::require_admin(&env, &admin)?;
        Self::require_active_pool(&env, pool_index)?;
        storage::extend_instance_ttl(&env);

        if total_lp < MIN_STAKE || total_lp > MAX_STAKE {
            return Err(ContractError::InvalidTotalLp);
        }

        // Freshness, not just monotonicity (M-NEW-1). A snapshot in the future
        // could otherwise be accepted once and permanently lock out every
        // future root — unrecoverable on a non-upgradeable contract.
        let current_ledger = env.ledger().sequence();
        if snapshot_ledger > current_ledger {
            return Err(ContractError::InvalidSnapshotLedger);
        }
        if current_ledger - snapshot_ledger > MAX_SNAPSHOT_AGE {
            return Err(ContractError::InvalidSnapshotLedger);
        }

        let has_root = storage::has_merkle_root(&env, pool_index);
        let ending_epoch = if has_root {
            let prev = storage::get_merkle_root(&env, pool_index);
            if snapshot_ledger <= prev.snapshot_ledger {
                return Err(ContractError::StaleSnapshotLedger);
            }
            prev.epoch_id
        } else {
            // Pre-first-root stakers (created via update_stake) carry epoch 0,
            // so epoch 0 also needs a frozen snapshot.
            0
        };

        let mut state = rewards::update_pool(&env, pool_index)?;
        storage::set_epoch_end_acc(&env, pool_index, ending_epoch, state.acc_reward_per_share);

        // The carried remainder is a numerator scaled by the OLD total_lp.
        // Keeping it across a denominator change would silently re-scale it
        // (L-R2-1), so drop it at the epoch boundary. The discarded amount is
        // less than one ACCUMULATOR unit, i.e. under `total_lp / PRECISION`
        // reward stroops (< ~1000 stroops at the maximum total_lp) — small, but
        // it accumulates linearly with root cadence, so keep roots infrequent
        // and track the cumulative dust budget off-chain.
        if state.reward_remainder != 0 {
            state.reward_remainder = 0;
            storage::set_pool_state(&env, pool_index, &state);
        }

        let epoch_id = ending_epoch + 1;
        storage::set_merkle_root(
            &env,
            pool_index,
            &MerkleRootData {
                root: root.clone(),
                epoch_id,
                snapshot_ledger,
                posted_at: env.ledger().timestamp(),
                total_lp,
            },
        );

        events::RootPosted {
            pool_index,
            epoch_id,
            root,
            snapshot_ledger,
            total_lp,
        }
        .publish(&env);
        Ok(())
    }

    // ========== Admin: roles & treasury ==========

    /// Step 1 of a two-step admin handover (L-4): nominate a successor.
    pub fn propose_admin(
        env: Env,
        admin: Address,
        new_admin: Address,
    ) -> Result<(), ContractError> {
        Self::require_admin(&env, &admin)?;
        storage::extend_instance_ttl(&env);
        storage::set_pending_admin(&env, &new_admin);

        events::AdminProposed {
            pending_admin: new_admin,
        }
        .publish(&env);
        Ok(())
    }

    /// Step 2: the nominee accepts. A typo'd or unusable address can never take
    /// the admin role, because it must prove it can sign.
    pub fn accept_admin(env: Env, new_admin: Address) -> Result<(), ContractError> {
        new_admin.require_auth();
        storage::extend_instance_ttl(&env);

        let pending = storage::get_pending_admin(&env).ok_or(ContractError::NoPendingAdmin)?;
        if pending != new_admin {
            return Err(ContractError::NoPendingAdmin);
        }

        let old_admin = storage::get_admin(&env);
        storage::set_admin(&env, &new_admin);
        storage::remove_pending_admin(&env);

        events::AdminTransferred {
            old_admin,
            new_admin,
        }
        .publish(&env);
        Ok(())
    }

    /// Set the minimal-privilege operator (the reconciliation cron key). The
    /// operator may ONLY call `update_stake` — never withdraw, rates, or roots.
    pub fn set_operator(
        env: Env,
        admin: Address,
        new_operator: Address,
    ) -> Result<(), ContractError> {
        Self::require_admin(&env, &admin)?;
        storage::extend_instance_ttl(&env);
        let old_operator = storage::get_operator(&env);
        storage::set_operator(&env, &new_operator);

        events::OperatorChanged {
            old_operator,
            new_operator,
        }
        .publish(&env);
        Ok(())
    }

    /// Swap the reward token. Pending rewards are denominated in whatever token
    /// is configured at claim time, so settle/withdraw before changing this.
    pub fn set_lmnr_token(
        env: Env,
        admin: Address,
        new_token: Address,
    ) -> Result<(), ContractError> {
        Self::require_admin(&env, &admin)?;
        storage::extend_instance_ttl(&env);
        let old_token = storage::get_lmnr_token(&env);
        storage::set_lmnr_token(&env, &new_token);

        events::RewardTokenChanged {
            old_token,
            new_token,
        }
        .publish(&env);
        Ok(())
    }

    /// Withdraw reward tokens.
    ///
    /// Deliberately performs NO accumulator math: this is the guaranteed
    /// fund-recovery path even if the reward accounting ever faults.
    pub fn withdraw(env: Env, admin: Address, amount: i128) -> Result<(), ContractError> {
        Self::require_admin(&env, &admin)?;
        storage::extend_instance_ttl(&env);

        if amount <= 0 {
            return Err(ContractError::InvalidAmount);
        }

        let lmnr_token = storage::get_lmnr_token(&env);
        let token_client = token::Client::new(&env, &lmnr_token);

        let contract_balance = token_client.balance(&env.current_contract_address());
        if contract_balance < amount {
            return Err(ContractError::InsufficientRewardBalance);
        }

        token_client.transfer(&env.current_contract_address(), &admin, &amount);

        events::Withdrawn {
            admin,
            amount,
        }
        .publish(&env);
        Ok(())
    }

    /// EMERGENCY: delete a staker record without touching reward math.
    ///
    /// Deliberately calls neither `update_pool` nor `calculate_pending`, so it
    /// stays reachable even if a record or pool has been driven into an
    /// unsettleable arithmetic state. On a non-upgradeable contract this is the
    /// only way to repair a poisoned record, so it must never depend on the
    /// machinery that could be broken. Forfeits that user's pending rewards —
    /// admin-only, last resort.
    pub fn admin_force_clear_stake(
        env: Env,
        admin: Address,
        user: Address,
        pool_index: u32,
    ) -> Result<(), ContractError> {
        Self::require_admin(&env, &admin)?;
        storage::extend_instance_ttl(&env);

        if !storage::has_staker(&env, &user, pool_index) {
            return Err(ContractError::NoStakeFound);
        }
        let staker = storage::get_staker(&env, &user, pool_index);
        storage::remove_staker(&env, &user, pool_index);

        // Saturating so a corrupt amount can never block the repair.
        if let Ok(mut state) = storage::get_pool_state(&env, pool_index) {
            state.total_staked = state.total_staked.saturating_sub(staker.staked_amount);
            if state.total_staked < 0 {
                state.total_staked = 0;
            }
            storage::set_pool_state(&env, pool_index, &state);
        }

        events::StakeUpdated {
            user,
            pool_index,
            old_amount: staker.staked_amount,
            new_amount: 0,
            epoch_id: staker.epoch_id,
            by_admin: true,
        }
        .publish(&env);
        Ok(())
    }

    /// Transfer reward tokens into the contract.
    pub fn fund(env: Env, funder: Address, amount: i128) -> Result<(), ContractError> {
        if amount <= 0 {
            return Err(ContractError::InvalidAmount);
        }
        funder.require_auth();

        let lmnr_token = storage::get_lmnr_token(&env);
        let token_client = token::Client::new(&env, &lmnr_token);
        token_client.transfer(&funder, &env.current_contract_address(), &amount);
        storage::extend_instance_ttl(&env);

        events::Funded {
            funder,
            amount,
        }
        .publish(&env);
        Ok(())
    }

    // ========== Operator ==========

    /// Reconcile a staker's balance downward without a Merkle proof.
    ///
    /// The OPERATOR (cron) may only DECREASE an existing stake — it can never
    /// create a record or raise an amount. Increases require a Merkle proof via
    /// `stake`. Without this restriction a compromised cron key could fabricate
    /// a huge stake for an address it controls and drain the reward pool through
    /// `claim`, which would be economic custody rather than minimal privilege
    /// (H-NEW-1). The admin retains full reconciliation.
    pub fn update_stake(
        env: Env,
        caller: Address,
        user: Address,
        pool_index: u32,
        new_amount: i128,
    ) -> Result<(), ContractError> {
        let is_admin = Self::require_operator_or_admin(&env, &caller)?;
        Self::require_valid_pool(&env, pool_index)?;
        storage::extend_instance_ttl(&env);

        if new_amount < 0 {
            return Err(ContractError::InvalidAmount);
        }
        if new_amount > 0 && new_amount < MIN_STAKE {
            return Err(ContractError::StakeBelowMinimum);
        }
        if new_amount > MAX_STAKE {
            return Err(ContractError::StakeAboveMaximum);
        }

        if !is_admin {
            // Operator: decrease-only, existing records only.
            if !storage::has_staker(&env, &user, pool_index) {
                return Err(ContractError::OperatorCannotIncrease);
            }
            let existing = storage::get_staker(&env, &user, pool_index);
            if new_amount > existing.staked_amount {
                return Err(ContractError::OperatorCannotIncrease);
            }
        }

        let state = rewards::update_pool(&env, pool_index)?;
        let current_epoch_id = Self::current_epoch_id(&env, pool_index);

        if storage::has_staker(&env, &user, pool_index) {
            let staker = storage::get_staker(&env, &user, pool_index);
            let settle_acc = Self::settlement_acc(&env, pool_index, &state, &staker)?;
            let pending = rewards::calculate_pending(&env, settle_acc, &staker)?;

            let old_amount = staker.staked_amount;

            // An OPERATOR reconciliation must never change which epoch a record
            // belongs to. Otherwise setting a stale stake to an equal or barely
            // lower amount would move it into the current epoch and re-base its
            // debt on the LIVE accumulator, restarting accrual with no Merkle
            // proof — the decrease-only check alone does not stop that (H-R2-1).
            // Settling against `settle_acc` keeps a stale record stale.
            let (record_epoch, debt_acc) = if is_admin {
                (current_epoch_id, state.acc_reward_per_share)
            } else {
                (staker.epoch_id, settle_acc)
            };
            let new_debt = rewards::compute_reward_debt(&env, new_amount, debt_acc)?;

            if new_amount == 0 && pending == 0 {
                // Don't leave a zero tombstone behind (L-R2-2).
                storage::remove_staker(&env, &user, pool_index);
            } else {
                storage::set_staker(
                    &env,
                    &user,
                    pool_index,
                    &StakerInfo {
                        staked_amount: new_amount,
                        reward_debt: new_debt,
                        pending_rewards: pending,
                        epoch_id: record_epoch,
                    },
                );
            }

            let mut updated = storage::get_pool_state(&env, pool_index)?;
            updated.total_staked = updated
                .total_staked
                .checked_sub(old_amount)
                .and_then(|v| v.checked_add(new_amount))
                .ok_or(ContractError::MathOverflow)?;
            if updated.total_staked < 0 {
                return Err(ContractError::MathOverflow);
            }
            storage::set_pool_state(&env, pool_index, &updated);

            events::StakeUpdated {
                user,
                pool_index,
                old_amount,
                new_amount,
                epoch_id: record_epoch,
                by_admin: is_admin,
            }
            .publish(&env);
        } else if new_amount > 0 {
            let new_debt = rewards::compute_reward_debt(
                &env,
                new_amount,
                state.acc_reward_per_share,
            )?;
            storage::set_staker(
                &env,
                &user,
                pool_index,
                &StakerInfo {
                    staked_amount: new_amount,
                    reward_debt: new_debt,
                    pending_rewards: 0,
                    epoch_id: current_epoch_id,
                },
            );

            let mut updated = storage::get_pool_state(&env, pool_index)?;
            updated.total_staked = updated
                .total_staked
                .checked_add(new_amount)
                .ok_or(ContractError::MathOverflow)?;
            storage::set_pool_state(&env, pool_index, &updated);

            events::StakeUpdated {
                user,
                pool_index,
                old_amount: 0,
                new_amount,
                epoch_id: current_epoch_id,
                by_admin: is_admin,
            }
            .publish(&env);
        }
        // new_amount == 0 for a non-existent staker: no-op.

        Ok(())
    }

    // ========== User ==========

    /// Prove an LP position via Merkle proof and begin earning.
    pub fn stake(
        env: Env,
        user: Address,
        pool_index: u32,
        lp_balance: i128,
        proof: Vec<BytesN<32>>,
    ) -> Result<(), ContractError> {
        user.require_auth();
        Self::require_active_pool(&env, pool_index)?;
        storage::extend_instance_ttl(&env);

        if lp_balance <= 0 {
            return Err(ContractError::InvalidAmount);
        }
        if lp_balance < MIN_STAKE {
            return Err(ContractError::StakeBelowMinimum);
        }
        if lp_balance > MAX_STAKE {
            return Err(ContractError::StakeAboveMaximum);
        }
        if proof.len() > merkle::MAX_PROOF_LEN {
            return Err(ContractError::ProofTooLong);
        }

        if !storage::has_merkle_root(&env, pool_index) {
            return Err(ContractError::NoMerkleRoot);
        }
        let merkle_data = storage::get_merkle_root(&env, pool_index);
        // A single staker can never exceed the epoch's declared LP total.
        if lp_balance > merkle_data.total_lp {
            return Err(ContractError::StakeExceedsTotalLp);
        }
        let pool_id = storage::get_pool_id(&env, pool_index);

        let leaf = merkle::compute_leaf(
            &env,
            pool_index,
            &pool_id,
            &user,
            lp_balance,
            merkle_data.epoch_id,
        );
        if !merkle::verify_proof(&env, &leaf, &proof, &merkle_data.root) {
            return Err(ContractError::InvalidProof);
        }

        // Authoritative replay guard. A proof is spent once per epoch, tracked
        // independently of StakerInfo — which can be zeroed by an operator
        // reconciliation, an unstake, or a claim. Checking `staked_amount > 0`
        // on the staker record alone would let a user restore a superseded
        // balance by replaying the same current-epoch proof.
        if storage::get_last_proven_epoch(&env, &user, pool_index) == merkle_data.epoch_id {
            return Err(ContractError::AlreadyStakedThisEpoch);
        }

        let state = rewards::update_pool(&env, pool_index)?;

        let old_staked_amount = if storage::has_staker(&env, &user, pool_index) {
            let staker = storage::get_staker(&env, &user, pool_index);

            let settle_acc = Self::settlement_acc(&env, pool_index, &state, &staker)?;
            let pending = rewards::calculate_pending(&env, settle_acc, &staker)?;

            let new_debt =
                rewards::compute_reward_debt(&env, lp_balance, state.acc_reward_per_share)?;
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

            staker.staked_amount
        } else {
            let new_debt =
                rewards::compute_reward_debt(&env, lp_balance, state.acc_reward_per_share)?;
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
            0
        };

        let mut updated = storage::get_pool_state(&env, pool_index)?;
        updated.total_staked = updated
            .total_staked
            .checked_sub(old_staked_amount)
            .and_then(|v| v.checked_add(lp_balance))
            .ok_or(ContractError::MathOverflow)?;
        if updated.total_staked < 0 {
            return Err(ContractError::MathOverflow);
        }
        storage::set_pool_state(&env, pool_index, &updated);
        storage::set_last_proven_epoch(&env, &user, pool_index, merkle_data.epoch_id);

        events::Staked {
            user,
            pool_index,
            amount: lp_balance,
            epoch_id: merkle_data.epoch_id,
        }
        .publish(&env);
        Ok(())
    }

    /// Claim accrued rewards. Allowed even on a deactivated pool so users can
    /// always exit.
    pub fn claim(env: Env, user: Address, pool_index: u32) -> Result<i128, ContractError> {
        user.require_auth();
        Self::require_valid_pool(&env, pool_index)?;
        storage::extend_instance_ttl(&env);

        if !storage::has_staker(&env, &user, pool_index) {
            return Err(ContractError::NoStakeFound);
        }

        // Fast path (L-NEW-2): a fully-unstaked user's rewards are already
        // crystallised, so paying them must not depend on pool accumulator or
        // epoch-snapshot state that could be faulted.
        let existing = storage::get_staker(&env, &user, pool_index);
        if existing.staked_amount == 0 {
            let pending = existing.pending_rewards;
            if pending <= 0 {
                return Err(ContractError::NoRewardsToClaim);
            }
            let lmnr_token = storage::get_lmnr_token(&env);
            let token_client = token::Client::new(&env, &lmnr_token);
            if token_client.balance(&env.current_contract_address()) < pending {
                return Err(ContractError::InsufficientRewardBalance);
            }
            storage::remove_staker(&env, &user, pool_index);
            token_client.transfer(&env.current_contract_address(), &user, &pending);
            events::Claimed {
                user,
                pool_index,
                amount: pending,
            }
            .publish(&env);
            return Ok(pending);
        }

        let state = rewards::update_pool(&env, pool_index)?;
        let mut staker = storage::get_staker(&env, &user, pool_index);

        let settle_acc = Self::settlement_acc(&env, pool_index, &state, &staker)?;
        let pending = rewards::calculate_pending(&env, settle_acc, &staker)?;

        if pending <= 0 {
            return Err(ContractError::NoRewardsToClaim);
        }

        let lmnr_token = storage::get_lmnr_token(&env);
        let token_client = token::Client::new(&env, &lmnr_token);

        let contract_balance = token_client.balance(&env.current_contract_address());
        if contract_balance < pending {
            return Err(ContractError::InsufficientRewardBalance);
        }

        // CHECKS-EFFECTS-INTERACTIONS (M-4): persist the settled staker state
        // BEFORE the external token call. Settling against `settle_acc` — the
        // frozen snapshot for a stale staker — is what stops the multi-epoch
        // re-harvest; the debt can never be reset to a moving accumulator.
        staker.reward_debt =
            rewards::compute_reward_debt(&env, staker.staked_amount, settle_acc)?;
        staker.pending_rewards = 0;
        storage::set_staker(&env, &user, pool_index, &staker);

        token_client.transfer(&env.current_contract_address(), &user, &pending);

        events::Claimed {
            user,
            pool_index,
            amount: pending,
        }
        .publish(&env);
        Ok(pending)
    }

    /// Stop earning. Pending rewards are preserved for a later claim.
    pub fn unstake(env: Env, user: Address, pool_index: u32) -> Result<(), ContractError> {
        user.require_auth();
        Self::require_valid_pool(&env, pool_index)?;
        storage::extend_instance_ttl(&env);

        if !storage::has_staker(&env, &user, pool_index) {
            return Err(ContractError::NoStakeFound);
        }

        let state = rewards::update_pool(&env, pool_index)?;
        let staker = storage::get_staker(&env, &user, pool_index);

        let settle_acc = Self::settlement_acc(&env, pool_index, &state, &staker)?;
        let pending = rewards::calculate_pending(&env, settle_acc, &staker)?;

        if staker.staked_amount > 0 {
            let mut updated = storage::get_pool_state(&env, pool_index)?;
            updated.total_staked = updated
                .total_staked
                .checked_sub(staker.staked_amount)
                .ok_or(ContractError::MathOverflow)?;
            if updated.total_staked < 0 {
                return Err(ContractError::MathOverflow);
            }
            storage::set_pool_state(&env, pool_index, &updated);
        }

        if pending > 0 {
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

        events::Unstaked {
            user,
            pool_index,
            amount: staker.staked_amount,
        }
        .publish(&env);
        Ok(())
    }

    // ========== Views ==========

    /// Unclaimed rewards for a user.
    ///
    /// Propagates errors rather than reporting 0 (L-NEW-1): a silent zero would
    /// tell a UI or treasury script that there is no liability at exactly the
    /// moment reward accounting is broken. Use `pending_reward_or_zero` for a
    /// best-effort display value.
    pub fn pending_reward(env: Env, user: Address, pool_index: u32) -> Result<i128, ContractError> {
        if !storage::has_staker(&env, &user, pool_index) {
            return Ok(0);
        }
        let staker = storage::get_staker(&env, &user, pool_index);
        if staker.staked_amount == 0 {
            return Ok(staker.pending_rewards);
        }

        let current_epoch = Self::current_epoch_id(&env, pool_index);
        let acc = if staker.epoch_id == current_epoch {
            rewards::simulate_acc_reward(&env, pool_index)?
        } else {
            storage::get_epoch_end_acc(&env, pool_index, staker.epoch_id)?
        };

        rewards::calculate_pending(&env, acc, &staker)
    }

    /// Best-effort variant for display only. Explicitly named so a zero here is
    /// never mistaken for an authoritative liability figure.
    pub fn pending_reward_or_zero(env: Env, user: Address, pool_index: u32) -> i128 {
        Self::pending_reward(env, user, pool_index).unwrap_or(0)
    }

    pub fn get_staker_info(env: Env, user: Address, pool_index: u32) -> StakerInfo {
        storage::get_staker(&env, &user, pool_index)
    }

    pub fn get_pool_state(env: Env, pool_index: u32) -> Result<PoolState, ContractError> {
        storage::get_pool_state(&env, pool_index)
    }

    pub fn get_merkle_root(env: Env, pool_index: u32) -> MerkleRootData {
        storage::get_merkle_root(&env, pool_index)
    }

    pub fn get_pool_count(env: Env) -> u32 {
        storage::get_pool_count(&env)
    }

    pub fn get_pool_id(env: Env, pool_index: u32) -> BytesN<32> {
        storage::get_pool_id(&env, pool_index)
    }

    /// This pool's emission rate (stroops/sec).
    pub fn get_pool_rate(env: Env, pool_index: u32) -> Result<i128, ContractError> {
        Ok(storage::get_pool_state(&env, pool_index)?.reward_rate)
    }

    /// Sum of every ACTIVE pool's rate — the contract's true total burn rate.
    /// Makes the "rate x number of pools" liability explicit (M-1). Read from a
    /// cached total maintained incrementally, so this never loops (L-NEW-4).
    pub fn total_emission_rate(env: Env) -> i128 {
        storage::get_total_emission_rate(&env)
    }

    /// The current epoch's reward denominator for a pool (0 before the first root).
    pub fn get_epoch_total_lp(env: Env, pool_index: u32) -> i128 {
        rewards::current_total_lp(&env, pool_index)
    }

    pub fn reward_balance(env: Env) -> i128 {
        let lmnr_token = storage::get_lmnr_token(&env);
        let token_client = token::Client::new(&env, &lmnr_token);
        token_client.balance(&env.current_contract_address())
    }

    pub fn get_admin(env: Env) -> Address {
        storage::get_admin(&env)
    }

    pub fn get_operator(env: Env) -> Option<Address> {
        storage::get_operator(&env)
    }

    pub fn get_lmnr_token(env: Env) -> Address {
        storage::get_lmnr_token(&env)
    }

    /// Frozen accumulator for a finished epoch (0 if not recorded).
    pub fn get_epoch_end_acc(env: Env, pool_index: u32, epoch_id: u64) -> i128 {
        storage::get_epoch_end_acc(&env, pool_index, epoch_id).unwrap_or(0)
    }

    // ========== Internal helpers ==========

    fn require_admin(env: &Env, caller: &Address) -> Result<(), ContractError> {
        caller.require_auth();
        if !storage::has_admin(env) {
            return Err(ContractError::NotInitialized);
        }
        if *caller != storage::get_admin(env) {
            return Err(ContractError::Unauthorized);
        }
        Ok(())
    }

    /// Operator OR admin. Used only by `update_stake`, so the hot cron key
    /// cannot withdraw funds, change rates, post roots, or move the admin role.
    /// Returns true if the caller is the admin, false if it is the operator.
    fn require_operator_or_admin(env: &Env, caller: &Address) -> Result<bool, ContractError> {
        caller.require_auth();
        if !storage::has_admin(env) {
            return Err(ContractError::NotInitialized);
        }
        if *caller == storage::get_admin(env) {
            return Ok(true);
        }
        if let Some(op) = storage::get_operator(env) {
            if *caller == op {
                return Ok(false);
            }
        }
        Err(ContractError::Unauthorized)
    }

    /// Maintain the cached total emission rate so the view never loops (L-NEW-4).
    fn bump_emission_total(env: &Env, old_rate: i128, new_rate: i128) -> Result<(), ContractError> {
        let total = storage::get_total_emission_rate(env)
            .checked_sub(old_rate)
            .and_then(|v| v.checked_add(new_rate))
            .ok_or(ContractError::MathOverflow)?;
        storage::set_total_emission_rate(env, if total < 0 { 0 } else { total });
        Ok(())
    }

    fn require_valid_pool(env: &Env, pool_index: u32) -> Result<(), ContractError> {
        if pool_index >= storage::get_pool_count(env) {
            return Err(ContractError::PoolNotFound);
        }
        Ok(())
    }

    fn require_active_pool(env: &Env, pool_index: u32) -> Result<(), ContractError> {
        Self::require_valid_pool(env, pool_index)?;
        if !storage::get_pool_state(env, pool_index)?.active {
            return Err(ContractError::PoolInactive);
        }
        Ok(())
    }

    fn require_valid_rate(rate: i128) -> Result<(), ContractError> {
        if rate < 0 || rate > MAX_REWARD_RATE {
            return Err(ContractError::InvalidRewardRate);
        }
        Ok(())
    }

    fn current_epoch_id(env: &Env, pool_index: u32) -> u64 {
        if storage::has_merkle_root(env, pool_index) {
            storage::get_merkle_root(env, pool_index).epoch_id
        } else {
            0
        }
    }

    /// Which accumulator a staker settles against.
    ///
    /// Current epoch -> the live accumulator. Stale -> the FROZEN snapshot taken
    /// when their epoch ended, which never advances again. This is the core of
    /// the H-1 fix.
    fn settlement_acc(
        env: &Env,
        pool_index: u32,
        state: &PoolState,
        staker: &StakerInfo,
    ) -> Result<i128, ContractError> {
        let current_epoch = Self::current_epoch_id(env, pool_index);
        if staker.epoch_id == current_epoch {
            Ok(state.acc_reward_per_share)
        } else {
            storage::get_epoch_end_acc(env, pool_index, staker.epoch_id)
        }
    }
}
