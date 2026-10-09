// Run with `yarn test`. The fixture is a real devnet account configured by
// spl-token-cli (Rust), so these check the port against the original: the same
// wallet signature must yield keys that open the same ciphertexts.

import assert from "node:assert/strict";
import { test } from "node:test";
import { decryptAvailable, decryptPending, deriveViewingKeys } from "./confidential.ts";

const bytes = (encoded: string, encoding: "hex" | "base64") =>
  new Uint8Array(Buffer.from(encoded, encoding));

// Bob, the demo holder on devnet: 450.00 available, 100.00 pending, two
// decimals. The signature is his over the derivation message; like the viewing
// keys it yields, it reads his balance and cannot move it.
const bob = {
  signature: bytes(
    "f24efff15a2560245f5eff53bf06d794799d46a262ff1b126a24d304d53efecfd5f3c8fe8aa8bd0fc200c2fc57894421f9e3bb916a2ba599ab6ca98562546508",
    "hex"
  ),
  decryptableAvailable: bytes("sSXqOl6ynxJkt4U8LFWdU5On6xLXYJbmeeXSpE8KWJMGL0JN", "base64"),
  pendingLo: bytes(
    "RoZMRfd+y6a8lW4mbPPC8/O845zYf33pkdUM4COJZGjEy4f7glkVnbIdzX4yJiek0hbx/moh76S9wqKUdLjqbg==",
    "base64"
  ),
  pendingHi: bytes(
    "jMn976THqeodeZEM8mumE8arjCfyj3Cy2FztpBFByjeEnODzW/ELHEVnGa74JsXflmenPEejEIbXnRP/O28Tdw==",
    "base64"
  ),
};

test("keys derived from the wallet signature open the account", () => {
  const keys = deriveViewingKeys(bob.signature);

  assert.equal(decryptAvailable(keys.ae, bob.decryptableAvailable), 45_000n);
  assert.equal(decryptPending(keys.elgamal, bob.pendingLo, bob.pendingHi), 10_000n);
});

test("another wallet's keys open nothing", () => {
  const stranger = deriveViewingKeys(new Uint8Array(64).fill(7));

  assert.equal(decryptAvailable(stranger.ae, bob.decryptableAvailable), null);
  assert.equal(decryptPending(stranger.elgamal, bob.pendingLo, bob.pendingHi), null);
});

test("an all-zero signature is refused", () => {
  assert.throws(() => deriveViewingKeys(new Uint8Array(64)));
});
