import {
  Keypair,
  TransactionBuilder,
  Operation,
  nativeToScVal,
  Address,
  xdr,
  authorizeEntry,
} from "@stellar/stellar-sdk";
import { Server as RpcServer, Api } from "@stellar/stellar-sdk/rpc";
import { assembleTransaction } from "@stellar/stellar-sdk/rpc";
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
 * Build, simulate, sign, and submit a Soroban contract invocation from scratch.
 * Completely bypasses ContractClient's sign()/signAndSend() flow to avoid
 * cloneFrom() XDR round-trip issues that cause txBadAuth.
 */
async function rawInvokeContract(
  keypair: Keypair,
  functionName: string,
  args: xdr.ScVal[]
): Promise<Api.GetSuccessfulTransactionResponse> {
  const server = new RpcServer(RPC_URL);

  // Verify network passphrase (using Stellar SDK's hashing for consistency)
  const Networks = { PUBLIC: "Public Global Stellar Network ; September 2015", TESTNET: "Test SDF Network ; September 2015" };
  const isMainnet = NETWORK_PASSPHRASE === Networks.PUBLIC;
  const isTestnet = NETWORK_PASSPHRASE === Networks.TESTNET;
  console.log(`[rawInvoke] ${functionName}: NETWORK_PASSPHRASE=${NETWORK_PASSPHRASE}`);
  console.log(`[rawInvoke] ${functionName}: isMainnet=${isMainnet}, isTestnet=${isTestnet}`);

  // 1. Load fresh account (sequence number)
  const account = await server.getAccount(keypair.publicKey());
  console.log(`[rawInvoke] ${functionName}: source=${keypair.publicKey()}, seq=${account.sequenceNumber()}`);

  // 2. Build unsigned transaction
  console.log(`[rawInvoke] ${functionName}: CONTRACT_ID=${CONTRACT_ID}`);
  console.log(`[rawInvoke] ${functionName}: admin arg (first)=${args[0]?.value?.()?.toString?.() || 'unknown'}`);
  const tx = new TransactionBuilder(account, {
    fee: "10000000", // 1 XLM max fee (generous for Soroban)
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: CONTRACT_ID,
        function: functionName,
        args,
      })
    )
    .setTimeout(60)
    .build();

  // 3. Simulate
  console.log(`[rawInvoke] ${functionName}: simulating...`);
  const simResponse = await server.simulateTransaction(tx);

  if (Api.isSimulationError(simResponse)) {
    console.error(`[rawInvoke] ${functionName}: simulation error:`, (simResponse as any).error);
    throw new Error(`Simulation failed: ${(simResponse as any).error}`);
  }

  const simSuccess = simResponse as Api.SimulateTransactionSuccessResponse;

  // 4. Sign auth entries from simulation BEFORE assembling
  //    (auth entries in the simulation response are templates with void signatures)
  if (simSuccess.result?.auth?.length) {
    console.log(`[rawInvoke] ${functionName}: ${simSuccess.result.auth.length} auth entries from simulation`);
    const latestLedger = (await server.getLatestLedger()).sequence;

    for (let i = 0; i < simSuccess.result.auth.length; i++) {
      const entryXdr = simSuccess.result.auth[i];
      // Parse the auth entry XDR string
      const entry = typeof entryXdr === "string"
        ? xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, "base64")
        : entryXdr;

      const credType = entry.credentials().switch().name;
      console.log(`[rawInvoke] ${functionName}: auth[${i}] credType=${credType}`);

      // Log the full auth entry structure for debugging
      const invocation = entry.rootInvocation();
      const contractAddr = Address.fromScAddress(invocation.function().contractFn().contractAddress()).toString();
      const funcName = invocation.function().contractFn().functionName().toString();
      console.log(`[rawInvoke] ${functionName}: auth[${i}] invocation: contract=${contractAddr}, func=${funcName}`);
      console.log(`[rawInvoke] ${functionName}: auth[${i}] entryXdr=${entry.toXDR("base64").slice(0, 100)}...`);

      if (credType === "sorobanCredentialsAddress") {
        const addr = entry.credentials().address();
        const addrStr = Address.fromScAddress(addr.address()).toString();
        const sigType = addr.signature().switch().name;
        console.log(`[rawInvoke] ${functionName}: auth[${i}] address=${addrStr}, sigType=${sigType}, expiry=${addr.signatureExpirationLedger()}`);

        // Sign with authorizeEntry
        console.log(`[rawInvoke] ${functionName}: signing auth entry ${i}...`);
        const signed = authorizeEntry(
          entry,
          keypair,
          latestLedger + 200,
          NETWORK_PASSPHRASE
        );
        const signedEntry = signed instanceof Promise ? await signed : signed;

        // Replace in the simulation result so assembleTransaction picks it up
        simSuccess.result.auth[i] = signedEntry as any;
        console.log(`[rawInvoke] ${functionName}: auth entry ${i} signed`);
      } else {
        // For sourceAccountCredentials, ensure the parsed entry is used (not XDR string)
        // This ensures consistent handling by assembleTransaction
        simSuccess.result.auth[i] = entry as any;
        console.log(`[rawInvoke] ${functionName}: auth entry ${i} kept as sourceAccount (parsed)`);
      }
    }
  }

  // 5. Assemble (adds sorobanData, resource fees, and auth from simulation)
  console.log(`[rawInvoke] ${functionName}: assembling...`);
  const assembled = assembleTransaction(tx, simResponse).build();

  // Debug: verify the assembled transaction properties
  console.log(`[rawInvoke] ${functionName}: assembled source=${assembled.source}`);
  console.log(`[rawInvoke] ${functionName}: assembled networkPassphrase=${assembled.networkPassphrase}`);
  console.log(`[rawInvoke] ${functionName}: assembled sequence=${assembled.sequence}`);
  console.log(`[rawInvoke] ${functionName}: assembled fee=${assembled.fee}`);
  console.log(`[rawInvoke] ${functionName}: assembled sigs before sign=${assembled.signatures.length}`);

  // Debug: check the auth on the assembled operation
  const ops = assembled.operations;
  if (ops.length > 0 && ops[0].type === "invokeHostFunction") {
    const invokeOp = ops[0] as any;
    console.log(`[rawInvoke] ${functionName}: assembled op auth count=${invokeOp.auth?.length ?? 0}`);
    if (invokeOp.auth?.length) {
      for (let i = 0; i < invokeOp.auth.length; i++) {
        const auth = invokeOp.auth[i];
        const cred = auth.credentials();
        console.log(`[rawInvoke] ${functionName}: assembled auth[${i}] credType=${cred.switch().name}`);
      }
    }
  }

  // Debug: log the hash that will be signed
  const txHash = assembled.hash();
  console.log(`[rawInvoke] ${functionName}: txHash=${txHash.toString("hex")}`);

  // Debug: verify keypair matches the source
  console.log(`[rawInvoke] ${functionName}: keypair pubkey=${keypair.publicKey()}`);
  console.log(`[rawInvoke] ${functionName}: source matches keypair=${assembled.source === keypair.publicKey()}`);

  // 6. Sign the transaction envelope
  console.log(`[rawInvoke] ${functionName}: signing envelope...`);

  // Verify hash before signing
  const hashBeforeSign = assembled.hash();
  console.log(`[rawInvoke] ${functionName}: hashBeforeSign=${hashBeforeSign.toString("hex")}`);

  assembled.sign(keypair);
  console.log(`[rawInvoke] ${functionName}: sigs after sign=${assembled.signatures.length}`);
  console.log(`[rawInvoke] ${functionName}: sig hint=${assembled.signatures[0]?.hint().toString("hex")}`);

  // Verify hash after signing (should be same)
  const hashAfterSign = assembled.hash();
  console.log(`[rawInvoke] ${functionName}: hashAfterSign=${hashAfterSign.toString("hex")}`);
  console.log(`[rawInvoke] ${functionName}: hash match=${hashBeforeSign.equals(hashAfterSign)}`);

  // Verify signature hint matches keypair
  const expectedHint = keypair.rawPublicKey().slice(-4).toString("hex");
  const actualHint = assembled.signatures[0]?.hint().toString("hex");
  console.log(`[rawInvoke] ${functionName}: expectedHint=${expectedHint}, actualHint=${actualHint}, match=${expectedHint === actualHint}`);

  // Debug: log the full signed XDR (truncated for readability)
  const signedXdr = assembled.toXDR();
  console.log(`[rawInvoke] ${functionName}: signedXdr length=${signedXdr.length}`);
  console.log(`[rawInvoke] ${functionName}: signedXdr (first 200)=${signedXdr.slice(0, 200)}`);

  // Verify XDR can be round-tripped
  try {
    const reparsed = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
    const reparsedHash = reparsed.hash();
    console.log(`[rawInvoke] ${functionName}: reparsedHash=${reparsedHash.toString("hex")}`);
    console.log(`[rawInvoke] ${functionName}: XDR roundtrip hash match=${hashAfterSign.equals(reparsedHash)}`);
  } catch (e) {
    console.error(`[rawInvoke] ${functionName}: XDR roundtrip failed:`, e);
  }

  // 7. Submit
  console.log(`[rawInvoke] ${functionName}: submitting...`);
  const sendResponse = await server.sendTransaction(assembled);
  console.log(`[rawInvoke] ${functionName}: status=${sendResponse.status}`);

  if (sendResponse.status === "ERROR") {
    const errResult = (sendResponse as any).errorResult;
    const errXdr = errResult?.toXDR?.("base64") ?? JSON.stringify(errResult);
    console.error(`[rawInvoke] ${functionName}: ERROR:`, errXdr);
    console.error(`[rawInvoke] ${functionName}: full response:`, JSON.stringify(sendResponse, null, 2));

    // Compare RPC hash with local hash
    const rpcHash = sendResponse.hash;
    const localHash = hashAfterSign.toString("hex");
    console.error(`[rawInvoke] ${functionName}: RPC hash=${rpcHash}`);
    console.error(`[rawInvoke] ${functionName}: local hash=${localHash}`);
    console.error(`[rawInvoke] ${functionName}: hash match=${rpcHash === localHash}`);

    throw new Error(`Transaction send error: ${errXdr}`);
  }

  if (sendResponse.status !== "PENDING") {
    throw new Error(`Unexpected send status: ${sendResponse.status}`);
  }

  // 8. Poll for result
  const hash = sendResponse.hash;
  console.log(`[rawInvoke] ${functionName}: tx hash=${hash}, polling...`);
  const start = Date.now();
  let getResponse = await server.getTransaction(hash);
  while (getResponse.status === "NOT_FOUND") {
    if (Date.now() - start > 60000) {
      throw new Error(`Transaction timed out after 60s. Hash: ${hash}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
    getResponse = await server.getTransaction(hash);
  }

  console.log(`[rawInvoke] ${functionName}: final status=${getResponse.status}`);
  if (getResponse.status === "SUCCESS") {
    return getResponse as Api.GetSuccessfulTransactionResponse;
  }

  throw new Error(
    `Transaction failed: ${getResponse.status}. Hash: ${hash}`
  );
}

/**
 * Admin client for the indexer cron (signs with ADMIN_SECRET_KEY).
 * Uses ContractClient for read-only queries and signAndSendTx for mutations
 * (which builds/signs/submits transactions from scratch via raw Soroban RPC).
 */
export function createAdminClient(): StakingClient & {
  publicKey: string;
  signAndSendTx: (tx: AssembledTransaction<any>) => Promise<any>;
  rawSetMerkleRoot: (
    poolIndex: number,
    root: Buffer,
    snapshotLedger: number
  ) => Promise<Api.GetSuccessfulTransactionResponse>;
} {
  const secret = process.env.ADMIN_SECRET_KEY;
  if (!secret) throw new Error("ADMIN_SECRET_KEY not set");
  const keypair = Keypair.fromSecret(secret);

  console.log("[AdminClient] Derived public key:", keypair.publicKey());
  console.log("[AdminClient] NETWORK_PASSPHRASE:", NETWORK_PASSPHRASE);

  const client = makeClient({
    publicKey: keypair.publicKey(),
    signTransaction: async (txXdr: string) => {
      const tx = TransactionBuilder.fromXDR(txXdr, NETWORK_PASSPHRASE);
      tx.sign(keypair);
      return { signedTxXdr: tx.toXDR(), signerAddress: keypair.publicKey() };
    },
  });

  /**
   * Generic signAndSendTx that bypasses ContractClient's sign() entirely.
   * Accesses the assembled (simulated) transaction directly, signs it, submits it.
   */
  const signAndSendTx = async (assembled: AssembledTransaction<any>) => {
    const server = new RpcServer(RPC_URL);
    const builtTx = (assembled as any).built;

    if (!builtTx) {
      throw new Error("Transaction not yet assembled/simulated");
    }

    // Log diagnostics
    console.log("[signAndSendTx] source:", builtTx.source);
    console.log("[signAndSendTx] operations:", builtTx.operations?.length);
    const op = builtTx.operations?.[0];
    if (op?.auth) {
      for (let i = 0; i < op.auth.length; i++) {
        console.log(`[signAndSendTx] auth[${i}] type: ${op.auth[i].credentials().switch().name}`);
      }
    }

    // Sign envelope directly (no cloneFrom rebuild)
    builtTx.sign(keypair);

    // Submit
    const sendResponse = await server.sendTransaction(builtTx);
    console.log("[signAndSendTx] status:", sendResponse.status);

    if (sendResponse.status === "ERROR") {
      const errResult = (sendResponse as any).errorResult;
      console.error("[signAndSendTx] errorResult:", errResult?.toXDR?.("base64") ?? JSON.stringify(errResult));
      throw new Error(`Send failed: ${sendResponse.status}`);
    }

    if (sendResponse.status === "PENDING") {
      const hash = sendResponse.hash;
      const start = Date.now();
      let getResponse = await server.getTransaction(hash);
      while (getResponse.status === "NOT_FOUND") {
        if (Date.now() - start > 60000) break;
        await new Promise((r) => setTimeout(r, 2000));
        getResponse = await server.getTransaction(hash);
      }
      if (getResponse.status === "SUCCESS") return getResponse;
      throw new Error(`Transaction failed: ${getResponse.status}`);
    }

    throw new Error(`Unexpected status: ${sendResponse.status}`);
  };

  /**
   * Build set_merkle_root transaction entirely from scratch.
   * This is the nuclear option — zero dependency on ContractClient for signing.
   */
  const rawSetMerkleRoot = (
    poolIndex: number,
    root: Buffer,
    snapshotLedger: number
  ) => {
    return rawInvokeContract(keypair, "set_merkle_root", [
      new Address(keypair.publicKey()).toScVal(), // admin
      nativeToScVal(poolIndex, { type: "u32" }), // pool_index
      xdr.ScVal.scvBytes(root), // root: BytesN<32>
      nativeToScVal(snapshotLedger, { type: "u32" }), // snapshot_ledger
    ]);
  };

  return Object.assign(client, {
    publicKey: keypair.publicKey(),
    signAndSendTx,
    rawSetMerkleRoot,
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
