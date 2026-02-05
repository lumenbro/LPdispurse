import { Keypair } from "@stellar/stellar-sdk";
import { authorizeEntry } from "@stellar/stellar-base";
import {
  AssembledTransaction,
  Client as ContractClient,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import {
  CONTRACT_ID,
  CONTRACT_SPEC,
  NETWORK_PASSPHRASE,
  RPC_URL,
} from "./constants";

// Types matching the contract's Rust types
export interface PoolState {
  acc_reward_per_share: bigint;
  last_reward_time: bigint;
  prev_acc_reward_per_share: bigint;
  total_staked: bigint;
}

export interface StakerInfo {
  epoch_id: bigint;
  pending_rewards: bigint;
  reward_debt: bigint;
  staked_amount: bigint;
}

export interface MerkleRootData {
  epoch_id: bigint;
  posted_at: bigint;
  root: Buffer;
  snapshot_ledger: number;
}

/**
 * Typed interface for the contract's dynamically-generated methods.
 * ContractClient creates these at runtime from the spec; this interface
 * gives TypeScript visibility into them.
 */
export interface StakingClient {
  // View functions
  get_pool_count(options?: any): Promise<AssembledTransaction<number>>;
  get_pool_state(
    args: { pool_index: number },
    options?: any
  ): Promise<AssembledTransaction<PoolState>>;
  get_pool_id(
    args: { pool_index: number },
    options?: any
  ): Promise<AssembledTransaction<Buffer>>;
  get_merkle_root(
    args: { pool_index: number },
    options?: any
  ): Promise<AssembledTransaction<MerkleRootData>>;
  get_staker_info(
    args: { user: string; pool_index: number },
    options?: any
  ): Promise<AssembledTransaction<StakerInfo>>;
  pending_reward(
    args: { user: string; pool_index: number },
    options?: any
  ): Promise<AssembledTransaction<bigint>>;
  reward_balance(options?: any): Promise<AssembledTransaction<bigint>>;

  // User functions
  stake(
    args: {
      user: string;
      pool_index: number;
      lp_balance: bigint;
      proof: Buffer[];
    },
    options?: any
  ): Promise<AssembledTransaction<any>>;
  claim(
    args: { user: string; pool_index: number },
    options?: any
  ): Promise<AssembledTransaction<any>>;
  unstake(
    args: { user: string; pool_index: number },
    options?: any
  ): Promise<AssembledTransaction<any>>;

  // Admin functions
  set_admin(
    args: { admin: string; new_admin: string },
    options?: any
  ): Promise<AssembledTransaction<any>>;
  add_pool(
    args: { admin: string; pool_id: Buffer },
    options?: any
  ): Promise<AssembledTransaction<number>>;
  remove_pool(
    args: { admin: string; pool_index: number },
    options?: any
  ): Promise<AssembledTransaction<any>>;
  set_merkle_root(
    args: {
      admin: string;
      pool_index: number;
      root: Buffer;
      snapshot_ledger: number;
    },
    options?: any
  ): Promise<AssembledTransaction<any>>;
  set_reward_rate(
    args: { admin: string; new_rate: bigint },
    options?: any
  ): Promise<AssembledTransaction<any>>;
  fund(
    args: { funder: string; amount: bigint },
    options?: any
  ): Promise<AssembledTransaction<any>>;
}

type SignTransactionFn = (
  xdr: string,
  opts?: any
) => Promise<{ signedTxXdr: string; signerAddress?: string }>;

function makeClient(opts: {
  publicKey?: string;
  signTransaction?: SignTransactionFn;
}): StakingClient {
  const client = new ContractClient(new ContractSpec(CONTRACT_SPEC), {
    contractId: CONTRACT_ID,
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: RPC_URL,
    ...opts,
  });
  // ContractClient generates methods dynamically from the spec at runtime
  return client as unknown as StakingClient;
}

/**
 * Read-only client (no signing needed for view functions).
 */
export function createReadClient(): StakingClient {
  return makeClient({});
}

/**
 * Admin client for the indexer cron (signs with ADMIN_SECRET_KEY).
 * Returns a client with a `signAndSendTx` helper that properly handles
 * Soroban auth entry signing before submitting.
 */
export function createAdminClient(): StakingClient & {
  publicKey: string;
  signAndSendTx: (tx: AssembledTransaction<any>) => Promise<any>;
} {
  const secret = process.env.ADMIN_SECRET_KEY;
  if (!secret) throw new Error("ADMIN_SECRET_KEY not set");
  const keypair = Keypair.fromSecret(secret);

  console.log("[AdminClient] Derived public key:", keypair.publicKey());
  console.log("[AdminClient] NETWORK_PASSPHRASE:", NETWORK_PASSPHRASE);

  const client = makeClient({
    publicKey: keypair.publicKey(),
    signTransaction: async (xdr: string) => {
      const { TransactionBuilder } = await import("@stellar/stellar-sdk");
      const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE);
      tx.sign(keypair);
      return { signedTxXdr: tx.toXDR(), signerAddress: keypair.publicKey() };
    },
  });

  /**
   * Sign Soroban auth entries with the admin keypair, then sign envelope and send.
   * Soroban require_auth() creates Address-credential auth entries that need
   * explicit signing — signAndSend() alone only signs the envelope.
   */
  const signAndSendTx = async (tx: AssembledTransaction<any>) => {
    // Sign any Soroban auth entries that need the admin's signature
    try {
      await tx.signAuthEntries({
        address: keypair.publicKey(),
        authorizeEntry: async (entry, signer, validUntilLedgerSeq, networkPassphrase) => {
          console.log("[AdminClient] Signing auth entry for", keypair.publicKey());
          return authorizeEntry(
            entry,
            keypair,
            validUntilLedgerSeq,
            networkPassphrase ?? NETWORK_PASSPHRASE
          );
        },
      });
    } catch (e: any) {
      // NoUnsignedNonInvokerAuthEntriesError — no auth entries to sign
      console.log("[AdminClient] signAuthEntries skipped:", e?.message ?? e);
    }
    // Sign the transaction envelope and submit
    return tx.signAndSend();
  };

  return Object.assign(client, {
    publicKey: keypair.publicKey(),
    signAndSendTx,
  });
}

/**
 * User client for wallet interactions (signs via Stellar Wallets Kit).
 */
export function createUserClient(
  publicKey: string,
  signTransaction: SignTransactionFn
): StakingClient {
  return makeClient({ publicKey, signTransaction });
}
