// Client-side decryption of a Token-2022 confidential balance. A port of the
// two things tools/reveal does in Rust, so a holder can read their own
// position in the browser. Nothing here talks to the network.

import { gcmsiv } from "@noble/ciphers/aes.js";
import { ristretto255 } from "@noble/curves/ed25519.js";
import { expand, extract } from "@noble/hashes/hkdf.js";
import { sha512 } from "@noble/hashes/sha2.js";

const utf8 = (text: string) => new TextEncoder().encode(text);

/** The message a wallet signs to derive its confidential keys. The same bytes
 *  spl-token-cli signs (`derive_confidential_keys` with an empty public seed),
 *  so one wallet has one key pair across clients. */
export const DERIVATION_MESSAGE = utf8("solana-conf-bal/v1");

const AE_KEY_LEN = 16;
const AE_NONCE_LEN = 12;
const AE_CIPHERTEXT_LEN = 36;
const ELGAMAL_CIPHERTEXT_LEN = 64;

/** Encrypted amounts are split so each half is small enough to search for:
 *  a 16-bit low part and the remaining high part. */
const AMOUNT_LO_BITS = 16n;
const SEARCH_LIMIT = 1 << 16;

const Point = ristretto255.Point;
const GROUP_ORDER = Point.Fn.ORDER;

/** Keys that read a balance. They cannot move it: a transfer still needs the
 *  wallet's own signature. */
export type ViewingKeys = {
  /** AES-128-GCM-SIV key for the available balance. */
  ae: Uint8Array;
  /** ElGamal secret scalar, for pending credits. */
  elgamal: bigint;
};

function littleEndian(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i]);
  return value;
}

/** Derives the viewing keys from the wallet's signature over
 *  `DERIVATION_MESSAGE`. */
export function deriveViewingKeys(signature: Uint8Array): ViewingKeys {
  if (signature.length !== 64 || signature.every((byte) => byte === 0)) {
    throw new Error("not a usable signature");
  }
  const prk = extract(sha512, signature, DERIVATION_MESSAGE);
  return {
    ae: expand(sha512, prk, utf8("ae"), AE_KEY_LEN),
    elgamal: littleEndian(expand(sha512, prk, utf8("elgamal"), 64)) % GROUP_ORDER,
  };
}

/** The available balance, which the account mirrors under the holder's AES
 *  key so it can be read without solving a discrete log. Null if the key does
 *  not belong to this account. */
export function decryptAvailable(ae: Uint8Array, ciphertext: Uint8Array): bigint | null {
  if (ciphertext.length !== AE_CIPHERTEXT_LEN) return null;
  try {
    const plaintext = gcmsiv(ae, ciphertext.subarray(0, AE_NONCE_LEN)).decrypt(
      ciphertext.subarray(AE_NONCE_LEN)
    );
    return plaintext.length === 8 ? littleEndian(plaintext) : null;
  } catch {
    return null;
  }
}

/** One twisted-ElGamal ciphertext (commitment, then decryption handle) of a
 *  value below 2^16. Null if it does not decrypt under this key. */
function decryptPart(elgamal: bigint, ciphertext: Uint8Array): bigint | null {
  if (ciphertext.length !== ELGAMAL_CIPHERTEXT_LEN) return null;
  let target;
  try {
    const commitment = Point.fromBytes(ciphertext.subarray(0, 32));
    const handle = Point.fromBytes(ciphertext.subarray(32));
    // commitment = amount·G + r·H and handle = r·P, with P = s⁻¹·H.
    target = handle.equals(Point.ZERO)
      ? commitment
      : commitment.subtract(handle.multiply(elgamal));
  } catch {
    return null;
  }
  let candidate = Point.ZERO;
  for (let amount = 0; amount < SEARCH_LIMIT; amount++) {
    if (candidate.equals(target)) return BigInt(amount);
    candidate = candidate.add(Point.BASE);
  }
  return null;
}

/** Pending credits: transfers received but not yet applied to the available
 *  balance. Null if either half does not decrypt under this key. */
export function decryptPending(
  elgamal: bigint,
  lo: Uint8Array,
  hi: Uint8Array
): bigint | null {
  const low = decryptPart(elgamal, lo);
  const high = decryptPart(elgamal, hi);
  if (low === null || high === null) return null;
  return low + (high << AMOUNT_LO_BITS);
}
