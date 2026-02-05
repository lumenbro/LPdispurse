"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { NETWORK_PASSPHRASE } from "@/lib/constants";

interface WalletState {
  publicKey: string | null;
  connected: boolean;
  connecting: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  signTransaction: (
    xdr: string,
    opts?: { networkPassphrase?: string; address?: string }
  ) => Promise<{ signedTxXdr: string; signerAddress?: string }>;
}

const WalletContext = createContext<WalletState>({
  publicKey: null,
  connected: false,
  connecting: false,
  connect: async () => {},
  disconnect: () => {},
  signTransaction: async () => ({ signedTxXdr: "" }),
});

export function useWallet() {
  return useContext(WalletContext);
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [kitReady, setKitReady] = useState(false);

  // Lazy-import and init the kit client-side only (uses DOM/localStorage)
  useEffect(() => {
    let unsub: (() => void) | undefined;

    (async () => {
      const { StellarWalletsKit } = await import(
        "@creit-tech/stellar-wallets-kit/sdk"
      );
      const { SwkAppDarkTheme, KitEventType } = await import(
        "@creit-tech/stellar-wallets-kit/types"
      );
      const { defaultModules } = await import(
        "@creit-tech/stellar-wallets-kit/modules/utils"
      );

      const { Networks } = await import(
        "@creit-tech/stellar-wallets-kit/types"
      );

      StellarWalletsKit.init({
        theme: SwkAppDarkTheme,
        modules: defaultModules(),
        network: NETWORK_PASSPHRASE.includes("Public")
          ? Networks.PUBLIC
          : Networks.TESTNET,
      });

      // Listen for wallet state changes (connection/disconnection)
      unsub = StellarWalletsKit.on(
        KitEventType.STATE_UPDATED,
        (event: any) => {
          setPublicKey(event.payload.address || null);
        }
      );

      setKitReady(true);
    })();

    return () => {
      unsub?.();
    };
  }, []);

  const connect = useCallback(async () => {
    if (!kitReady) return;
    setConnecting(true);
    try {
      const { StellarWalletsKit } = await import(
        "@creit-tech/stellar-wallets-kit/sdk"
      );
      const { address } = await StellarWalletsKit.authModal();
      setPublicKey(address);
    } catch (err: any) {
      // code -1 = user closed modal, anything else is a real error
      console.error("Wallet connection error:", err?.code, err?.message ?? err);
    } finally {
      setConnecting(false);
    }
  }, [kitReady]);

  const disconnect = useCallback(async () => {
    try {
      const { StellarWalletsKit } = await import(
        "@creit-tech/stellar-wallets-kit/sdk"
      );
      await StellarWalletsKit.disconnect();
    } catch {
      // ignore
    }
    setPublicKey(null);
  }, []);

  const signTransaction = useCallback(
    async (
      xdr: string,
      opts?: { networkPassphrase?: string; address?: string }
    ) => {
      const signOpts = {
        networkPassphrase: opts?.networkPassphrase || NETWORK_PASSPHRASE,
        address: opts?.address || publicKey || undefined,
      };
      console.log("[WalletProvider] signTransaction called", {
        xdrLength: xdr.length,
        xdrPreview: xdr.slice(0, 80) + "...",
        opts: signOpts,
      });
      try {
        const { StellarWalletsKit } = await import(
          "@creit-tech/stellar-wallets-kit/sdk"
        );
        console.log("[WalletProvider] Calling StellarWalletsKit.signTransaction...");
        const result = await StellarWalletsKit.signTransaction(xdr, signOpts);
        console.log("[WalletProvider] signTransaction succeeded", {
          signedXdrLength: result.signedTxXdr?.length,
          signerAddress: result.signerAddress,
        });
        return result;
      } catch (err: any) {
        console.error("[WalletProvider] signTransaction FAILED", {
          code: err?.code,
          message: err?.message,
          error: err,
        });
        throw err;
      }
    },
    [publicKey]
  );

  return (
    <WalletContext.Provider
      value={{
        publicKey,
        connected: !!publicKey,
        connecting,
        connect,
        disconnect,
        signTransaction,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}
