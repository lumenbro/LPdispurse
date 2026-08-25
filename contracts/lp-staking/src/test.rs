#![cfg(test)]
extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token, vec, Address, BytesN, Env, Vec,
};

use crate::{merkle, LpStakingContract, LpStakingContractArgs, LpStakingContractClient, MIN_STAKE};

const RATE: i128 = 462_962_963; // ~4000 tokens/day at 7 decimals

struct TestEnv {
    env: Env,
    contract_id: Address,
    admin: Address,
    operator: Address,
    token_id: Address,
    token_admin: token::StellarAssetClient<'static>,
}

fn setup_env() -> TestEnv {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1000);
    env.ledger().set_sequence_number(2000);

    let admin = Address::generate(&env);
    let operator = Address::generate(&env);
    let token_issuer = Address::generate(&env);

    let sac = env.register_stellar_asset_contract_v2(token_issuer);
    let token_id = sac.address();
    let token_admin = token::StellarAssetClient::new(&env, &token_id);

    let contract_id = env.register(
        LpStakingContract,
        LpStakingContractArgs::__constructor(&admin, &operator, &token_id),
    );

    TestEnv {
        env,
        contract_id,
        admin,
        operator,
        token_id,
        token_admin,
    }
}

impl TestEnv {
    fn client(&self) -> LpStakingContractClient<'_> {
        LpStakingContractClient::new(&self.env, &self.contract_id)
    }

    fn fund_contract(&self, amount: i128) {
        self.token_admin.mint(&self.contract_id, &amount);
    }

    fn advance_to(&self, ts: u64) {
        self.env.ledger().set_timestamp(ts);
    }

    /// compute_leaf reads `current_contract_address`, so it must run inside the
    /// contract's context (this mirrors what the off-chain builder must encode).
    fn leaf(
        &self,
        pool_index: u32,
        pool_id: &BytesN<32>,
        user: &Address,
        balance: i128,
        epoch: u64,
    ) -> BytesN<32> {
        self.env.as_contract(&self.contract_id, || {
            merkle::compute_leaf(&self.env, pool_index, pool_id, user, balance, epoch)
        })
    }

    fn hash_pair_ctx(&self, a: &BytesN<32>, b: &BytesN<32>) -> BytesN<32> {
        self.env
            .as_contract(&self.contract_id, || hash_pair_test(&self.env, a, b))
    }
}

fn make_pool_id(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
}

/// Mirror of merkle::hash_pair (private) for building test trees.
fn hash_pair_test(env: &Env, a: &BytesN<32>, b: &BytesN<32>) -> BytesN<32> {
    use soroban_sdk::Bytes;
    let mut data = Bytes::new(env);
    data.push_back(0x01u8);
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

/// Build a Merkle tree from leaves; returns (root, proof-per-leaf).
fn build_tree(t: &TestEnv, leaves: &[BytesN<32>]) -> (BytesN<32>, std::vec::Vec<Vec<BytesN<32>>>) {
    let env = &t.env;
    let n = leaves.len();
    assert!(n > 0);

    if n == 1 {
        return (leaves[0].clone(), std::vec![Vec::new(env)]);
    }

    let mut level: std::vec::Vec<BytesN<32>> = leaves.to_vec();
    let mut proofs: std::vec::Vec<Vec<BytesN<32>>> =
        (0..n).map(|_| Vec::new(env)).collect();
    // index -> position in current level
    let mut positions: std::vec::Vec<usize> = (0..n).collect();

    while level.len() > 1 {
        let mut next: std::vec::Vec<BytesN<32>> = std::vec::Vec::new();
        let mut next_positions: std::vec::Vec<usize> = std::vec![0; n];

        let mut i = 0;
        while i < level.len() {
            if i + 1 < level.len() {
                let parent = t.hash_pair_ctx(&level[i], &level[i + 1]);
                let parent_idx = next.len();
                next.push(parent);
                for leaf_idx in 0..n {
                    if positions[leaf_idx] == i {
                        proofs[leaf_idx].push_back(level[i + 1].clone());
                        next_positions[leaf_idx] = parent_idx;
                    } else if positions[leaf_idx] == i + 1 {
                        proofs[leaf_idx].push_back(level[i].clone());
                        next_positions[leaf_idx] = parent_idx;
                    }
                }
                i += 2;
            } else {
                // odd node promoted unchanged
                let parent_idx = next.len();
                next.push(level[i].clone());
                for leaf_idx in 0..n {
                    if positions[leaf_idx] == i {
                        next_positions[leaf_idx] = parent_idx;
                    }
                }
                i += 1;
            }
        }
        level = next;
        positions = next_positions;
    }

    (level[0].clone(), proofs)
}

// ==================== construction / roles ====================

#[test]
fn test_constructor_sets_roles() {
    let t = setup_env();
    let c = t.client();
    assert_eq!(c.get_admin(), t.admin);
    assert_eq!(c.get_operator(), Some(t.operator.clone()));
    assert_eq!(c.get_lmnr_token(), t.token_id);
    assert_eq!(c.get_pool_count(), 0);
}

#[test]
fn test_two_step_admin_transfer() {
    let t = setup_env();
    let c = t.client();
    let new_admin = Address::generate(&t.env);

    c.propose_admin(&t.admin, &new_admin);
    // Not admin until accepted.
    assert_eq!(c.get_admin(), t.admin);

    c.accept_admin(&new_admin);
    assert_eq!(c.get_admin(), new_admin);
}

#[test]
fn test_accept_admin_by_wrong_address_fails() {
    let t = setup_env();
    let c = t.client();
    let new_admin = Address::generate(&t.env);
    let imposter = Address::generate(&t.env);

    c.propose_admin(&t.admin, &new_admin);
    assert!(c.try_accept_admin(&imposter).is_err());
    assert_eq!(c.get_admin(), t.admin);
}

#[test]
fn test_accept_admin_without_proposal_fails() {
    let t = setup_env();
    let c = t.client();
    let someone = Address::generate(&t.env);
    assert!(c.try_accept_admin(&someone).is_err());
}

#[test]
fn test_non_admin_cannot_add_pool() {
    let t = setup_env();
    let c = t.client();
    let stranger = Address::generate(&t.env);
    let pool_id = make_pool_id(&t.env, 1);
    assert!(c.try_add_pool(&stranger, &pool_id, &RATE).is_err());
}

// ==================== operator role ====================

#[test]
fn test_operator_can_only_decrease_existing_stake() {
    let t = setup_env();
    let c = t.client();
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);

    let user = Address::generate(&t.env);
    // Admin seeds the record; operator may then reconcile it DOWN.
    c.update_stake(&t.admin, &user, &0, &(1000 * MIN_STAKE));
    c.update_stake(&t.operator, &user, &0, &(400 * MIN_STAKE));
    assert_eq!(c.get_staker_info(&user, &0).staked_amount, 400 * MIN_STAKE);

    // ...but never UP.
    assert!(c
        .try_update_stake(&t.operator, &user, &0, &(900 * MIN_STAKE))
        .is_err());
    assert_eq!(c.get_staker_info(&user, &0).staked_amount, 400 * MIN_STAKE);
}

