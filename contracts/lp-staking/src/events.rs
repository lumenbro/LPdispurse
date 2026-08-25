use soroban_sdk::{contractevent, Address, BytesN};

/// Auditable state-change events. Indexers and the reconciliation cron can
/// follow these instead of diffing storage.

#[contractevent]
pub struct PoolAdded {
    #[topic]
    pub pool_index: u32,
    pub pool_id: BytesN<32>,
    pub reward_rate: i128,
}

#[contractevent]
pub struct PoolRemoved {
    #[topic]
    pub pool_index: u32,
}

#[contractevent]
pub struct RateChanged {
    #[topic]
    pub pool_index: u32,
    pub old_rate: i128,
    pub new_rate: i128,
}

#[contractevent]
pub struct RootPosted {
    #[topic]
    pub pool_index: u32,
    pub epoch_id: u64,
    pub root: BytesN<32>,
    pub snapshot_ledger: u32,
    pub total_lp: i128,
}

#[contractevent]
pub struct Staked {
    #[topic]
    pub user: Address,
    #[topic]
    pub pool_index: u32,
    pub amount: i128,
    pub epoch_id: u64,
}

#[contractevent]
pub struct StakeUpdated {
    #[topic]
    pub user: Address,
    #[topic]
    pub pool_index: u32,
    pub old_amount: i128,
    pub new_amount: i128,
    pub epoch_id: u64,
    /// Distinguishes admin reconciliation from operator (decrease-only) calls.
    pub by_admin: bool,
}

#[contractevent]
pub struct Unstaked {
    #[topic]
    pub user: Address,
    #[topic]
    pub pool_index: u32,
    pub amount: i128,
}

#[contractevent]
pub struct Claimed {
    #[topic]
    pub user: Address,
    #[topic]
    pub pool_index: u32,
    pub amount: i128,
}

#[contractevent]
pub struct Funded {
    #[topic]
    pub funder: Address,
    pub amount: i128,
}

#[contractevent]
pub struct Withdrawn {
    #[topic]
    pub admin: Address,
    pub amount: i128,
}

#[contractevent]
pub struct AdminProposed {
    #[topic]
    pub pending_admin: Address,
}

#[contractevent]
pub struct AdminTransferred {
    #[topic]
    pub old_admin: Address,
    #[topic]
    pub new_admin: Address,
}

#[contractevent]
pub struct OperatorChanged {
    pub old_operator: Option<Address>,
    #[topic]
    pub new_operator: Address,
}

#[contractevent]
pub struct RewardTokenChanged {
    #[topic]
    pub old_token: Address,
    #[topic]
    pub new_token: Address,
}
