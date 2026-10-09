// Read-only access to what Vellum and Token-2022 publish about a holder.
// Plain JSON-RPC and hand-decoded layouts, so the page ships no Solana SDK.

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58, base64 } from "@scure/base";

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "https://api.devnet.solana.com";
export const CLUSTER = "devnet";

export const VELLUM_PROGRAM = "7jhdAgapZXFyLW2ARyYsq2Ji5n3bG3EZSieSjMt37mdj";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

const utf8 = (text: string) => new TextEncoder().encode(text);
const address = (bytes: Uint8Array) => base58.encode(bytes);

export function isAddress(text: string): boolean {
  try {
    return base58.decode(text).length === 32;
  } catch {
    return false;
  }
}

function isOnCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(bytes);
    return true;
  } catch {
    return false;
  }
}

/** A program-derived address: the first bump, counting down from 255, whose
 *  hash is not a valid ed25519 point. */
function programAddress(seeds: Uint8Array[], program: string): string {
  const suffix = [base58.decode(program), utf8("ProgramDerivedAddress")];
  for (let bump = 255; bump >= 0; bump--) {
    const parts = [...seeds, Uint8Array.of(bump), ...suffix];
    const input = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      input.set(part, offset);
      offset += part.length;
    }
    const hash = sha256(input);
    if (!isOnCurve(hash)) return address(hash);
  }
  throw new Error("no program address for these seeds");
}

async function accounts(addresses: string[]): Promise<(Uint8Array | null)[]> {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getMultipleAccounts",
      params: [addresses, { encoding: "base64", commitment: "confirmed" }],
    }),
  });
  if (!response.ok) throw new Error(`The Solana RPC answered ${response.status}.`);
  const body = await response.json();
  if (body.error) throw new Error(body.error.message);
  return body.result.value.map((account: { data: [string, string] } | null) =>
    account ? base64.decode(account.data[0]) : null
  );
}

const view = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

export const CLAIMS = { KYC: 1 << 0, ACCREDITED: 1 << 1, VENUE: 1 << 2 };

export type Attestation = {
  claims: number;
  /** ISO 3166-1 numeric, 0 if unset. */
  jurisdiction: number;
  /** Unix seconds, 0 if it never expires. */
  expiresAt: number;
};

export type ConfidentialState = {
  approved: boolean;
  pendingLo: Uint8Array;
  pendingHi: Uint8Array;
  /** The available balance under the holder's ElGamal key: what an explorer shows. */
  available: Uint8Array;
  /** The same balance under the holder's AES key. */
  decryptableAvailable: Uint8Array;
};

export type Holder = {
  owner: string;
  mint: string;
  decimals: number;
  policy: { address: string; registry: string; paused: boolean };
  attestation: { address: string; record: Attestation | null };
  account: {
    address: string;
    /** Null if the holder has no token account for this mint. */
    state: { frozen: boolean; publicBalance: bigint; confidential: ConfidentialState | null } | null;
  };
};

// Anchor accounts start with an 8-byte discriminator.
function decodePolicy(data: Uint8Array) {
  return {
    registry: address(data.subarray(72, 104)),
    paused: data[124] === 1, // after flags (4) and eight blocked jurisdictions (16)
  };
}

function decodeAttestation(data: Uint8Array): Attestation {
  const fields = view(data);
  return {
    claims: fields.getUint32(72, true), // after registry and subject
    jurisdiction: fields.getUint16(76, true),
    expiresAt: Number(fields.getBigInt64(78, true)),
  };
}

const TOKEN_ACCOUNT_LEN = 165;
const ACCOUNT_STATE_FROZEN = 2;
const CONFIDENTIAL_TRANSFER_ACCOUNT = 5;

function decodeTokenAccount(data: Uint8Array) {
  let confidential: ConfidentialState | null = null;
  // Extensions follow the base account and a 1-byte account type, as
  // type (u16), length (u16), value.
  for (let at = TOKEN_ACCOUNT_LEN + 1; at + 4 <= data.length; ) {
    const type = view(data).getUint16(at, true);
    const length = view(data).getUint16(at + 2, true);
    const value = data.subarray(at + 4, at + 4 + length);
    if (type === CONFIDENTIAL_TRANSFER_ACCOUNT) {
      confidential = {
        approved: value[0] === 1,
        // then the ElGamal public key (32)
        pendingLo: value.subarray(33, 97),
        pendingHi: value.subarray(97, 161),
        available: value.subarray(161, 225),
        decryptableAvailable: value.subarray(225, 261),
      };
    }
    if (type === 0 && length === 0) break;
    at += 4 + length;
  }
  return {
    frozen: data[108] === ACCOUNT_STATE_FROZEN,
    publicBalance: view(data).getBigUint64(64, true),
    confidential,
  };
}

/** Everything the chain says about one wallet's position in one mint. */
export async function loadHolder(owner: string, mint: string): Promise<Holder> {
  const ownerKey = base58.decode(owner);
  const mintKey = base58.decode(mint);
  const policy = programAddress([utf8("policy"), mintKey], VELLUM_PROGRAM);
  const account = programAddress(
    [ownerKey, base58.decode(TOKEN_2022_PROGRAM), mintKey],
    ASSOCIATED_TOKEN_PROGRAM
  );

  const [mintData, policyData, accountData] = await accounts([mint, policy, account]);
  if (!mintData) throw new Error("That mint does not exist on devnet.");
  if (!policyData) throw new Error("That mint has no Vellum policy.");
  const { registry, paused } = decodePolicy(policyData);

  const attestation = programAddress(
    [utf8("attest"), base58.decode(registry), ownerKey],
    VELLUM_PROGRAM
  );
  const [attestationData] = await accounts([attestation]);

  return {
    owner,
    mint,
    decimals: mintData[44],
    policy: { address: policy, registry, paused },
    attestation: {
      address: attestation,
      record: attestationData ? decodeAttestation(attestationData) : null,
    },
    account: {
      address: account,
      state: accountData ? decodeTokenAccount(accountData) : null,
    },
  };
}

export const explorer = (target: string) =>
  `https://explorer.solana.com/address/${target}?cluster=${CLUSTER}`;