/// H-NEW-1: a compromised cron key must not be able to mint itself an
/// entitlement and drain the reward pool through `claim`.
#[test]
fn test_operator_cannot_fabricate_stake_for_itself() {
    let t = setup_env();
    let c = t.client();
    t.fund_contract(1_000_000_000_000_000);
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);

    let attacker = Address::generate(&t.env);
    assert!(c
        .try_update_stake(&t.operator, &attacker, &0, &(1_000_000 * MIN_STAKE))
        .is_err());
    assert_eq!(c.get_pool_state(&0).total_staked, 0);
    assert!(c.try_claim(&attacker, &0).is_err());
    // And the reward pool is untouched.
    assert_eq!(c.reward_balance(), 1_000_000_000_000_000);
}

/// Operator must not be able to drag a stale staker into the current epoch
/// (which would restart their accrual) without a proof.
#[test]
fn test_operator_cannot_advance_stale_staker_upward() {
    let t = setup_env();
    let c = t.client();
    t.fund_contract(1_000_000_000_000_000);
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);

    let user = Address::generate(&t.env);
    let bal = 10_000 * MIN_STAKE;
    let leaf = t.leaf(0, &pool_id, &user, bal, 1);
    let (root, proofs) = build_tree(&t, &[leaf]);
    c.set_merkle_root(&t.admin, &0, &root, &100, &bal);
    c.stake(&user, &0, &bal, &proofs[0]);

    t.advance_to(2000);
    let root2 = make_pool_id(&t.env, 5);
    c.set_merkle_root(&t.admin, &0, &root2, &200, &bal);

    // Raising is refused outright.
    assert!(c
        .try_update_stake(&t.operator, &user, &0, &(bal * 2))
        .is_err());

    // H-R2-1: EQUALITY also must not restart accrual. The decrease-only check
    // permits this call, so the epoch must be preserved instead.
    let earned = c.pending_reward(&user, &0);
    c.update_stake(&t.operator, &user, &0, &bal);
    assert_eq!(
        c.get_staker_info(&user, &0).epoch_id,
        1,
        "operator must not move a stale record into the current epoch"
    );

    t.advance_to(9000);
    assert_eq!(
        c.pending_reward(&user, &0),
        earned,
        "stale staker accrued again after an operator no-op reconciliation"
    );
}

/// H-R2-1 variant: a nominal DECREASE must not restart a stale record either.
#[test]
fn test_operator_decrease_does_not_restart_stale_accrual() {
    let t = setup_env();
    let c = t.client();
    t.fund_contract(1_000_000_000_000_000);
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);

    let user = Address::generate(&t.env);
    let bal = 10_000 * MIN_STAKE;
    let leaf = t.leaf(0, &pool_id, &user, bal, 1);
    let (root, proofs) = build_tree(&t, &[leaf]);
    c.set_merkle_root(&t.admin, &0, &root, &100, &bal);
    c.stake(&user, &0, &bal, &proofs[0]);

    t.advance_to(2000);
    let root2 = make_pool_id(&t.env, 5);
    c.set_merkle_root(&t.admin, &0, &root2, &200, &bal);

    let earned = c.pending_reward(&user, &0);
    assert_eq!(earned, RATE * 1000);

    // Shave one stroop — allowed by decrease-only, must NOT renew the epoch.
    c.update_stake(&t.operator, &user, &0, &(bal - 1));
    assert_eq!(c.get_staker_info(&user, &0).epoch_id, 1);

    t.advance_to(20_000);
    assert_eq!(
        c.pending_reward(&user, &0),
        earned,
        "operator renewed a stale position by shaving the amount"
    );
    assert_eq!(c.claim(&user, &0), earned);
    assert_eq!(c.pending_reward(&user, &0), 0);
}

/// L-R2-2: reconciling to zero with no pending rewards leaves no tombstone.
#[test]
fn test_zero_reconciliation_removes_record() {
    let t = setup_env();
    let c = t.client();
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);

    let user = Address::generate(&t.env);
    c.update_stake(&t.admin, &user, &0, &(1_000 * MIN_STAKE));
    c.update_stake(&t.operator, &user, &0, &0);

    assert!(c.try_get_staker_info(&user, &0).is_err());
    assert_eq!(c.get_pool_state(&0).total_staked, 0);
}

/// The ADMIN may still deliberately move a record into the current epoch.
#[test]
fn test_admin_reconciliation_still_advances_epoch() {
    let t = setup_env();
    let c = t.client();
    t.fund_contract(1_000_000_000_000_000);
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);

    let user = Address::generate(&t.env);
    let bal = 10_000 * MIN_STAKE;
    let leaf = t.leaf(0, &pool_id, &user, bal, 1);
    let (root, proofs) = build_tree(&t, &[leaf]);
    c.set_merkle_root(&t.admin, &0, &root, &100, &bal);
    c.stake(&user, &0, &bal, &proofs[0]);

    t.advance_to(2000);
    let root2 = make_pool_id(&t.env, 5);
    c.set_merkle_root(&t.admin, &0, &root2, &200, &bal);

    c.update_stake(&t.admin, &user, &0, &bal);
    assert_eq!(c.get_staker_info(&user, &0).epoch_id, 2);
}

#[test]
fn test_operator_cannot_withdraw() {
    let t = setup_env();
    let c = t.client();
    t.fund_contract(1_000_000_000);
    assert!(c.try_withdraw(&t.operator, &1_000).is_err());
}

#[test]
fn test_operator_cannot_set_rate_or_root() {
    let t = setup_env();
    let c = t.client();
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);

    assert!(c.try_set_pool_rate(&t.operator, &0, &1).is_err());
    let root = make_pool_id(&t.env, 9);
    assert!(c.try_set_merkle_root(&t.operator, &0, &root, &100, &(10_000 * MIN_STAKE)).is_err());
}

