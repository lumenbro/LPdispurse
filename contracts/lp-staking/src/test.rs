#![cfg(test)]
extern crate alloc;

use crate::merkle;
use crate::{LpStakingContract, LpStakingContractClient};
use soroban_sdk::testutils::{Address as _, Ledger, LedgerInfo};
use soroban_sdk::{token, Address, BytesN, Env, Vec};

// Helper: build a minimal Merkle tree from leaves and return (root, proofs).
// Supports 1-4 leaves for testing.
fn build_merkle_tree(
    env: &Env,
    leaves: &[BytesN<32>],
) -> (BytesN<32>, soroban_sdk::Vec<soroban_sdk::Vec<BytesN<32>>>) {
    use soroban_sdk::Bytes;

    let hash_pair = |a: &BytesN<32>, b: &BytesN<32>| -> BytesN<32> {
        let mut data = Bytes::new(env);
        data.push_back(0x01); // NODE_PREFIX

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
    };

    match leaves.len() {
        1 => {
            let root = leaves[0].clone();
            let mut proofs = soroban_sdk::Vec::new(env);
            proofs.push_back(soroban_sdk::Vec::new(env));
            (root, proofs)
        }
        2 => {
            let root = hash_pair(&leaves[0], &leaves[1]);
            let mut proofs = soroban_sdk::Vec::new(env);

            let mut proof0 = soroban_sdk::Vec::new(env);
            proof0.push_back(leaves[1].clone());
            proofs.push_back(proof0);

            let mut proof1 = soroban_sdk::Vec::new(env);
            proof1.push_back(leaves[0].clone());
            proofs.push_back(proof1);

            (root, proofs)
        }
        3 => {
            let n01 = hash_pair(&leaves[0], &leaves[1]);
            let root = hash_pair(&n01, &leaves[2]);

            let mut proofs = soroban_sdk::Vec::new(env);

            let mut proof0 = soroban_sdk::Vec::new(env);
            proof0.push_back(leaves[1].clone());
            proof0.push_back(leaves[2].clone());
            proofs.push_back(proof0);

            let mut proof1 = soroban_sdk::Vec::new(env);
            proof1.push_back(leaves[0].clone());
            proof1.push_back(leaves[2].clone());
            proofs.push_back(proof1);

            let mut proof2 = soroban_sdk::Vec::new(env);
            proof2.push_back(n01);
            proofs.push_back(proof2);

            (root, proofs)
        }
        4 => {
            let n01 = hash_pair(&leaves[0], &leaves[1]);
            let n23 = hash_pair(&leaves[2], &leaves[3]);
            let root = hash_pair(&n01, &n23);

            let mut proofs = soroban_sdk::Vec::new(env);

            let mut proof0 = soroban_sdk::Vec::new(env);
            proof0.push_back(leaves[1].clone());
            proof0.push_back(n23.clone());
            proofs.push_back(proof0);

            let mut proof1 = soroban_sdk::Vec::new(env);
            proof1.push_back(leaves[0].clone());
            proof1.push_back(n23.clone());
            proofs.push_back(proof1);

            let mut proof2 = soroban_sdk::Vec::new(env);
            proof2.push_back(leaves[3].clone());
            proof2.push_back(n01.clone());
            proofs.push_back(proof2);

            let mut proof3 = soroban_sdk::Vec::new(env);
            proof3.push_back(leaves[2].clone());
            proof3.push_back(n01);
            proofs.push_back(proof3);

            (root, proofs)
        }
        _ => panic!("build_merkle_tree only supports 1-4 leaves in tests"),
    }
}

struct TestEnv {
    env: Env,
    admin: Address,
    lmnr_token: Address,
    contract_id: Address,
}

fn setup_env() -> TestEnv {
    let env = Env::default();
    env.mock_all_auths();

    env.ledger().set(LedgerInfo {
        timestamp: 1000,
        protocol_version: 22,
        sequence_number: 100,
        network_id: [0u8; 32],
        base_reserve: 10,
        min_temp_entry_ttl: 100,
        min_persistent_entry_ttl: 100,
        max_entry_ttl: 10_000_000,
    });

    let admin = Address::generate(&env);
    let contract_id = env.register(LpStakingContract, ());

    let lmnr_admin = Address::generate(&env);
    let lmnr_token_id = env.register_stellar_asset_contract_v2(lmnr_admin.clone());
    let lmnr_token = lmnr_token_id.address();

    let client = LpStakingContractClient::new(&env, &contract_id);
    client.initialize(&admin, &lmnr_token, &462_962_963_i128);

    // Mint LMNR to admin and fund the contract
    let sac_admin = token::StellarAssetClient::new(&env, &lmnr_token);
    sac_admin.mint(&admin, &100_000_0000000_i128);
    let token_client = token::Client::new(&env, &lmnr_token);
    token_client.transfer(&admin, &contract_id, &50_000_0000000_i128);

    TestEnv {
        env,
        admin,
        lmnr_token,
        contract_id,
    }
}

