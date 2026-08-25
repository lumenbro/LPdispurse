use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ContractError {
    // --- carried over from v1 (stable numbering) ---
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    PoolAlreadyExists = 4,
    PoolNotFound = 5,
    InvalidProof = 6,
    AlreadyStakedThisEpoch = 7,
    NoStakeFound = 8,
    NoRewardsToClaim = 9,
    InsufficientRewardBalance = 10,
    InvalidAmount = 11,
    NoMerkleRoot = 12,
    StaleEpoch = 13,

    // --- v2 additions ---
    /// Checked arithmetic overflowed. Never silently wraps or truncates.
    MathOverflow = 14,
    /// Pool has been deactivated; no new stakes or roots accepted.
    PoolInactive = 15,
    /// Reward rate outside [0, MAX_REWARD_RATE].
    InvalidRewardRate = 16,
    /// The frozen accumulator snapshot for a stale staker's epoch is missing
    /// (archived). Restore the entry rather than settling against wrong state.
    EpochSnapshotMissing = 17,
    /// snapshot_ledger must strictly increase across epochs.
    StaleSnapshotLedger = 18,
    /// accept_admin called with no pending transfer, or by the wrong address.
    NoPendingAdmin = 19,
    /// Non-zero stake below MIN_STAKE (guards accumulator overflow).
    StakeBelowMinimum = 20,
    /// Merkle proof exceeds MAX_PROOF_LEN.
    ProofTooLong = 21,
    /// Pool state entry missing/archived. Never silently defaulted to zero.
    PoolStateMissing = 22,

    // --- round 2 (post peer-review) ---
    /// Stake above MAX_STAKE. Guarantees stake x accumulator stays settleable.
    StakeAboveMaximum = 23,
    /// snapshot_ledger in the future, or older than MAX_SNAPSHOT_AGE.
    InvalidSnapshotLedger = 24,
    /// Epoch total_lp outside [MIN_STAKE, MAX_STAKE].
    InvalidTotalLp = 25,
    /// Proven balance exceeds the epoch's declared total_lp.
    StakeExceedsTotalLp = 26,
    /// Operator may only decrease an existing stake; increases need a proof.
    OperatorCannotIncrease = 27,
}