#[test]
fn test_stranger_cannot_update_stake() {
    let t = setup_env();
    let c = t.client();
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);

    let stranger = Address::generate(&t.env);
    let user = Address::generate(&t.env);
    assert!(c
        .try_update_stake(&stranger, &user, &0, &(1000 * MIN_STAKE))
        .is_err());
}

// ==================== pools & rates ====================

#[test]
fn test_add_pool_and_rate() {
    let t = setup_env();
    let c = t.client();
    let pool_id = make_pool_id(&t.env, 1);
    let idx = c.add_pool(&t.admin, &pool_id, &RATE);
    assert_eq!(idx, 0);
    assert_eq!(c.get_pool_count(), 1);
    assert_eq!(c.get_pool_rate(&0), RATE);
    assert_eq!(c.get_pool_id(&0), pool_id);
}

#[test]
fn test_duplicate_pool_rejected() {
    let t = setup_env();
    let c = t.client();
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);
    assert!(c.try_add_pool(&t.admin, &pool_id, &RATE).is_err());
}

#[test]
fn test_per_pool_rates_are_independent() {
    let t = setup_env();
    let c = t.client();
    c.add_pool(&t.admin, &make_pool_id(&t.env, 1), &RATE);
    c.add_pool(&t.admin, &make_pool_id(&t.env, 2), &(RATE * 2));
    c.add_pool(&t.admin, &make_pool_id(&t.env, 3), &0);

    assert_eq!(c.get_pool_rate(&0), RATE);
    assert_eq!(c.get_pool_rate(&1), RATE * 2);
    assert_eq!(c.get_pool_rate(&2), 0);
    // Total burn rate is explicit (M-1).
    assert_eq!(c.total_emission_rate(), RATE * 3);
}

#[test]
fn test_set_pool_rate_only_affects_one_pool() {
    let t = setup_env();
    let c = t.client();
    c.add_pool(&t.admin, &make_pool_id(&t.env, 1), &RATE);
    c.add_pool(&t.admin, &make_pool_id(&t.env, 2), &RATE);

    c.set_pool_rate(&t.admin, &0, &(RATE / 2));
    assert_eq!(c.get_pool_rate(&0), RATE / 2);
    assert_eq!(c.get_pool_rate(&1), RATE);
}

#[test]
fn test_rate_above_max_rejected() {
    let t = setup_env();
    let c = t.client();
    let pool_id = make_pool_id(&t.env, 1);
    assert!(c
        .try_add_pool(&t.admin, &pool_id, &(crate::MAX_REWARD_RATE + 1))
        .is_err());
}

#[test]
fn test_negative_rate_rejected() {
    let t = setup_env();
    let c = t.client();
    let pool_id = make_pool_id(&t.env, 1);
    assert!(c.try_add_pool(&t.admin, &pool_id, &-1).is_err());
}

#[test]
fn test_invalid_pool_index() {
    let t = setup_env();
    let c = t.client();
    let user = Address::generate(&t.env);
    assert!(c.try_claim(&user, &99).is_err());
}

// ==================== merkle ====================

#[test]
fn test_stake_single_leaf() {
    let t = setup_env();
    let c = t.client();
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);

    let user = Address::generate(&t.env);
    let bal = 10_000 * MIN_STAKE;
    let leaf = t.leaf(0, &pool_id, &user, bal, 1);
    let (root, proofs) = build_tree(&t, &[leaf]);

    c.set_merkle_root(&t.admin, &0, &root, &100, &bal);
    c.stake(&user, &0, &bal, &proofs[0]);

    let info = c.get_staker_info(&user, &0);
    assert_eq!(info.staked_amount, bal);
    assert_eq!(info.epoch_id, 1);
}

#[test]
fn test_stake_multi_leaf() {
    let t = setup_env();
    let c = t.client();
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);

    let u1 = Address::generate(&t.env);
    let u2 = Address::generate(&t.env);
    let u3 = Address::generate(&t.env);
    let b1 = 1_000 * MIN_STAKE;
    let b2 = 2_000 * MIN_STAKE;
    let b3 = 3_000 * MIN_STAKE;

    let leaves = [
        t.leaf(0, &pool_id, &u1, b1, 1),
        t.leaf(0, &pool_id, &u2, b2, 1),
        t.leaf(0, &pool_id, &u3, b3, 1),
    ];
    let (root, proofs) = build_tree(&t, &leaves);
    c.set_merkle_root(&t.admin, &0, &root, &100, &(b1 + b2 + b3));

    c.stake(&u1, &0, &b1, &proofs[0]);
    c.stake(&u2, &0, &b2, &proofs[1]);
    c.stake(&u3, &0, &b3, &proofs[2]);

    assert_eq!(c.get_pool_state(&0).total_staked, b1 + b2 + b3);
}

#[test]
fn test_invalid_proof_rejected() {
    let t = setup_env();
    let c = t.client();
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);

    let user = Address::generate(&t.env);
    let bal = 10_000 * MIN_STAKE;
    let leaf = t.leaf(0, &pool_id, &user, bal, 1);
    let (root, _) = build_tree(&t, &[leaf]);
    c.set_merkle_root(&t.admin, &0, &root, &100, &bal);

    // Wrong balance => wrong leaf => proof fails.
    let bogus: Vec<BytesN<32>> = vec![&t.env];
    assert!(c.try_stake(&user, &0, &(bal * 2), &bogus).is_err());
}

#[test]
fn test_proof_from_other_pool_rejected() {
    let t = setup_env();
    let c = t.client();
    let pool_a = make_pool_id(&t.env, 1);
    let pool_b = make_pool_id(&t.env, 2);
    c.add_pool(&t.admin, &pool_a, &RATE);
    c.add_pool(&t.admin, &pool_b, &RATE);

    let user = Address::generate(&t.env);
    let bal = 10_000 * MIN_STAKE;

    // Leaf built for pool 0 / pool_a.
    let leaf = t.leaf(0, &pool_a, &user, bal, 1);
    let (root, proofs) = build_tree(&t, &[leaf]);
    c.set_merkle_root(&t.admin, &0, &root, &100, &bal);
    // Same root posted on pool 1 — leaf is bound to pool_a + index 0, so it
    // must not validate against pool 1 (L-1).
    c.set_merkle_root(&t.admin, &1, &root, &100, &bal);

    assert!(c.try_stake(&user, &1, &bal, &proofs[0]).is_err());
}

