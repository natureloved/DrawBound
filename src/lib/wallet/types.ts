export type WalletType = "taurus" | "xverse" | "unisat" | "manual";

export interface ConnectedWallet {
  type: WalletType;
  vaultRef: string;
  address?: string;
  publicKey?: string;
  collateralSats: number;
  connectedAt: string;
}

export interface TransitionRequest {
  action: "DRAW" | "REPAY" | "UNLOCK";
  positionId: string;
  vaultRef: string;
  amount: number;
  nonce: number;
  proofDigest?: string;
}

export interface SignedTransition {
  txHex: string;
  txid?: string;
  witness?: string[];
}
