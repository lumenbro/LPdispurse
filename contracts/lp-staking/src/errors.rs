use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ContractError {
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
}
