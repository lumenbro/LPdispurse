import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}




export const ContractError = {
  1: {message:"AlreadyInitialized"},
  2: {message:"NotInitialized"},
  3: {message:"Unauthorized"},
  4: {message:"PoolAlreadyExists"},
  5: {message:"PoolNotFound"},
  6: {message:"InvalidProof"},
  7: {message:"AlreadyStakedThisEpoch"},
  8: {message:"NoStakeFound"},
  9: {message:"NoRewardsToClaim"},
  10: {message:"InsufficientRewardBalance"},
  11: {message:"InvalidAmount"},
  12: {message:"NoMerkleRoot"},
  13: {message:"StaleEpoch"}
}

export type DataKey = {tag: "Admin", values: void} | {tag: "LmnrToken", values: void} | {tag: "RewardRatePerSec", values: void} | {tag: "PoolCount", values: void} | {tag: "PoolId", values: readonly [u32]} | {tag: "PoolIdIndex", values: readonly [Buffer]} | {tag: "PoolState", values: readonly [u32]} | {tag: "MerkleRoot", values: readonly [u32]} | {tag: "Staker", values: readonly [string, u32]};


export interface PoolState {
  acc_reward_per_share: i128;
  last_reward_time: u64;
  prev_acc_reward_per_share: i128;
  total_staked: i128;
}


export interface StakerInfo {
  epoch_id: u64;
  pending_rewards: i128;
  reward_debt: i128;
  staked_amount: i128;
}


export interface MerkleRootData {
  epoch_id: u64;
  posted_at: u64;
  root: Buffer;
  snapshot_ledger: u32;
}