#[test]
fn test_double_stake_same_epoch_rejected() {
    let t = setup_env();
    let c = t.client();
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);

    let user = Address::generate(&t.env);
    let bal = 10_000 * MIN_STAKE;
    let leaf = t.leaf(0, &pool_id, &user, bal, 1);
    let (root, proofs) = build_tree(&t, &[leaf]);
    c.set_merkle_root(&t.admin, &0, &root, &100, &bal);

    c.stake(&user, &0, &bal, &proofs[0]);
    assert!(c.try_stake(&user, &0, &bal, &proofs[0]).is_err());
}

#[test]
fn test_stake_below_minimum_rejected() {
    let t = setup_env();
    let c = t.client();
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);

    let user = Address::generate(&t.env);
    let tiny = MIN_STAKE - 1;
    let leaf = t.leaf(0, &pool_id, &user, tiny, 1);
    let (root, proofs) = build_tree(&t, &[leaf]);
    c.set_merkle_root(&t.admin, &0, &root, &100, &MIN_STAKE);

    assert!(c.try_stake(&user, &0, &tiny, &proofs[0]).is_err());
}

#[test]
fn test_snapshot_ledger_must_increase() {
    let t = setup_env();
    let c = t.client();
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);

    let root = make_pool_id(&t.env, 7);
    c.set_merkle_root(&t.admin, &0, &root, &200, &(10_000 * MIN_STAKE));
    // Same or lower snapshot ledger is rejected (L-2).
    assert!(c.try_set_merkle_root(&t.admin, &0, &root, &200, &(10_000 * MIN_STAKE)).is_err());
    assert!(c.try_set_merkle_root(&t.admin, &0, &root, &150, &(10_000 * MIN_STAKE)).is_err());
    c.set_merkle_root(&t.admin, &0, &root, &201, &(10_000 * MIN_STAKE));
}

// ==================== rewards ====================

#[test]
fn test_stake_claim_flow() {
    let t = setup_env();
    let c = t.client();
    t.fund_contract(1_000_000_000_000);
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);

    let user = Address::generate(&t.env);
    let bal = 10_000 * MIN_STAKE;
    let leaf = t.leaf(0, &pool_id, &user, bal, 1);
    let (root, proofs) = build_tree(&t, &[leaf]);
    c.set_merkle_root(&t.admin, &0, &root, &100, &bal);
    c.stake(&user, &0, &bal, &proofs[0]);

    t.advance_to(2000); // +1000s, sole staker
    let pending = c.pending_reward(&user, &0);
    assert_eq!(pending, RATE * 1000);

    let claimed = c.claim(&user, &0);
    assert_eq!(claimed, RATE * 1000);

    let token_client = token::Client::new(&t.env, &t.token_id);
    assert_eq!(token_client.balance(&user), RATE * 1000);

    // Immediately claiming again yields nothing.
    assert!(c.try_claim(&user, &0).is_err());
}

#[test]
fn test_two_stakers_split_by_share() {
    let t = setup_env();
    let c = t.client();
    t.fund_contract(1_000_000_000_000);
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);

    let u1 = Address::generate(&t.env);
    let u2 = Address::generate(&t.env);
    let b1 = 1_000 * MIN_STAKE;
    let b2 = 3_000 * MIN_STAKE; // 25% / 75%

    let leaves = [
        t.leaf(0, &pool_id, &u1, b1, 1),
        t.leaf(0, &pool_id, &u2, b2, 1),
    ];
    let (root, proofs) = build_tree(&t, &leaves);
    c.set_merkle_root(&t.admin, &0, &root, &100, &(b1 + b2));
    c.stake(&u1, &0, &b1, &proofs[0]);
    c.stake(&u2, &0, &b2, &proofs[1]);

    t.advance_to(2000); // +1000s
    let p1 = c.pending_reward(&u1, &0);
    let p2 = c.pending_reward(&u2, &0);

    let total = RATE * 1000;
    assert!((p1 - total / 4).abs() <= 1);
    assert!((p2 - total * 3 / 4).abs() <= 1);
}

#[test]
fn test_pool_with_zero_rate_accrues_nothing() {
    let t = setup_env();
    let c = t.client();
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &0);

    let user = Address::generate(&t.env);
    let bal = 10_000 * MIN_STAKE;
    let leaf = t.leaf(0, &pool_id, &user, bal, 1);
    let (root, proofs) = build_tree(&t, &[leaf]);
    c.set_merkle_root(&t.admin, &0, &root, &100, &bal);
    c.stake(&user, &0, &bal, &proofs[0]);

    t.advance_to(100_000);
    assert_eq!(c.pending_reward(&user, &0), 0);
}

// ==================== H-1 regression (the core fix) ====================

/// v1 BUG (H-1): `prev_acc_reward_per_share` was a single pool-wide value
/// overwritten on EVERY new epoch, so a staker who proved once in epoch 1 and
/// then dumped their LP kept accruing claimable rewards at every later epoch
/// boundary — prove-once, harvest-forever.
///
/// v2 freezes an accumulator snapshot per epoch, so a stale staker's settlement
/// basis never advances. This test posts THREE epochs (v1's test stopped at
/// two, which is exactly why it masked the bug).
#[test]
fn test_stale_staker_cannot_harvest_across_epochs() {
    let t = setup_env();
    let c = t.client();
    t.fund_contract(1_000_000_000_000_000);
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);

    let idle = Address::generate(&t.env);
    let active = Address::generate(&t.env);
    let bal = 10_000 * MIN_STAKE;

    // --- Epoch 1: idle user proves and stakes ---
    let leaf1 = t.leaf(0, &pool_id, &idle, bal, 1);
    let (root1, proofs1) = build_tree(&t, &[leaf1]);
    c.set_merkle_root(&t.admin, &0, &root1, &100, &bal);
    c.stake(&idle, &0, &bal, &proofs1[0]);

    t.advance_to(2000); // idle earns 1000s as sole staker
    let epoch1_earnings = RATE * 1000;

    // --- Epoch 2: idle does NOT re-prove; another user takes over ---
    let leaf2 = t.leaf(0, &pool_id, &active, bal, 2);
    let (root2, proofs2) = build_tree(&t, &[leaf2]);
    c.set_merkle_root(&t.admin, &0, &root2, &200, &bal);
    c.stake(&active, &0, &bal, &proofs2[0]);

    t.advance_to(3000);

    // Idle is now stale: entitled to epoch-1 earnings ONLY.
    let pending_after_e2 = c.pending_reward(&idle, &0);
    assert_eq!(pending_after_e2, epoch1_earnings);

    // Claim it once — legitimate.
    let claimed = c.claim(&idle, &0);
    assert_eq!(claimed, epoch1_earnings);

    // --- Epoch 3: the v1 killer. Idle still hasn't re-proved. ---
    let leaf3 = t.leaf(0, &pool_id, &active, bal, 3);
    let (root3, proofs3) = build_tree(&t, &[leaf3]);
    c.set_merkle_root(&t.admin, &0, &root3, &300, &bal);
    c.stake(&active, &0, &bal, &proofs3[0]);

    t.advance_to(4000);

    // Under v1 this would be another epoch's worth of free rewards.
    // Under v2 the frozen epoch-1 snapshot means there is nothing left.
    assert_eq!(
        c.pending_reward(&idle, &0),
        0,
        "stale staker must not accrue after their epoch ended"
    );
    assert!(
        c.try_claim(&idle, &0).is_err(),
        "stale staker must not be able to re-harvest in a later epoch"
    );

    // And a fourth epoch changes nothing.
    let leaf4 = t.leaf(0, &pool_id, &active, bal, 4);
    let (root4, _) = build_tree(&t, &[leaf4]);
    c.set_merkle_root(&t.admin, &0, &root4, &400, &bal);
    t.advance_to(5000);
    assert_eq!(c.pending_reward(&idle, &0), 0);
}