fn make_pool_id(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
}

// ========== Tests ==========

#[test]
fn test_initialize() {
    let t = setup_env();
    let client = LpStakingContractClient::new(&t.env, &t.contract_id);
    assert_eq!(client.get_pool_count(), 0);
    assert_eq!(client.reward_balance(), 50_000_0000000_i128);
}

#[test]
fn test_double_initialize_fails() {
    let t = setup_env();
    let client = LpStakingContractClient::new(&t.env, &t.contract_id);
    let result = client.try_initialize(&t.admin, &t.lmnr_token, &100);
    assert!(result.is_err());
}

#[test]
fn test_add_pool() {
    let t = setup_env();
    let client = LpStakingContractClient::new(&t.env, &t.contract_id);
    let pool_id = make_pool_id(&t.env, 1);
    let index = client.add_pool(&t.admin, &pool_id);
    assert_eq!(index, 0);
    assert_eq!(client.get_pool_count(), 1);
    assert_eq!(client.get_pool_id(&0), pool_id);
}

#[test]
fn test_add_duplicate_pool_fails() {
    let t = setup_env();
    let client = LpStakingContractClient::new(&t.env, &t.contract_id);
    let pool_id = make_pool_id(&t.env, 1);
    client.add_pool(&t.admin, &pool_id);
    let result = client.try_add_pool(&t.admin, &pool_id);
    assert!(result.is_err());
}

#[test]
fn test_add_multiple_pools() {
    let t = setup_env();
    let client = LpStakingContractClient::new(&t.env, &t.contract_id);
    let pool1 = make_pool_id(&t.env, 1);
    let pool2 = make_pool_id(&t.env, 2);

    let idx1 = client.add_pool(&t.admin, &pool1);
    let idx2 = client.add_pool(&t.admin, &pool2);

    assert_eq!(idx1, 0);
    assert_eq!(idx2, 1);
    assert_eq!(client.get_pool_count(), 2);
}

#[test]
fn test_remove_pool() {
    let t = setup_env();
    let client = LpStakingContractClient::new(&t.env, &t.contract_id);
    let pool_id = make_pool_id(&t.env, 1);
    client.add_pool(&t.admin, &pool_id);
    client.remove_pool(&t.admin, &0);

    let state = client.get_pool_state(&0);
    assert_eq!(state.total_staked, 0);
}

#[test]
fn test_merkle_proof_single_leaf() {
    let t = setup_env();
    let client = LpStakingContractClient::new(&t.env, &t.contract_id);
    let pool_id = make_pool_id(&t.env, 1);
    client.add_pool(&t.admin, &pool_id);

    let user = Address::generate(&t.env);
    let lp_balance: i128 = 1_000_0000000;
    let epoch_id: u64 = 1;

    let leaf = merkle::compute_leaf(&t.env, 0, &user, lp_balance, epoch_id);
    let (root, proofs) = build_merkle_tree(&t.env, &[leaf.clone()]);

    client.set_merkle_root(&t.admin, &0, &root, &100);

    let merkle_data = client.get_merkle_root(&0);
    assert_eq!(merkle_data.root, root);
    assert_eq!(merkle_data.epoch_id, 1);

    let proof = proofs.get(0).unwrap();
    client.stake(&user, &0, &lp_balance, &proof);

    let staker = client.get_staker_info(&user, &0);
    assert_eq!(staker.staked_amount, lp_balance);
    assert_eq!(staker.epoch_id, 1);
}

#[test]
fn test_merkle_proof_multiple_leaves() {
    let t = setup_env();
    let client = LpStakingContractClient::new(&t.env, &t.contract_id);
    let pool_id = make_pool_id(&t.env, 1);
    client.add_pool(&t.admin, &pool_id);

    let user1 = Address::generate(&t.env);
    let user2 = Address::generate(&t.env);
    let user3 = Address::generate(&t.env);
    let bal1: i128 = 1_000_0000000;
    let bal2: i128 = 2_000_0000000;
    let bal3: i128 = 500_0000000;
    let epoch_id: u64 = 1;

    let leaf1 = merkle::compute_leaf(&t.env, 0, &user1, bal1, epoch_id);
    let leaf2 = merkle::compute_leaf(&t.env, 0, &user2, bal2, epoch_id);
    let leaf3 = merkle::compute_leaf(&t.env, 0, &user3, bal3, epoch_id);

    let (root, proofs) = build_merkle_tree(&t.env, &[leaf1, leaf2, leaf3]);
    client.set_merkle_root(&t.admin, &0, &root, &100);

    client.stake(&user1, &0, &bal1, &proofs.get(0).unwrap());
    client.stake(&user2, &0, &bal2, &proofs.get(1).unwrap());
    client.stake(&user3, &0, &bal3, &proofs.get(2).unwrap());

    let state = client.get_pool_state(&0);
    assert_eq!(state.total_staked, bal1 + bal2 + bal3);
}

