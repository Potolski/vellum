# Confidential transfers on localnet — the two version pins

Getting a Token-2022 confidential transfer to land locally took two non-obvious
pins. Both failures look like generic `InvalidInstructionData`, neither is
documented anywhere we could find, and each costs hours. Written 2026-10-06
against `solana-cli 4.0.2 (Agave)`.

## Pin 1 — `spl-token-cli` 5.6.1, not the bundled 5.5.0

The CLI bundled with the Solana install (`~/.local/share/solana/.../spl-token`,
v5.5.0) generates ElGamal proofs the on-chain verifier rejects:

```
Program ZkE1Gama1Proof11111111111111111111111111111 invoke [1]
VerifyPubkeyValidity
proof verification failed: SigmaProof(PubkeyValidity, AlgebraicRelation)
Program ZkE1Gama1Proof11111111111111111111111111111 failed: invalid instruction data
```

`PubkeyValidity` is the simplest proof in the system — prove you know the secret
key behind an ElGamal pubkey. A blanket failure there is a transcript/domain-
separator mismatch, which is exactly what the soundness patch changed when the
ZK ElGamal Proof Program was re-enabled (disabled epoch 805 / 19 Jun 2025 →
re-enabled epoch 982 / 4 Jun 2026).

```bash
cargo install spl-token-cli --locked   # 5.6.1
~/.cargo/bin/spl-token --version
```

## Pin 2 — clone Token-2022 from mainnet

With the CLI fixed, `ConfigureAccount` succeeds but `Deposit` still fails:

```
Program log: ConfidentialTransferInstruction::Deposit
Program log: Error: InvalidInstructionData
```

The Token-2022 program preloaded into `solana-test-validator` is older than
CLI 5.6.1 expects. Clone the live program instead:

```bash
solana-test-validator --reset --quiet --ledger /tmp/gl-ledger \
  --url https://api.mainnet-beta.solana.com \
  --clone-upgradeable-program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
```

Verify you got the real thing — data length should be ~1.38 MB:

```bash
solana --config <cfg> program show TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
# Data Length: 1382016 (0x151680) bytes
```

The ZK ElGamal Proof Program is a *builtin*, so it needs no cloning — it is
already active on a fresh local validator.

## Gotchas that cost time but aren't version problems

- **No default signer.** If `~/.config/solana/cli/config.yml` points at a
  keypair that doesn't exist, every command dies with "default signer is
  required". Use a throwaway config: `solana config set --config ./cli.yml
  --url http://127.0.0.1:8899 --keypair ./issuer.json`.
- **`create-account --owner <pubkey>` needs an explicit `--fee-payer`** — the
  owner isn't a signer, so the CLI can't infer one.
- **`--default-account-state`**, not `--default-state`.
- **`--reset` wipes airdropped balances.** Re-fund every test keypair after a
  validator restart, or steps fail silently with empty output.
- **The CLI cannot display a *decrypted* confidential balance.** `account-info`
  shows the ciphertext only; turning it into a number requires the owner's keys
  client-side. `tools/reveal` does it: the CLI derives both keys with
  `solana_zk_sdk::encryption::derivation::derive_confidential_keys(signer, b"")`
  — an *empty* public seed, so one key pair per wallet, not per token account.
  The available balance comes from `decryptableAvailableBalance` (AES, instant);
  pending credits need ElGamal `decrypt_u32` on the lo/hi halves, recombined as
  `lo + (hi << 16)`.
- **The auditor key decrypts transfers, not balances.** Balance ciphertexts are
  under the holder's key only. What the auditor gets is each `Transfer`
  instruction's amount, re-encrypted to the auditor key in the instruction data
  (after the 2-byte tag and the 36-byte new source balance: 64 bytes lo, 64
  bytes hi). `vellum-reveal audit` sums those with the public deposits and
  withdrawals. `create-token` has no auditor flag: set it afterwards with
  `update-confidential-transfer-settings --auditor-pubkey <base64>`, while the
  issuer still holds the confidential-transfer-mint authority.
- **No JS client can generate the proofs.** `@solana/spl-token` 0.4 has the
  extension layouts but no confidential instruction builders, and
  `@solana-program/zk-elgamal-proof` ships codecs only. Proof generation is
  Rust-only, so drive the confidential leg with the CLI (or Rust) and keep JS
  for everything else.
- **`ConfigureAccount` works on an unapproved account; `Deposit` does not.**
  With `--enable-confidential-transfers manual`, a deposit before approval
  fails with custom error `0x18` (`ConfidentialTransferAccountNotApproved`).

## Verified working flow

`scripts/confidential-baseline.sh` — proves the pipeline end to end. Final state
is the point of the whole project:

```
Balance: 0                                  <- what every explorer sees
Available Balance: 3hi4LKK1W9AIbxgAPZaW...  <- where the 750 shares actually are
Approved: true
```

Note it uses `--enable-confidential-transfers auto` to isolate the crypto. The
product uses `manual`, where approval is gated by
`vellum::approve_confidential_account` — `scripts/confidential-e2e.sh` runs
that configuration, with the freeze and confidential-transfer authorities both
held by the policy PDA.