#[test]
fn test_stale_staker_keeps_exactly_one_epoch_of_rewards() {
    let t = setup_env();
    let c = t.client();
    t.fund_contract(1_000_000_000_000_000);
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);

    let user = Address::generate(&t.env);
    let bal = 10_000 * MIN_STAKE;
    let leaf1 = t.leaf(0, &pool_id, &user, bal, 1);
    let (root1, proofs1) = build_tree(&t, &[leaf1]);
    c.set_merkle_root(&t.admin, &0, &root1, &100, &bal);
    c.stake(&user, &0, &bal, &proofs1[0]);

    t.advance_to(2000);

    let other = Address::generate(&t.env);
    let leaf2 = t.leaf(0, &pool_id, &other, bal, 2);
    let (root2, _) = build_tree(&t, &[leaf2]);
    c.set_merkle_root(&t.admin, &0, &root2, &200, &bal);

    t.advance_to(9999);
    // Frozen at the epoch-1 boundary regardless of how much time passes.
    assert_eq!(c.pending_reward(&user, &0), RATE * 1000);
}

#[test]
fn test_restaking_next_epoch_preserves_pending() {
    let t = setup_env();
    let c = t.client();
    t.fund_contract(1_000_000_000_000_000);
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);

    let user = Address::generate(&t.env);
    let bal = 10_000 * MIN_STAKE;
    let leaf1 = t.leaf(0, &pool_id, &user, bal, 1);
    let (root1, proofs1) = build_tree(&t, &[leaf1]);
    c.set_merkle_root(&t.admin, &0, &root1, &100, &bal);
    c.stake(&user, &0, &bal, &proofs1[0]);

    t.advance_to(2000);

    let new_bal = 12_000 * MIN_STAKE;
    let leaf2 = t.leaf(0, &pool_id, &user, new_bal, 2);
    let (root2, proofs2) = build_tree(&t, &[leaf2]);
    c.set_merkle_root(&t.admin, &0, &root2, &200, &new_bal);
    c.stake(&user, &0, &new_bal, &proofs2[0]);

    let info = c.get_staker_info(&user, &0);
    assert_eq!(info.epoch_id, 2);
    assert_eq!(info.staked_amount, new_bal);
    assert_eq!(info.pending_rewards, RATE * 1000);
    assert_eq!(c.get_pool_state(&0).total_staked, new_bal);
}

// ==================== H-2: remove_pool ====================

#[test]
fn test_remove_pool_blocks_new_stakes() {
    let t = setup_env();
    let c = t.client();
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);

    let user = Address::generate(&t.env);
    let bal = 10_000 * MIN_STAKE;
    let leaf = t.leaf(0, &pool_id, &user, bal, 1);
    let (root, proofs) = build_tree(&t, &[leaf]);
    c.set_merkle_root(&t.admin, &0, &root, &100, &bal);

    c.remove_pool(&t.admin, &0);
    assert!(!c.get_pool_state(&0).active);

    // v1 allowed a new staker to silently reactivate a "removed" pool.
    assert!(c.try_stake(&user, &0, &bal, &proofs[0]).is_err());
    assert!(c.try_set_merkle_root(&t.admin, &0, &root, &500, &bal).is_err());
    assert!(c.try_remove_pool(&t.admin, &0).is_err());
}

#[test]
fn test_remove_pool_preserves_totals_and_allows_exit() {
    let t = setup_env();
    let c = t.client();
    t.fund_contract(1_000_000_000_000_000);
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);

    let user = Address::generate(&t.env);
    let bal = 10_000 * MIN_STAKE;
    let leaf = t.leaf(0, &pool_id, &user, bal, 1);
    let (root, proofs) = build_tree(&t, &[leaf]);
    c.set_merkle_root(&t.admin, &0, &root, &100, &bal);
    c.stake(&user, &0, &bal, &proofs[0]);

    t.advance_to(2000);
    c.remove_pool(&t.admin, &0);

    // v1 zeroed total_staked here, which then went NEGATIVE on unstake.
    assert_eq!(c.get_pool_state(&0).total_staked, bal);

    // User can still claim what they earned, and exit cleanly.
    let claimed = c.claim(&user, &0);
    assert_eq!(claimed, RATE * 1000);

    c.unstake(&user, &0);
    assert_eq!(c.get_pool_state(&0).total_staked, 0);
}

#[test]
fn test_inactive_pool_stops_accrual() {
    let t = setup_env();
    let c = t.client();
    t.fund_contract(1_000_000_000_000_000);
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);

    let user = Address::generate(&t.env);
    let bal = 10_000 * MIN_STAKE;
    let leaf = t.leaf(0, &pool_id, &user, bal, 1);
    let (root, proofs) = build_tree(&t, &[leaf]);
    c.set_merkle_root(&t.admin, &0, &root, &100, &bal);
    c.stake(&user, &0, &bal, &proofs[0]);

    t.advance_to(2000);
    c.remove_pool(&t.admin, &0);
    let at_removal = c.pending_reward(&user, &0);

    t.advance_to(100_000);
    assert_eq!(c.pending_reward(&user, &0), at_removal);
}