#[test]
fn test_invalid_proof_rejected() {
    let t = setup_env();
    let client = LpStakingContractClient::new(&t.env, &t.contract_id);
    let pool_id = make_pool_id(&t.env, 1);
    client.add_pool(&t.admin, &pool_id);

    let user = Address::generate(&t.env);
    let lp_balance: i128 = 1_000_0000000;
    let epoch_id: u64 = 1;

    let leaf = merkle::compute_leaf(&t.env, 0, &user, lp_balance, epoch_id);
    let (root, _proofs) = build_merkle_tree(&t.env, &[leaf]);
    client.set_merkle_root(&t.admin, &0, &root, &100);

    // Use wrong balance in proof attempt
    let fake_proof: Vec<BytesN<32>> = Vec::new(&t.env);
    let result = client.try_stake(&user, &0, &(lp_balance + 1), &fake_proof);
    assert!(result.is_err());
}

#[test]
fn test_stake_claim_flow() {
    let t = setup_env();
    let client = LpStakingContractClient::new(&t.env, &t.contract_id);
    let pool_id = make_pool_id(&t.env, 1);
    client.add_pool(&t.admin, &pool_id);

    let user = Address::generate(&t.env);
    let lp_balance: i128 = 10_000_0000000;
    let epoch_id: u64 = 1;

    let leaf = merkle::compute_leaf(&t.env, 0, &user, lp_balance, epoch_id);
    let (root, proofs) = build_merkle_tree(&t.env, &[leaf]);
    client.set_merkle_root(&t.admin, &0, &root, &100);

    client.stake(&user, &0, &lp_balance, &proofs.get(0).unwrap());

    // Advance time by 1000 seconds
    t.env.ledger().set(LedgerInfo {
        timestamp: 2000,
        protocol_version: 22,
        sequence_number: 200,
        network_id: [0u8; 32],
        base_reserve: 10,
        min_temp_entry_ttl: 100,
        min_persistent_entry_ttl: 100,
        max_entry_ttl: 10_000_000,
    });

    // Check pending rewards
    let pending = client.pending_reward(&user, &0);
    // Expected: 1000 seconds * 462_962_963 stroops/sec = 462_962_963_000
    assert_eq!(pending, 462_962_963_000_i128);

    // Claim
    let claimed = client.claim(&user, &0);
    assert_eq!(claimed, 462_962_963_000_i128);

    // Pending should now be 0
    let pending_after = client.pending_reward(&user, &0);
    assert_eq!(pending_after, 0);
}

#[test]
fn test_multiple_stakers_share_rewards() {
    let t = setup_env();
    let client = LpStakingContractClient::new(&t.env, &t.contract_id);
    let pool_id = make_pool_id(&t.env, 1);
    client.add_pool(&t.admin, &pool_id);

    let user1 = Address::generate(&t.env);
    let user2 = Address::generate(&t.env);
    let bal1: i128 = 1_000_0000000;
    let bal2: i128 = 3_000_0000000;
    let epoch_id: u64 = 1;

    let leaf1 = merkle::compute_leaf(&t.env, 0, &user1, bal1, epoch_id);
    let leaf2 = merkle::compute_leaf(&t.env, 0, &user2, bal2, epoch_id);

    let (root, proofs) = build_merkle_tree(&t.env, &[leaf1, leaf2]);
    client.set_merkle_root(&t.admin, &0, &root, &100);

    client.stake(&user1, &0, &bal1, &proofs.get(0).unwrap());
    client.stake(&user2, &0, &bal2, &proofs.get(1).unwrap());

    // Advance 1000 seconds
    t.env.ledger().set(LedgerInfo {
        timestamp: 2000,
        protocol_version: 22,
        sequence_number: 200,
        network_id: [0u8; 32],
        base_reserve: 10,
        min_temp_entry_ttl: 100,
        min_persistent_entry_ttl: 100,
        max_entry_ttl: 10_000_000,
    });

    let pending1 = client.pending_reward(&user1, &0);
    let pending2 = client.pending_reward(&user2, &0);

    // Total rewards = 1000 * 462_962_963 = 462_962_963_000
    // user1 gets 1/4, user2 gets 3/4
    let total = 462_962_963_000_i128;
    assert_eq!(pending1, total / 4);
    assert_eq!(pending2, (total * 3) / 4);
}

