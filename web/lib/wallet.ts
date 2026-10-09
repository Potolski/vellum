// The injected wallets that expose `connect` and `signMessage` directly.
// Enough to ask one wallet for one signature without shipping an adapter.

type InjectedWallet = {
  connect: () => Promise<unknown>;
  publicKey?: { toString(): string } | null;
  signMessage: (
    message: Uint8Array,
    display?: string
  ) => Promise<Uint8Array | { signature: Uint8Array }>;
};

function injected(): InjectedWallet | null {
  const scope = window as unknown as {
    phantom?: { solana?: InjectedWallet };
    solflare?: InjectedWallet;
    backpack?: InjectedWallet;
    solana?: InjectedWallet;
  };
  return scope.phantom?.solana ?? scope.solflare ?? scope.backpack ?? scope.solana ?? null;
}

export const hasWallet = () => injected() !== null;

/** Connects and returns the wallet's address. */
export async function connectWallet(): Promise<string> {
  const wallet = injected();
  if (!wallet) throw new Error("No Solana wallet found in this browser.");
  await wallet.connect();
  const address = wallet.publicKey?.toString();
  if (!address) throw new Error("The wallet did not share an address.");
  return address;
}

/** Asks the connected wallet to sign `message`, and returns the signature. */
export async function signMessage(message: Uint8Array): Promise<Uint8Array> {
  const wallet = injected();
  if (!wallet) throw new Error("No Solana wallet found in this browser.");
  const signed = await wallet.signMessage(message, "utf8");
  return signed instanceof Uint8Array ? signed : signed.signature;
}