// ==================== unstake ====================

#[test]
fn test_unstake_preserves_pending() {
    let t = setup_env();
    let c = t.client();
    t.fund_contract(1_000_000_000_000_000);
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);

    let user = Address::generate(&t.env);
    let bal = 10_000 * MIN_STAKE;
    let leaf = t.leaf(0, &pool_id, &user, bal, 1);
    let (root, proofs) = build_tree(&t, &[leaf]);
    c.set_merkle_root(&t.admin, &0, &root, &100, &bal);
    c.stake(&user, &0, &bal, &proofs[0]);

    t.advance_to(2000);
    c.unstake(&user, &0);

    let info = c.get_staker_info(&user, &0);
    assert_eq!(info.staked_amount, 0);
    assert_eq!(info.pending_rewards, RATE * 1000);
    assert_eq!(c.get_pool_state(&0).total_staked, 0);

    let claimed = c.claim(&user, &0);
    assert_eq!(claimed, RATE * 1000);
}

#[test]
fn test_unstake_then_no_further_accrual() {
    let t = setup_env();
    let c = t.client();
    t.fund_contract(1_000_000_000_000_000);
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);

    let user = Address::generate(&t.env);
    let bal = 10_000 * MIN_STAKE;
    let leaf = t.leaf(0, &pool_id, &user, bal, 1);
    let (root, proofs) = build_tree(&t, &[leaf]);
    c.set_merkle_root(&t.admin, &0, &root, &100, &bal);
    c.stake(&user, &0, &bal, &proofs[0]);

    t.advance_to(2000);
    c.unstake(&user, &0);
    let after = c.pending_reward(&user, &0);
    t.advance_to(50_000);
    assert_eq!(c.pending_reward(&user, &0), after);
}

// ==================== update_stake (cron path) ====================

#[test]
fn test_update_stake_adjusts_totals() {
    let t = setup_env();
    let c = t.client();
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);

    let user = Address::generate(&t.env);
    let a = 1_000 * MIN_STAKE;
    let b = 400 * MIN_STAKE;

    c.update_stake(&t.admin, &user, &0, &a);
    assert_eq!(c.get_pool_state(&0).total_staked, a);

    // Operator may reconcile downward.
    c.update_stake(&t.operator, &user, &0, &b);
    assert_eq!(c.get_pool_state(&0).total_staked, b);

    c.update_stake(&t.operator, &user, &0, &0);
    assert_eq!(c.get_pool_state(&0).total_staked, 0);
}

#[test]
fn test_update_stake_below_minimum_rejected() {
    let t = setup_env();
    let c = t.client();
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);

    let user = Address::generate(&t.env);
    assert!(c
        .try_update_stake(&t.admin, &user, &0, &(MIN_STAKE - 1))
        .is_err());
    assert!(c
        .try_update_stake(&t.admin, &user, &0, &(crate::MAX_STAKE + 1))
        .is_err());
}

#[test]
fn test_update_stake_negative_rejected() {
    let t = setup_env();
    let c = t.client();
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);

    let user = Address::generate(&t.env);
    assert!(c.try_update_stake(&t.admin, &user, &0, &-5).is_err());
}

/// A staker created by the admin before any root exists carries epoch 0.
/// Because the reward denominator is the epoch's authenticated `total_lp`,
/// nothing accrues until the first root is posted — and epoch 0 still gets a
/// frozen snapshot so settlement never hits EpochSnapshotMissing.
#[test]
fn test_epoch_zero_staker_accrues_nothing_before_first_root() {
    let t = setup_env();
    let c = t.client();
    t.fund_contract(1_000_000_000_000_000);
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);

    let user = Address::generate(&t.env);
    let bal = 10_000 * MIN_STAKE;
    c.update_stake(&t.admin, &user, &0, &bal);

    t.advance_to(2000); // no root yet => no denominator => no accrual
    assert_eq!(c.pending_reward(&user, &0), 0);

    let root = make_pool_id(&t.env, 8);
    c.set_merkle_root(&t.admin, &0, &root, &100, &bal);

    t.advance_to(3000);
    // Settles cleanly against the frozen epoch-0 snapshot: still zero.
    assert_eq!(c.pending_reward(&user, &0), 0);
    assert!(c.try_claim(&user, &0).is_err());
}

// ==================== round-2 regressions ====================

/// H-NEW-2: a stale position left in `total_staked` must NOT dilute the users
/// who actually proved in the current epoch. The denominator is the epoch's
/// authenticated total_lp, so the active staker gets the FULL epoch budget.
#[test]
fn test_stale_position_does_not_dilute_active_staker() {
    let t = setup_env();
    let c = t.client();
    t.fund_contract(1_000_000_000_000_000);
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);

    let alice = Address::generate(&t.env);
    let bob = Address::generate(&t.env);
    let bal = 10_000 * MIN_STAKE;

    // Epoch 1: Alice proves, then never returns.
    let l1 = t.leaf(0, &pool_id, &alice, bal, 1);
    let (r1, p1) = build_tree(&t, &[l1]);
    c.set_merkle_root(&t.admin, &0, &r1, &100, &bal);
    c.stake(&alice, &0, &bal, &p1[0]);
    t.advance_to(2000);

    // Epoch 2: Bob is the only LP holder in the new snapshot.
    let l2 = t.leaf(0, &pool_id, &bob, bal, 2);
    let (r2, p2) = build_tree(&t, &[l2]);
    c.set_merkle_root(&t.admin, &0, &r2, &200, &bal);
    c.stake(&bob, &0, &bal, &p2[0]);

    // Alice's stale amount is still counted in total_staked...
    assert_eq!(c.get_pool_state(&0).total_staked, bal * 2);

    t.advance_to(3000);
    // ...but Bob still receives the FULL epoch budget, not half of it.
    assert_eq!(c.pending_reward(&bob, &0), RATE * 1000);
    assert_eq!(c.pending_reward(&alice, &0), RATE * 1000); // her epoch-1 earnings only
}