#[test]
fn test_epoch_transition() {
    let t = setup_env();
    let client = LpStakingContractClient::new(&t.env, &t.contract_id);
    let pool_id = make_pool_id(&t.env, 1);
    client.add_pool(&t.admin, &pool_id);

    let user = Address::generate(&t.env);
    let lp_balance: i128 = 10_000_0000000;

    // Epoch 1
    let leaf1 = merkle::compute_leaf(&t.env, 0, &user, lp_balance, 1);
    let (root1, proofs1) = build_merkle_tree(&t.env, &[leaf1]);
    client.set_merkle_root(&t.admin, &0, &root1, &100);
    client.stake(&user, &0, &lp_balance, &proofs1.get(0).unwrap());

    // Advance time by 500 seconds
    t.env.ledger().set(LedgerInfo {
        timestamp: 1500,
        protocol_version: 22,
        sequence_number: 150,
        network_id: [0u8; 32],
        base_reserve: 10,
        min_temp_entry_ttl: 100,
        min_persistent_entry_ttl: 100,
        max_entry_ttl: 10_000_000,
    });

    let pending_before = client.pending_reward(&user, &0);
    assert!(pending_before > 0);

    // Post new epoch root (epoch 2) — resets total_staked
    let new_balance: i128 = 12_000_0000000;
    let leaf2 = merkle::compute_leaf(&t.env, 0, &user, new_balance, 2);
    let (root2, proofs2) = build_merkle_tree(&t.env, &[leaf2]);
    client.set_merkle_root(&t.admin, &0, &root2, &150);

    // User re-stakes with new proof
    client.stake(&user, &0, &new_balance, &proofs2.get(0).unwrap());

    let staker = client.get_staker_info(&user, &0);
    assert_eq!(staker.epoch_id, 2);
    assert_eq!(staker.staked_amount, new_balance);
    // Pending rewards from epoch 1 should be preserved
    assert!(staker.pending_rewards > 0);
}

#[test]
fn test_stale_staker_can_claim_pending() {
    let t = setup_env();
    let client = LpStakingContractClient::new(&t.env, &t.contract_id);
    let pool_id = make_pool_id(&t.env, 1);
    client.add_pool(&t.admin, &pool_id);

    let user = Address::generate(&t.env);
    let lp_balance: i128 = 10_000_0000000;

    // Epoch 1: stake
    let leaf1 = merkle::compute_leaf(&t.env, 0, &user, lp_balance, 1);
    let (root1, proofs1) = build_merkle_tree(&t.env, &[leaf1]);
    client.set_merkle_root(&t.admin, &0, &root1, &100);
    client.stake(&user, &0, &lp_balance, &proofs1.get(0).unwrap());

    // Advance time
    t.env.ledger().set(LedgerInfo {
        timestamp: 2000,
        protocol_version: 22,
        sequence_number: 200,
        network_id: [0u8; 32],
        base_reserve: 10,
        min_temp_entry_ttl: 100,
        min_persistent_entry_ttl: 100,
        max_entry_ttl: 10_000_000,
    });

    // Post epoch 2 without user re-staking
    let another_user = Address::generate(&t.env);
    let leaf2 = merkle::compute_leaf(&t.env, 0, &another_user, lp_balance, 2);
    let (root2, _) = build_merkle_tree(&t.env, &[leaf2]);
    client.set_merkle_root(&t.admin, &0, &root2, &200);

    // Advance more time
    t.env.ledger().set(LedgerInfo {
        timestamp: 3000,
        protocol_version: 22,
        sequence_number: 300,
        network_id: [0u8; 32],
        base_reserve: 10,
        min_temp_entry_ttl: 100,
        min_persistent_entry_ttl: 100,
        max_entry_ttl: 10_000_000,
    });

    // Stale user's pending should be their epoch 1 rewards only
    // Epoch 1 rewards: 1000 sec * 462_962_963 = 462_962_963_000
    let pending = client.pending_reward(&user, &0);
    assert_eq!(pending, 462_962_963_000_i128);

    // They can still claim
    let claimed = client.claim(&user, &0);
    assert_eq!(claimed, 462_962_963_000_i128);
}

#[test]
fn test_double_stake_same_epoch_rejected() {
    let t = setup_env();
    let client = LpStakingContractClient::new(&t.env, &t.contract_id);
    let pool_id = make_pool_id(&t.env, 1);
    client.add_pool(&t.admin, &pool_id);

    let user = Address::generate(&t.env);
    let lp_balance: i128 = 1_000_0000000;
    let epoch_id: u64 = 1;

    let leaf = merkle::compute_leaf(&t.env, 0, &user, lp_balance, epoch_id);
    let (root, proofs) = build_merkle_tree(&t.env, &[leaf]);
    client.set_merkle_root(&t.admin, &0, &root, &100);

    let proof = proofs.get(0).unwrap();
    client.stake(&user, &0, &lp_balance, &proof);

    // Second stake same epoch should fail
    let result = client.try_stake(&user, &0, &lp_balance, &proof);
    assert!(result.is_err());
}