export interface Client {
  /**
   * Construct and simulate a fund transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Transfer LMNR into the contract for reward distribution.
   */
  fund: ({funder, amount}: {funder: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a claim transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Claim accumulated LMNR rewards. Returns amount claimed.
   */
  claim: ({user, pool_index}: {user: string, pool_index: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a stake transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Prove LP position via Merkle proof and start earning rewards.
   */
  stake: ({user, pool_index, lp_balance, proof}: {user: string, pool_index: u32, lp_balance: i128, proof: Array<Buffer>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a unstake transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Stop earning rewards. Pending rewards are preserved for later claiming.
   */
  unstake: ({user, pool_index}: {user: string, pool_index: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a add_pool transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Register a new SDEX liquidity pool for staking.
   */
  add_pool: ({admin, pool_id}: {admin: string, pool_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

  /**
   * Construct and simulate a initialize transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * One-time initialization.
   */
  initialize: ({admin, lmnr_token, reward_rate_per_sec}: {admin: string, lmnr_token: string, reward_rate_per_sec: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_pool_id transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Pool hash at a given index.
   */
  get_pool_id: ({pool_index}: {pool_index: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Buffer>>

  /**
   * Construct and simulate a remove_pool transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Deactivate a pool. Settles rewards first, then resets total_staked.
   * Users can still claim pending rewards after removal.
   */
  remove_pool: ({admin, pool_index}: {admin: string, pool_index: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_pool_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Number of registered pools.
   */
  get_pool_count: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a get_pool_state transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Query pool accumulator state.
   */
  get_pool_state: ({pool_index}: {pool_index: u32}, options?: MethodOptions) => Promise<AssembledTransaction<PoolState>>

  /**
   * Construct and simulate a pending_reward transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Query unclaimed rewards for a user in a pool.
   */
  pending_reward: ({user, pool_index}: {user: string, pool_index: u32}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a reward_balance transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Contract's LMNR balance available for rewards.
   */
  reward_balance: (options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a get_merkle_root transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Query current epoch Merkle root for a pool.
   */
  get_merkle_root: ({pool_index}: {pool_index: u32}, options?: MethodOptions) => Promise<AssembledTransaction<MerkleRootData>>

  /**
   * Construct and simulate a get_staker_info transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Query stake details for a user.
   */
  get_staker_info: ({user, pool_index}: {user: string, pool_index: u32}, options?: MethodOptions) => Promise<AssembledTransaction<StakerInfo>>

  /**
   * Construct and simulate a set_merkle_root transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Post a new Merkle root for a pool's LP snapshots.
   * Resets total_staked — all users must re-prove to continue earning.
   */
  set_merkle_root: ({admin, pool_index, root, snapshot_ledger}: {admin: string, pool_index: u32, root: Buffer, snapshot_ledger: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_reward_rate transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Update the global reward rate (LMNR stroops per second).
   * Updates all active pools' accumulators before changing rate.
   */
  set_reward_rate: ({admin, new_rate}: {admin: string, new_rate: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy(null, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAAAAAAADhUcmFuc2ZlciBMTU5SIGludG8gdGhlIGNvbnRyYWN0IGZvciByZXdhcmQgZGlzdHJpYnV0aW9uLgAAAARmdW5kAAAAAgAAAAAAAAAGZnVuZGVyAAAAAAATAAAAAAAAAAZhbW91bnQAAAAAAAsAAAABAAAD6QAAA+0AAAAAAAAH0AAAAA1Db250cmFjdEVycm9yAAAA",
        "AAAAAAAAADdDbGFpbSBhY2N1bXVsYXRlZCBMTU5SIHJld2FyZHMuIFJldHVybnMgYW1vdW50IGNsYWltZWQuAAAAAAVjbGFpbQAAAAAAAAIAAAAAAAAABHVzZXIAAAATAAAAAAAAAApwb29sX2luZGV4AAAAAAAEAAAAAQAAA+kAAAALAAAH0AAAAA1Db250cmFjdEVycm9yAAAA",
        "AAAAAAAAAD1Qcm92ZSBMUCBwb3NpdGlvbiB2aWEgTWVya2xlIHByb29mIGFuZCBzdGFydCBlYXJuaW5nIHJld2FyZHMuAAAAAAAABXN0YWtlAAAAAAAABAAAAAAAAAAEdXNlcgAAABMAAAAAAAAACnBvb2xfaW5kZXgAAAAAAAQAAAAAAAAACmxwX2JhbGFuY2UAAAAAAAsAAAAAAAAABXByb29mAAAAAAAD6gAAA+4AAAAgAAAAAQAAA+kAAAPtAAAAAAAAB9AAAAANQ29udHJhY3RFcnJvcgAAAA==",
        "AAAAAAAAAEdTdG9wIGVhcm5pbmcgcmV3YXJkcy4gUGVuZGluZyByZXdhcmRzIGFyZSBwcmVzZXJ2ZWQgZm9yIGxhdGVyIGNsYWltaW5nLgAAAAAHdW5zdGFrZQAAAAACAAAAAAAAAAR1c2VyAAAAEwAAAAAAAAAKcG9vbF9pbmRleAAAAAAABAAAAAEAAAPpAAAD7QAAAAAAAAfQAAAADUNvbnRyYWN0RXJyb3IAAAA=",
        "AAAAAAAAAC9SZWdpc3RlciBhIG5ldyBTREVYIGxpcXVpZGl0eSBwb29sIGZvciBzdGFraW5nLgAAAAAIYWRkX3Bvb2wAAAACAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAAAAAAB3Bvb2xfaWQAAAAD7gAAACAAAAABAAAD6QAAAAQAAAfQAAAADUNvbnRyYWN0RXJyb3IAAAA=",
        "AAAAAAAAABhPbmUtdGltZSBpbml0aWFsaXphdGlvbi4AAAAKaW5pdGlhbGl6ZQAAAAAAAwAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAAAAAApsbW5yX3Rva2VuAAAAAAATAAAAAAAAABNyZXdhcmRfcmF0ZV9wZXJfc2VjAAAAAAsAAAABAAAD6QAAA+0AAAAAAAAH0AAAAA1Db250cmFjdEVycm9yAAAA",
        "AAAAAAAAABtQb29sIGhhc2ggYXQgYSBnaXZlbiBpbmRleC4AAAAAC2dldF9wb29sX2lkAAAAAAEAAAAAAAAACnBvb2xfaW5kZXgAAAAAAAQAAAABAAAD7gAAACA=",
        "AAAAAAAAAHhEZWFjdGl2YXRlIGEgcG9vbC4gU2V0dGxlcyByZXdhcmRzIGZpcnN0LCB0aGVuIHJlc2V0cyB0b3RhbF9zdGFrZWQuClVzZXJzIGNhbiBzdGlsbCBjbGFpbSBwZW5kaW5nIHJld2FyZHMgYWZ0ZXIgcmVtb3ZhbC4AAAALcmVtb3ZlX3Bvb2wAAAAAAgAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAAAAAApwb29sX2luZGV4AAAAAAAEAAAAAQAAA+kAAAPtAAAAAAAAB9AAAAANQ29udHJhY3RFcnJvcgAAAA==",
        "AAAAAAAAABtOdW1iZXIgb2YgcmVnaXN0ZXJlZCBwb29scy4AAAAADmdldF9wb29sX2NvdW50AAAAAAAAAAAAAQAAAAQ=",
        "AAAAAAAAAB1RdWVyeSBwb29sIGFjY3VtdWxhdG9yIHN0YXRlLgAAAAAAAA5nZXRfcG9vbF9zdGF0ZQAAAAAAAQAAAAAAAAAKcG9vbF9pbmRleAAAAAAABAAAAAEAAAfQAAAACVBvb2xTdGF0ZQAAAA==",
        "AAAAAAAAAC1RdWVyeSB1bmNsYWltZWQgcmV3YXJkcyBmb3IgYSB1c2VyIGluIGEgcG9vbC4AAAAAAAAOcGVuZGluZ19yZXdhcmQAAAAAAAIAAAAAAAAABHVzZXIAAAATAAAAAAAAAApwb29sX2luZGV4AAAAAAAEAAAAAQAAAAs=",
        "AAAAAAAAAC5Db250cmFjdCdzIExNTlIgYmFsYW5jZSBhdmFpbGFibGUgZm9yIHJld2FyZHMuAAAAAAAOcmV3YXJkX2JhbGFuY2UAAAAAAAAAAAABAAAACw==",
        "AAAAAAAAACtRdWVyeSBjdXJyZW50IGVwb2NoIE1lcmtsZSByb290IGZvciBhIHBvb2wuAAAAAA9nZXRfbWVya2xlX3Jvb3QAAAAAAQAAAAAAAAAKcG9vbF9pbmRleAAAAAAABAAAAAEAAAfQAAAADk1lcmtsZVJvb3REYXRhAAA=",
        "AAAAAAAAAB9RdWVyeSBzdGFrZSBkZXRhaWxzIGZvciBhIHVzZXIuAAAAAA9nZXRfc3Rha2VyX2luZm8AAAAAAgAAAAAAAAAEdXNlcgAAABMAAAAAAAAACnBvb2xfaW5kZXgAAAAAAAQAAAABAAAH0AAAAApTdGFrZXJJbmZvAAA=",
        "AAAAAAAAAHZQb3N0IGEgbmV3IE1lcmtsZSByb290IGZvciBhIHBvb2wncyBMUCBzbmFwc2hvdHMuClJlc2V0cyB0b3RhbF9zdGFrZWQg4oCUIGFsbCB1c2VycyBtdXN0IHJlLXByb3ZlIHRvIGNvbnRpbnVlIGVhcm5pbmcuAAAAAAAPc2V0X21lcmtsZV9yb290AAAAAAQAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAKcG9vbF9pbmRleAAAAAAABAAAAAAAAAAEcm9vdAAAA+4AAAAgAAAAAAAAAA9zbmFwc2hvdF9sZWRnZXIAAAAABAAAAAEAAAPpAAAD7QAAAAAAAAfQAAAADUNvbnRyYWN0RXJyb3IAAAA=",
        "AAAAAAAAAHVVcGRhdGUgdGhlIGdsb2JhbCByZXdhcmQgcmF0ZSAoTE1OUiBzdHJvb3BzIHBlciBzZWNvbmQpLgpVcGRhdGVzIGFsbCBhY3RpdmUgcG9vbHMnIGFjY3VtdWxhdG9ycyBiZWZvcmUgY2hhbmdpbmcgcmF0ZS4AAAAAAAAPc2V0X3Jld2FyZF9yYXRlAAAAAAIAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAIbmV3X3JhdGUAAAALAAAAAQAAA+kAAAPtAAAAAAAAB9AAAAANQ29udHJhY3RFcnJvcgAAAA==",
        "AAAABAAAAAAAAAAAAAAADUNvbnRyYWN0RXJyb3IAAAAAAAANAAAAAAAAABJBbHJlYWR5SW5pdGlhbGl6ZWQAAAAAAAEAAAAAAAAADk5vdEluaXRpYWxpemVkAAAAAAACAAAAAAAAAAxVbmF1dGhvcml6ZWQAAAADAAAAAAAAABFQb29sQWxyZWFkeUV4aXN0cwAAAAAAAAQAAAAAAAAADFBvb2xOb3RGb3VuZAAAAAUAAAAAAAAADEludmFsaWRQcm9vZgAAAAYAAAAAAAAAFkFscmVhZHlTdGFrZWRUaGlzRXBvY2gAAAAAAAcAAAAAAAAADE5vU3Rha2VGb3VuZAAAAAgAAAAAAAAAEE5vUmV3YXJkc1RvQ2xhaW0AAAAJAAAAAAAAABlJbnN1ZmZpY2llbnRSZXdhcmRCYWxhbmNlAAAAAAAACgAAAAAAAAANSW52YWxpZEFtb3VudAAAAAAAAAsAAAAAAAAADE5vTWVya2xlUm9vdAAAAAwAAAAAAAAAClN0YWxlRXBvY2gAAAAAAA0=",
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAACQAAAAAAAAAAAAAABUFkbWluAAAAAAAAAAAAAAAAAAAJTG1uclRva2VuAAAAAAAAAAAAAAAAAAAQUmV3YXJkUmF0ZVBlclNlYwAAAAAAAAAAAAAACVBvb2xDb3VudAAAAAAAAAEAAAAAAAAABlBvb2xJZAAAAAAAAQAAAAQAAAABAAAAAAAAAAtQb29sSWRJbmRleAAAAAABAAAD7gAAACAAAAABAAAAAAAAAAlQb29sU3RhdGUAAAAAAAABAAAABAAAAAEAAAAAAAAACk1lcmtsZVJvb3QAAAAAAAEAAAAEAAAAAQAAAAAAAAAGU3Rha2VyAAAAAAACAAAAEwAAAAQ=",
        "AAAAAQAAAAAAAAAAAAAACVBvb2xTdGF0ZQAAAAAAAAQAAAAAAAAAFGFjY19yZXdhcmRfcGVyX3NoYXJlAAAACwAAAAAAAAAQbGFzdF9yZXdhcmRfdGltZQAAAAYAAAAAAAAAGXByZXZfYWNjX3Jld2FyZF9wZXJfc2hhcmUAAAAAAAALAAAAAAAAAAx0b3RhbF9zdGFrZWQAAAAL",
        "AAAAAQAAAAAAAAAAAAAAClN0YWtlckluZm8AAAAAAAQAAAAAAAAACGVwb2NoX2lkAAAABgAAAAAAAAAPcGVuZGluZ19yZXdhcmRzAAAAAAsAAAAAAAAAC3Jld2FyZF9kZWJ0AAAAAAsAAAAAAAAADXN0YWtlZF9hbW91bnQAAAAAAAAL",
        "AAAAAQAAAAAAAAAAAAAADk1lcmtsZVJvb3REYXRhAAAAAAAEAAAAAAAAAAhlcG9jaF9pZAAAAAYAAAAAAAAACXBvc3RlZF9hdAAAAAAAAAYAAAAAAAAABHJvb3QAAAPuAAAAIAAAAAAAAAAPc25hcHNob3RfbGVkZ2VyAAAAAAQ=" ]),
      options
    )
  }
  public readonly fromJSON = {
    fund: this.txFromJSON<Result<void>>,
        claim: this.txFromJSON<Result<i128>>,
        stake: this.txFromJSON<Result<void>>,
        unstake: this.txFromJSON<Result<void>>,
        add_pool: this.txFromJSON<Result<u32>>,
        initialize: this.txFromJSON<Result<void>>,
        get_pool_id: this.txFromJSON<Buffer>,
        remove_pool: this.txFromJSON<Result<void>>,
        get_pool_count: this.txFromJSON<u32>,
        get_pool_state: this.txFromJSON<PoolState>,
        pending_reward: this.txFromJSON<i128>,
        reward_balance: this.txFromJSON<i128>,
        get_merkle_root: this.txFromJSON<MerkleRootData>,
        get_staker_info: this.txFromJSON<StakerInfo>,
        set_merkle_root: this.txFromJSON<Result<void>>,
        set_reward_rate: this.txFromJSON<Result<void>>
  }
}