/// M-NEW-2: frequent reconciliation must not silently destroy emission through
/// repeated flooring. The remainder is carried between updates.
#[test]
fn test_frequent_updates_do_not_lose_emission() {
    let t = setup_env();
    let c = t.client();
    t.fund_contract(1_000_000_000_000_000);
    let pool_id = make_pool_id(&t.env, 1);
    // A rate/denominator pair that floors to zero on every 1-second step.
    c.add_pool(&t.admin, &pool_id, &1);

    let user = Address::generate(&t.env);
    let bal = 1_000_000 * MIN_STAKE;
    let leaf = t.leaf(0, &pool_id, &user, bal, 1);
    let (root, proofs) = build_tree(&t, &[leaf]);
    c.set_merkle_root(&t.admin, &0, &root, &100, &bal);
    c.stake(&user, &0, &bal, &proofs[0]);

    // Poke the pool every second for 1000s (what a busy cron would do).
    for i in 1..=1000u64 {
        t.advance_to(1000 + i);
        c.update_stake(&t.admin, &user, &0, &bal);
    }

    // Whole-token emission over 1000s at rate 1 is 1000 stroops; the staker owns
    // 100% of total_lp, so essentially all of it must survive the flooring.
    let pending = c.pending_reward(&user, &0);
    assert!(
        pending >= 999,
        "remainder carry lost emission: got {}",
        pending
    );
}

/// M-NEW-1: a snapshot ledger in the future must be rejected. Accepting one
/// (e.g. u32::MAX) would permanently lock out every future root.
#[test]
fn test_future_snapshot_ledger_rejected() {
    let t = setup_env();
    let c = t.client();
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);
    let root = make_pool_id(&t.env, 7);

    assert!(c
        .try_set_merkle_root(&t.admin, &0, &root, &u32::MAX, &(10_000 * MIN_STAKE))
        .is_err());
    assert!(c
        .try_set_merkle_root(&t.admin, &0, &root, &50_000, &(10_000 * MIN_STAKE))
        .is_err());
    // A sane, recent snapshot still works.
    c.set_merkle_root(&t.admin, &0, &root, &1_500, &(10_000 * MIN_STAKE));
}

#[test]
fn test_invalid_total_lp_rejected() {
    let t = setup_env();
    let c = t.client();
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);
    let root = make_pool_id(&t.env, 7);

    assert!(c
        .try_set_merkle_root(&t.admin, &0, &root, &100, &0)
        .is_err());
    assert!(c
        .try_set_merkle_root(&t.admin, &0, &root, &100, &(crate::MAX_STAKE + 1))
        .is_err());
}

/// H-NEW-3: stakes above MAX_STAKE are refused, so a record can never be
/// written that later becomes unsettleable as the accumulator grows.
#[test]
fn test_stake_above_maximum_rejected() {
    let t = setup_env();
    let c = t.client();
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);

    let user = Address::generate(&t.env);
    let huge = crate::MAX_STAKE + 1;
    let leaf = t.leaf(0, &pool_id, &user, huge, 1);
    let (root, proofs) = build_tree(&t, &[leaf]);
    c.set_merkle_root(&t.admin, &0, &root, &100, &crate::MAX_STAKE);
    assert!(c.try_stake(&user, &0, &huge, &proofs[0]).is_err());
}

#[test]
fn test_stake_exceeding_total_lp_rejected() {
    let t = setup_env();
    let c = t.client();
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);

    let user = Address::generate(&t.env);
    let bal = 10_000 * MIN_STAKE;
    let leaf = t.leaf(0, &pool_id, &user, bal, 1);
    let (root, proofs) = build_tree(&t, &[leaf]);
    // Declared pool total is smaller than the claimed position.
    c.set_merkle_root(&t.admin, &0, &root, &100, &(bal / 2));
    assert!(c.try_stake(&user, &0, &bal, &proofs[0]).is_err());
}

/// The emergency repair path must work without touching reward math.
#[test]
fn test_admin_force_clear_stake() {
    let t = setup_env();
    let c = t.client();
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);

    let user = Address::generate(&t.env);
    let bal = 10_000 * MIN_STAKE;
    c.update_stake(&t.admin, &user, &0, &bal);
    assert_eq!(c.get_pool_state(&0).total_staked, bal);

    c.admin_force_clear_stake(&t.admin, &user, &0);
    assert_eq!(c.get_pool_state(&0).total_staked, 0);
    assert!(c.try_claim(&user, &0).is_err());

    // Operator must not have this power.
    assert!(c
        .try_admin_force_clear_stake(&t.operator, &user, &0)
        .is_err());
}

/// L-NEW-4: the emission total is cached, and tracks add/rate/remove.
#[test]
fn test_cached_total_emission_rate_tracks_changes() {
    let t = setup_env();
    let c = t.client();
    assert_eq!(c.total_emission_rate(), 0);

    c.add_pool(&t.admin, &make_pool_id(&t.env, 1), &RATE);
    c.add_pool(&t.admin, &make_pool_id(&t.env, 2), &RATE);
    assert_eq!(c.total_emission_rate(), RATE * 2);

    c.set_pool_rate(&t.admin, &0, &(RATE / 2));
    assert_eq!(c.total_emission_rate(), RATE / 2 + RATE);

    c.remove_pool(&t.admin, &1);
    assert_eq!(c.total_emission_rate(), RATE / 2);
}

// ==================== treasury ====================

#[test]
fn test_fund_and_withdraw() {
    let t = setup_env();
    let c = t.client();
    let funder = Address::generate(&t.env);
    t.token_admin.mint(&funder, &1_000_000);

    c.fund(&funder, &600_000);
    assert_eq!(c.reward_balance(), 600_000);

    c.withdraw(&t.admin, &100_000);
    assert_eq!(c.reward_balance(), 500_000);

    let token_client = token::Client::new(&t.env, &t.token_id);
    assert_eq!(token_client.balance(&t.admin), 100_000);
}

#[test]
fn test_withdraw_more_than_balance_fails() {
    let t = setup_env();
    let c = t.client();
    t.fund_contract(1_000);
    assert!(c.try_withdraw(&t.admin, &5_000).is_err());
}

#[test]
fn test_fund_zero_fails() {
    let t = setup_env();
    let c = t.client();
    let funder = Address::generate(&t.env);
    assert!(c.try_fund(&funder, &0).is_err());
}

#[test]
fn test_claim_without_funds_fails() {
    let t = setup_env();
    let c = t.client();
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);

    let user = Address::generate(&t.env);
    let bal = 10_000 * MIN_STAKE;
    let leaf = t.leaf(0, &pool_id, &user, bal, 1);
    let (root, proofs) = build_tree(&t, &[leaf]);
    c.set_merkle_root(&t.admin, &0, &root, &100, &(10_000 * MIN_STAKE));
    c.stake(&user, &0, &bal, &proofs[0]);

    t.advance_to(2000);
    // Contract has no reward balance.
    assert!(c.try_claim(&user, &0).is_err());
}