#[test]
fn test_unstake() {
    let t = setup_env();
    let client = LpStakingContractClient::new(&t.env, &t.contract_id);
    let pool_id = make_pool_id(&t.env, 1);
    client.add_pool(&t.admin, &pool_id);

    let user = Address::generate(&t.env);
    let lp_balance: i128 = 10_000_0000000;
    let epoch_id: u64 = 1;

    let leaf = merkle::compute_leaf(&t.env, 0, &user, lp_balance, epoch_id);
    let (root, proofs) = build_merkle_tree(&t.env, &[leaf]);
    client.set_merkle_root(&t.admin, &0, &root, &100);
    client.stake(&user, &0, &lp_balance, &proofs.get(0).unwrap());

    // Advance 1000 seconds
    t.env.ledger().set(LedgerInfo {
        timestamp: 2000,
        protocol_version: 22,
        sequence_number: 200,
        network_id: [0u8; 32],
        base_reserve: 10,
        min_temp_entry_ttl: 100,
        min_persistent_entry_ttl: 100,
        max_entry_ttl: 10_000_000,
    });

    // Unstake
    client.unstake(&user, &0);

    // Pool total should be 0
    let state = client.get_pool_state(&0);
    assert_eq!(state.total_staked, 0);

    // Staker should still have pending rewards
    let staker = client.get_staker_info(&user, &0);
    assert_eq!(staker.staked_amount, 0);
    assert_eq!(staker.pending_rewards, 462_962_963_000_i128);

    // Can still claim after unstaking
    let claimed = client.claim(&user, &0);
    assert_eq!(claimed, 462_962_963_000_i128);
}

#[test]
fn test_set_reward_rate() {
    let t = setup_env();
    let client = LpStakingContractClient::new(&t.env, &t.contract_id);
    let pool_id = make_pool_id(&t.env, 1);
    client.add_pool(&t.admin, &pool_id);

    let user = Address::generate(&t.env);
    let lp_balance: i128 = 10_000_0000000;
    let epoch_id: u64 = 1;

    let leaf = merkle::compute_leaf(&t.env, 0, &user, lp_balance, epoch_id);
    let (root, proofs) = build_merkle_tree(&t.env, &[leaf]);
    client.set_merkle_root(&t.admin, &0, &root, &100);
    client.stake(&user, &0, &lp_balance, &proofs.get(0).unwrap());

    // Advance 500 seconds at original rate
    t.env.ledger().set(LedgerInfo {
        timestamp: 1500,
        protocol_version: 22,
        sequence_number: 150,
        network_id: [0u8; 32],
        base_reserve: 10,
        min_temp_entry_ttl: 100,
        min_persistent_entry_ttl: 100,
        max_entry_ttl: 10_000_000,
    });

    // Double the rate
    let new_rate = 462_962_963_i128 * 2;
    client.set_reward_rate(&t.admin, &new_rate);

    // Advance another 500 seconds at double rate
    t.env.ledger().set(LedgerInfo {
        timestamp: 2000,
        protocol_version: 22,
        sequence_number: 200,
        network_id: [0u8; 32],
        base_reserve: 10,
        min_temp_entry_ttl: 100,
        min_persistent_entry_ttl: 100,
        max_entry_ttl: 10_000_000,
    });

    let pending = client.pending_reward(&user, &0);
    // First 500s: 500 * 462_962_963 = 231_481_481_500
    // Next 500s:  500 * 925_925_926 = 462_962_963_000
    let expected = 500_i128 * 462_962_963 + 500_i128 * new_rate;
    assert_eq!(pending, expected);
}

#[test]
fn test_fund() {
    let t = setup_env();
    let client = LpStakingContractClient::new(&t.env, &t.contract_id);

    let initial = client.reward_balance();
    assert_eq!(initial, 50_000_0000000_i128);

    client.fund(&t.admin, &10_000_0000000_i128);
    assert_eq!(client.reward_balance(), 60_000_0000000_i128);
}

#[test]
fn test_fund_zero_fails() {
    let t = setup_env();
    let client = LpStakingContractClient::new(&t.env, &t.contract_id);
    let result = client.try_fund(&t.admin, &0_i128);
    assert!(result.is_err());
}

#[test]
fn test_no_stake_claim_fails() {
    let t = setup_env();
    let client = LpStakingContractClient::new(&t.env, &t.contract_id);
    let pool_id = make_pool_id(&t.env, 1);
    client.add_pool(&t.admin, &pool_id);

    let user = Address::generate(&t.env);
    let result = client.try_claim(&user, &0);
    assert!(result.is_err());
}

#[test]
fn test_stake_no_merkle_root_fails() {
    let t = setup_env();
    let client = LpStakingContractClient::new(&t.env, &t.contract_id);
    let pool_id = make_pool_id(&t.env, 1);
    client.add_pool(&t.admin, &pool_id);

    let user = Address::generate(&t.env);
    let empty_proof: Vec<BytesN<32>> = Vec::new(&t.env);
    let result = client.try_stake(&user, &0, &1_000_0000000_i128, &empty_proof);
    assert!(result.is_err());
}

#[test]
fn test_invalid_pool_index() {
    let t = setup_env();
    let client = LpStakingContractClient::new(&t.env, &t.contract_id);
    let user = Address::generate(&t.env);
    let empty_proof: Vec<BytesN<32>> = Vec::new(&t.env);

    let result = client.try_stake(&user, &0, &1_000_0000000_i128, &empty_proof);
    assert!(result.is_err());
}

#[test]
fn test_four_leaf_merkle_tree() {
    let t = setup_env();
    let client = LpStakingContractClient::new(&t.env, &t.contract_id);
    let pool_id = make_pool_id(&t.env, 1);
    client.add_pool(&t.admin, &pool_id);

    let users: [Address; 4] = [
        Address::generate(&t.env),
        Address::generate(&t.env),
        Address::generate(&t.env),
        Address::generate(&t.env),
    ];
    let balances: [i128; 4] = [1_000_0000000, 2_000_0000000, 3_000_0000000, 4_000_0000000];
    let epoch_id: u64 = 1;

    let leaves: [BytesN<32>; 4] = [
        merkle::compute_leaf(&t.env, 0, &users[0], balances[0], epoch_id),
        merkle::compute_leaf(&t.env, 0, &users[1], balances[1], epoch_id),
        merkle::compute_leaf(&t.env, 0, &users[2], balances[2], epoch_id),
        merkle::compute_leaf(&t.env, 0, &users[3], balances[3], epoch_id),
    ];

    let (root, proofs) = build_merkle_tree(&t.env, &leaves);
    client.set_merkle_root(&t.admin, &0, &root, &100);

    for i in 0..4 {
        client.stake(&users[i], &0, &balances[i], &proofs.get(i as u32).unwrap());
    }

    let state = client.get_pool_state(&0);
    let total: i128 = balances.iter().sum();
    assert_eq!(state.total_staked, total);

    // Advance time and check proportional rewards
    t.env.ledger().set(LedgerInfo {
        timestamp: 2000,
        protocol_version: 22,
        sequence_number: 200,
        network_id: [0u8; 32],
        base_reserve: 10,
        min_temp_entry_ttl: 100,
        min_persistent_entry_ttl: 100,
        max_entry_ttl: 10_000_000,
    });

    let total_rewards = 1000_i128 * 462_962_963;
    for i in 0..4 {
        let pending = client.pending_reward(&users[i], &0);
        let expected = (total_rewards * balances[i]) / total;
        assert_eq!(pending, expected);
    }
}

#[test]
fn test_set_admin() {
    let t = setup_env();
    let client = LpStakingContractClient::new(&t.env, &t.contract_id);

    let new_admin = Address::generate(&t.env);

    // Transfer admin to new_admin
    client.set_admin(&t.admin, &new_admin);

    // Old admin can no longer add pools
    let pool_id = BytesN::from_array(&t.env, &[0xAA; 32]);
    let result = client.try_add_pool(&t.admin, &pool_id);
    assert!(result.is_err());

    // New admin can add pools
    let result = client.try_add_pool(&new_admin, &pool_id);
    assert!(result.is_ok());
}

#[test]
fn test_set_admin_non_admin_fails() {
    let t = setup_env();
    let client = LpStakingContractClient::new(&t.env, &t.contract_id);

    let rando = Address::generate(&t.env);
    let new_admin = Address::generate(&t.env);

    let result = client.try_set_admin(&rando, &new_admin);
    assert!(result.is_err());
}

// ========== update_stake tests ==========

#[test]
fn test_update_stake_increase() {
    let t = setup_env();
    let client = LpStakingContractClient::new(&t.env, &t.contract_id);
    let pool_id = make_pool_id(&t.env, 1);
    client.add_pool(&t.admin, &pool_id);

    let user = Address::generate(&t.env);
    let lp_balance: i128 = 10_000_0000000;
    let epoch_id: u64 = 1;

    // Stake via merkle proof first
    let leaf = merkle::compute_leaf(&t.env, 0, &user, lp_balance, epoch_id);
    let (root, proofs) = build_merkle_tree(&t.env, &[leaf]);
    client.set_merkle_root(&t.admin, &0, &root, &100);
    client.stake(&user, &0, &lp_balance, &proofs.get(0).unwrap());

    // Advance time so rewards accrue
    t.env.ledger().set(LedgerInfo {
        timestamp: 2000,
        protocol_version: 22,
        sequence_number: 200,
        network_id: [0u8; 32],
        base_reserve: 10,
        min_temp_entry_ttl: 100,
        min_persistent_entry_ttl: 100,
        max_entry_ttl: 10_000_000,
    });

    let pending_before = client.pending_reward(&user, &0);
    assert!(pending_before > 0);

    // Admin increases stake
    let new_amount: i128 = 20_000_0000000;
    client.update_stake(&t.admin, &user, &0, &new_amount);

    let staker = client.get_staker_info(&user, &0);
    assert_eq!(staker.staked_amount, new_amount);
    // Pending rewards should be preserved
    assert_eq!(staker.pending_rewards, pending_before);

    let state = client.get_pool_state(&0);
    assert_eq!(state.total_staked, new_amount);
}