#[test]
fn test_no_stake_claim_fails() {
    let t = setup_env();
    let c = t.client();
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);
    let user = Address::generate(&t.env);
    assert!(c.try_claim(&user, &0).is_err());
}

#[test]
fn test_stake_without_root_fails() {
    let t = setup_env();
    let c = t.client();
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);

    let user = Address::generate(&t.env);
    let bogus: Vec<BytesN<32>> = vec![&t.env];
    assert!(c
        .try_stake(&user, &0, &(10_000 * MIN_STAKE), &bogus)
        .is_err());
}

// ==================== proof-replay guard (round 3) ====================

/// A current-epoch proof is spent ONCE. After an operator reconciles the record
/// to zero, replaying the same proof must not restore the old balance.
#[test]
fn test_proof_cannot_be_replayed_after_operator_zeroes_record() {
    let t = setup_env();
    let c = t.client();
    t.fund_contract(1_000_000_000_000_000);
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);

    let user = Address::generate(&t.env);
    let bal = 10_000 * MIN_STAKE;
    let leaf = t.leaf(0, &pool_id, &user, bal, 1);
    let (root, proofs) = build_tree(&t, &[leaf]);
    c.set_merkle_root(&t.admin, &0, &root, &100, &bal);
    c.stake(&user, &0, &bal, &proofs[0]);

    // Operator supersedes the position (user sold their LP).
    c.update_stake(&t.operator, &user, &0, &0);
    assert_eq!(c.get_pool_state(&0).total_staked, 0);

    // Replaying the spent proof must fail.
    assert!(c.try_stake(&user, &0, &bal, &proofs[0]).is_err());
    assert_eq!(c.get_pool_state(&0).total_staked, 0);
}

/// Same guard when the user unstakes themselves after a partial reconciliation.
#[test]
fn test_proof_cannot_be_replayed_after_unstake() {
    let t = setup_env();
    let c = t.client();
    t.fund_contract(1_000_000_000_000_000);
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);

    let user = Address::generate(&t.env);
    let bal = 10_000 * MIN_STAKE;
    let leaf = t.leaf(0, &pool_id, &user, bal, 1);
    let (root, proofs) = build_tree(&t, &[leaf]);
    c.set_merkle_root(&t.admin, &0, &root, &100, &bal);
    c.stake(&user, &0, &bal, &proofs[0]);

    c.update_stake(&t.operator, &user, &0, &(bal / 2));
    c.unstake(&user, &0);

    assert!(c.try_stake(&user, &0, &bal, &proofs[0]).is_err());
}

/// Even when unstake+claim deletes the staker record entirely, the marker
/// survives and blocks replay.
#[test]
fn test_proof_cannot_be_replayed_after_record_removed() {
    let t = setup_env();
    let c = t.client();
    t.fund_contract(1_000_000_000_000_000);
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);

    let user = Address::generate(&t.env);
    let bal = 10_000 * MIN_STAKE;
    let leaf = t.leaf(0, &pool_id, &user, bal, 1);
    let (root, proofs) = build_tree(&t, &[leaf]);
    c.set_merkle_root(&t.admin, &0, &root, &100, &bal);
    c.stake(&user, &0, &bal, &proofs[0]);

    t.advance_to(2000);
    c.unstake(&user, &0);
    c.claim(&user, &0); // zero-stake fast path removes the record
    assert!(c.try_get_staker_info(&user, &0).is_err());

    assert!(c.try_stake(&user, &0, &bal, &proofs[0]).is_err());
}

/// The guard is per-epoch: a fresh proof in the NEXT epoch still works.
#[test]
fn test_proof_accepted_again_in_next_epoch() {
    let t = setup_env();
    let c = t.client();
    t.fund_contract(1_000_000_000_000_000);
    let pool_id = make_pool_id(&t.env, 1);
    c.add_pool(&t.admin, &pool_id, &RATE);

    let user = Address::generate(&t.env);
    let bal = 10_000 * MIN_STAKE;
    let l1 = t.leaf(0, &pool_id, &user, bal, 1);
    let (r1, p1) = build_tree(&t, &[l1]);
    c.set_merkle_root(&t.admin, &0, &r1, &100, &bal);
    c.stake(&user, &0, &bal, &p1[0]);
    assert!(c.try_stake(&user, &0, &bal, &p1[0]).is_err());

    t.advance_to(2000);
    let l2 = t.leaf(0, &pool_id, &user, bal, 2);
    let (r2, p2) = build_tree(&t, &[l2]);
    c.set_merkle_root(&t.admin, &0, &r2, &200, &bal);

    c.stake(&user, &0, &bal, &p2[0]);
    assert_eq!(c.get_staker_info(&user, &0).epoch_id, 2);
}

// ==================== cross-language leaf vectors ====================

/// Prints canonical leaf hashes for the off-chain builder to verify against.
/// Run: `cargo test print_leaf_vectors -- --nocapture`
/// Then: `node staking-site/scripts/verify-leaf.mjs <output>`
///
/// If merkle.ts and merkle.rs ever drift by one byte, every proof fails
/// on-chain. This is the tripwire.
#[test]
fn test_print_leaf_vectors() {
    let t = setup_env();
    let pool_id = make_pool_id(&t.env, 7);
    let user = Address::generate(&t.env);
    let balance: i128 = 123_456_789_012;
    let epoch: u64 = 3;
    let pool_index: u32 = 2;

    let leaf = t.leaf(pool_index, &pool_id, &user, balance, epoch);

    std::println!("LEAFVEC contract={:?}", t.contract_id);
    std::println!("LEAFVEC user={:?}", user);
    std::println!("LEAFVEC pool_id_hex={}", {
        let mut s = std::string::String::new();
        let arr = pool_id.to_array();
        for b in arr.iter() {
            s.push_str(&std::format!("{:02x}", b));
        }
        s
    });
    std::println!("LEAFVEC pool_index={}", pool_index);
    std::println!("LEAFVEC balance={}", balance);
    std::println!("LEAFVEC epoch={}", epoch);
    std::println!("LEAFVEC leaf_hex={}", {
        let mut s = std::string::String::new();
        let arr = leaf.to_array();
        for b in arr.iter() {
            s.push_str(&std::format!("{:02x}", b));
        }
        s
    });
}