#[test]
fn test_update_stake_decrease() {
    let t = setup_env();
    let client = LpStakingContractClient::new(&t.env, &t.contract_id);
    let pool_id = make_pool_id(&t.env, 1);
    client.add_pool(&t.admin, &pool_id);

    let user = Address::generate(&t.env);
    let lp_balance: i128 = 10_000_0000000;
    let epoch_id: u64 = 1;

    let leaf = merkle::compute_leaf(&t.env, 0, &user, lp_balance, epoch_id);
    let (root, proofs) = build_merkle_tree(&t.env, &[leaf]);
    client.set_merkle_root(&t.admin, &0, &root, &100);
    client.stake(&user, &0, &lp_balance, &proofs.get(0).unwrap());

    // Advance time
    t.env.ledger().set(LedgerInfo {
        timestamp: 2000,
        protocol_version: 22,
        sequence_number: 200,
        network_id: [0u8; 32],
        base_reserve: 10,
        min_temp_entry_ttl: 100,
        min_persistent_entry_ttl: 100,
        max_entry_ttl: 10_000_000,
    });

    let pending_before = client.pending_reward(&user, &0);

    // Admin decreases stake
    let new_amount: i128 = 5_000_0000000;
    client.update_stake(&t.admin, &user, &0, &new_amount);

    let staker = client.get_staker_info(&user, &0);
    assert_eq!(staker.staked_amount, new_amount);
    assert_eq!(staker.pending_rewards, pending_before);

    let state = client.get_pool_state(&0);
    assert_eq!(state.total_staked, new_amount);
}

#[test]
fn test_update_stake_to_zero() {
    let t = setup_env();
    let client = LpStakingContractClient::new(&t.env, &t.contract_id);
    let pool_id = make_pool_id(&t.env, 1);
    client.add_pool(&t.admin, &pool_id);

    let user = Address::generate(&t.env);
    let lp_balance: i128 = 10_000_0000000;
    let epoch_id: u64 = 1;

    let leaf = merkle::compute_leaf(&t.env, 0, &user, lp_balance, epoch_id);
    let (root, proofs) = build_merkle_tree(&t.env, &[leaf]);
    client.set_merkle_root(&t.admin, &0, &root, &100);
    client.stake(&user, &0, &lp_balance, &proofs.get(0).unwrap());

    // Advance time
    t.env.ledger().set(LedgerInfo {
        timestamp: 2000,
        protocol_version: 22,
        sequence_number: 200,
        network_id: [0u8; 32],
        base_reserve: 10,
        min_temp_entry_ttl: 100,
        min_persistent_entry_ttl: 100,
        max_entry_ttl: 10_000_000,
    });

    let pending_before = client.pending_reward(&user, &0);
    assert!(pending_before > 0);

    // Admin sets stake to zero (kicks staker)
    client.update_stake(&t.admin, &user, &0, &0);

    let staker = client.get_staker_info(&user, &0);
    assert_eq!(staker.staked_amount, 0);
    // Pending rewards preserved for claiming
    assert_eq!(staker.pending_rewards, pending_before);

    let state = client.get_pool_state(&0);
    assert_eq!(state.total_staked, 0);

    // User can still claim
    let claimed = client.claim(&user, &0);
    assert_eq!(claimed, pending_before);
}

#[test]
fn test_update_stake_new_user() {
    let t = setup_env();
    let client = LpStakingContractClient::new(&t.env, &t.contract_id);
    let pool_id = make_pool_id(&t.env, 1);
    client.add_pool(&t.admin, &pool_id);

    // Post merkle root so there's a current epoch
    let dummy_user = Address::generate(&t.env);
    let leaf = merkle::compute_leaf(&t.env, 0, &dummy_user, 1_000_0000000, 1);
    let (root, _) = build_merkle_tree(&t.env, &[leaf]);
    client.set_merkle_root(&t.admin, &0, &root, &100);

    // Admin creates stake for a user who never staked via proof
    let new_user = Address::generate(&t.env);
    let amount: i128 = 5_000_0000000;
    client.update_stake(&t.admin, &new_user, &0, &amount);

    let staker = client.get_staker_info(&new_user, &0);
    assert_eq!(staker.staked_amount, amount);
    assert_eq!(staker.epoch_id, 1);
    assert_eq!(staker.pending_rewards, 0);

    let state = client.get_pool_state(&0);
    assert_eq!(state.total_staked, amount);
}

#[test]
fn test_update_stake_non_admin_fails() {
    let t = setup_env();
    let client = LpStakingContractClient::new(&t.env, &t.contract_id);
    let pool_id = make_pool_id(&t.env, 1);
    client.add_pool(&t.admin, &pool_id);

    let rando = Address::generate(&t.env);
    let user = Address::generate(&t.env);
    let result = client.try_update_stake(&rando, &user, &0, &1_000_0000000);
    assert!(result.is_err());
}

#[test]
fn test_update_stake_stale_staker() {
    let t = setup_env();
    let client = LpStakingContractClient::new(&t.env, &t.contract_id);
    let pool_id = make_pool_id(&t.env, 1);
    client.add_pool(&t.admin, &pool_id);

    let user = Address::generate(&t.env);
    let lp_balance: i128 = 10_000_0000000;

    // Epoch 1: stake
    let leaf1 = merkle::compute_leaf(&t.env, 0, &user, lp_balance, 1);
    let (root1, proofs1) = build_merkle_tree(&t.env, &[leaf1]);
    client.set_merkle_root(&t.admin, &0, &root1, &100);
    client.stake(&user, &0, &lp_balance, &proofs1.get(0).unwrap());

    // Advance time by 1000 seconds
    t.env.ledger().set(LedgerInfo {
        timestamp: 2000,
        protocol_version: 22,
        sequence_number: 200,
        network_id: [0u8; 32],
        base_reserve: 10,
        min_temp_entry_ttl: 100,
        min_persistent_entry_ttl: 100,
        max_entry_ttl: 10_000_000,
    });

    // Post epoch 2 (user is now stale)
    let other = Address::generate(&t.env);
    let leaf2 = merkle::compute_leaf(&t.env, 0, &other, lp_balance, 2);
    let (root2, _) = build_merkle_tree(&t.env, &[leaf2]);
    client.set_merkle_root(&t.admin, &0, &root2, &200);

    // Advance more time
    t.env.ledger().set(LedgerInfo {
        timestamp: 3000,
        protocol_version: 22,
        sequence_number: 300,
        network_id: [0u8; 32],
        base_reserve: 10,
        min_temp_entry_ttl: 100,
        min_persistent_entry_ttl: 100,
        max_entry_ttl: 10_000_000,
    });

    // Stale staker's pending should be epoch 1 rewards only
    let stale_pending = client.pending_reward(&user, &0);
    assert_eq!(stale_pending, 462_962_963_000_i128);

    // Admin updates stale staker's balance
    let new_amount: i128 = 15_000_0000000;
    client.update_stake(&t.admin, &user, &0, &new_amount);

    let staker = client.get_staker_info(&user, &0);
    assert_eq!(staker.staked_amount, new_amount);
    assert_eq!(staker.epoch_id, 2); // Updated to current epoch
    // Stale rewards should be preserved
    assert_eq!(staker.pending_rewards, stale_pending);
}

// ========== withdraw tests ==========

#[test]
fn test_withdraw_success() {
    let t = setup_env();
    let client = LpStakingContractClient::new(&t.env, &t.contract_id);

    let initial_balance = client.reward_balance();
    assert_eq!(initial_balance, 50_000_0000000_i128);

    let withdraw_amount = 10_000_0000000_i128;
    client.withdraw(&t.admin, &withdraw_amount);

    assert_eq!(client.reward_balance(), 40_000_0000000_i128);

    // Admin's LMNR balance should have increased
    let token_client = token::Client::new(&t.env, &t.lmnr_token);
    let admin_balance = token_client.balance(&t.admin);
    // Admin started with 100k, funded 50k to contract, got 10k back = 60k
    assert_eq!(admin_balance, 60_000_0000000_i128);
}

#[test]
fn test_withdraw_non_admin_fails() {
    let t = setup_env();
    let client = LpStakingContractClient::new(&t.env, &t.contract_id);

    let rando = Address::generate(&t.env);
    let result = client.try_withdraw(&rando, &10_000_0000000_i128);
    assert!(result.is_err());
}

#[test]
fn test_withdraw_exceeds_balance_fails() {
    let t = setup_env();
    let client = LpStakingContractClient::new(&t.env, &t.contract_id);

    let result = client.try_withdraw(&t.admin, &100_000_0000000_i128);
    assert!(result.is_err());
}
