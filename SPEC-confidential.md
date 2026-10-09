# Vellum: confidential mode

Confidential mode (Mode B) keeps a tokenized security's transfer restrictions
while encrypting what each holder owns. Holders stay named on the register;
their balances and transfer amounts are ciphertext on-chain, readable by the
holder and by the issuer's auditor key.

It uses the same registry and attestations as the transfer-hook mode described
in [SPEC.md](SPEC.md). An issuer picks one mode per mint.

## Why balances need to be private

A public ledger publishes every position. For an institution that means large
orders can be front-run, a portfolio's composition is visible to competitors,
ownership thresholds are visible before they are reported, and equity
compensation can be read by anyone. It is a widely cited barrier to putting
real securities on a public chain.

Traditional markets do not work that way. Most US shares are registered to a
single nominee, Cede & Co., and the beneficial owners are known only down the
custody chain. Confidential mode restores that property: the issuer and its
transfer agent know the register, the market does not.

## The constraint

Token-2022's `ConfidentialTransfer` extension stores balances and transfer
amounts as ElGamal ciphertexts. Addresses stay public; amounts do not. The mint
can name an **auditor key** to which every transfer amount is also encrypted.

Token-2022 does not allow `ConfidentialTransfer` and `TransferHook` on the same
mint, because a hook is handed the plaintext amount. Taken at face value, a
tokenized security can be compliant or confidential, not both.

## The design: move the check from the transfer to the account

Vellum's policy never uses the amount. It checks facts about the holder: KYC,
accreditation, jurisdiction, expiry. Those can be checked when an account opens
rather than on each transfer.

- The mint sets `DefaultAccountState = Frozen`. Every new token account starts
  unusable.
- The mint's **freeze authority** is the Vellum `Policy` PDA. Only the program
  can thaw an account, and it does so only for an eligible holder.
- The mint's confidential transfers require approval, and the **approval
  authority** is the same PDA. Only the program can let an account hold an
  encrypted balance.
- When a holder stops being eligible, anyone can ask the program to freeze the
  account again.

`DefaultAccountState` is compatible with `ConfidentialTransfer`. The pattern is
that of sRFC-37 (Token ACL), the Solana Foundation's permissioned-token
standard.

| | Mode A: hook | Mode B: confidential |
|---|---|---|
| Enforced | per **transfer**, by the transfer hook | per **account**, by the freeze gate |
| Amounts | public | **ElGamal-encrypted** |
| Oversight | public ledger | **auditor key** |
| Works with | AMMs, lending, any CPI | holding and direct transfer |
| Use | trading venue leg | cap table, institutional leg |

## Eligibility

A token account both sends and receives, and there is no per-transfer check, so
to hold the asset a wallet must satisfy the policy's sender and receiver rules
together:

- a valid, unexpired `KYC` attestation from the policy's registry, if the
  policy requires KYC of either party;
- an `ACCREDITED` claim, if the policy requires accreditation;
- a jurisdiction that is not on the policy's blocklist;
- or a `VENUE` claim, if the policy allows venues.

This is stricter than Mode A for any single transfer.

## Instructions

| Instruction | Signer | Effect |
|---|---|---|
| `init_confidential_policy(flags, blocked_jurisdictions)` | issuer | creates the policy. Fails unless the Policy PDA already holds the mint's freeze authority and approval authority, approval is manual, and an auditor key is set, so a policy that cannot enforce anything, or that the issuer cannot oversee, cannot exist |
| `thaw_if_attested` | anyone | thaws an account whose owner is eligible |
| `approve_confidential_account` | anyone | approves an eligible owner's account to hold an encrypted balance |
| `refreeze_if_invalid` | anyone | freezes an account whose owner is no longer eligible. Fails if the owner is still eligible |
| `update_policy(flags, blocked_jurisdictions, paused)` | issuer | changes the rules or pauses the mint |

The three gate instructions take no issuer signature. Their outcome depends
only on the registry's state, so it does not matter who calls them.

### Lifecycle of an account

1. **Born frozen.** The holder creates a token account. It cannot receive or
   send.
2. **Thawed if attested.** Once the holder has a valid attestation,
   `thaw_if_attested` opens the account and `approve_confidential_account` lets
   it hold an encrypted balance.
3. **Refrozen if invalid.** If the attestation expires or is revoked, the
   holder's jurisdiction is blocked, or the issuer pauses the mint,
   `refreeze_if_invalid` closes the account again.

A frozen position is never seized. The balance is untouched and usable again as
soon as the holder is re-attested and the account thawed.

## Who can read what

| | Public | Holder | Issuer (auditor key) |
|---|---|---|---|
| Who holds the security | yes | yes | yes |
| Who sent to whom | yes | yes | yes |
| Each holder's attestation and jurisdiction | yes | yes | yes |
| A holder's balance | no | own only | yes |
| A transfer's amount | no | own only | yes |

**This is balance privacy, not anonymity.** The holder set is public by design:
a transfer agent is required to know its holders, and each holder's attestation
is an on-chain account.

The holder decrypts their own balance client-side, with keys derived from a
wallet signature.

The issuer sets the auditor key on the mint before handing the approval
authority to the Policy PDA, and the program will not create a policy for a
mint without one. After that handover nobody can replace the key, the issuer
included. Balances are encrypted to their holders only, so the
auditor reads positions the way a transfer agent would: deposits and
withdrawals are public, every transfer carries its amount encrypted to the
auditor key, and the register is the sum.

## Why not split a position across wallets?

A common suggestion is to hide a position by spreading it over many derived
wallets. It does not work for a regulated security:

- **Every holding wallet needs its own attestation**, which is a public account
  issued by the same attestor. Listing a registry's attestations returns the
  full holder set, so the split is published along with the wallets.
- **The wallets are linkable anyway**, through who funded them, who pays their
  fees, when they were created, and the moment they are consolidated to sell.
- **Amounts stay public.** Each wallet's balance is still readable; only the
  total takes a little arithmetic.
- **Cost grows with the number of wallets**: rent, token accounts and
  attestations.

Encrypting the balance addresses the actual problem; scattering it does not.

## Trade-offs

1. **Coarser checks.** Eligibility is checked when an account is thawed, not on
   each transfer. `refreeze_if_invalid` closes the gap, and anyone can call it.
2. **No amount-based rules.** Per-transfer caps and volume limits cannot be
   enforced on-chain once amounts are encrypted. Rules of that kind move
   off-chain, to whoever holds the auditor key.
3. **No AMM.** Confidential balances cannot be pooled or routed. Mode A remains
   the trading leg.
4. **Platform risk.** Confidential transfers depend on Solana's ZK ElGamal proof
   program, which was disabled from June 2025 to June 2026 after a soundness bug
   and has been live on mainnet since.
5. **Client-side keys.** Reading a balance needs the holder's decryption keys,
   and proofs are generated in the client. Today that means the Rust tooling;
   there is no browser wallet flow yet.
6. **The auditor key cannot be rotated** once the Policy PDA holds the approval
   authority.
7. **Not audited**, and not on mainnet. The programs are deployed on devnet.

## Status

Implemented and tested. `anchor test` covers the gate with 19 tests, and
`scripts/confidential-e2e.sh` runs the whole flow against a real Token-2022
confidential mint, on a local validator or on devnet: 35 asserted steps, ending with the
explorer's view (balance 0), each holder's own decrypted balance, and the
register rebuilt with the auditor key. The [README](README.md) has the commands
and sample output; [docs/TOOLCHAIN.md](docs/TOOLCHAIN.md) has the version pins.

Not built yet: a holder wallet UI.

## Related work

Several Solana projects provide general-purpose privacy: Arcium with Umbra
(encrypted computation and a shielded wallet), Helius's privacy tooling, and
other private-transfer layers. They are horizontal infrastructure for payments
and swaps. Vellum is narrower: a share register with transfer restrictions,
built on the token program's own confidential balances.

## References

- Token-2022 extension compatibility: [solana.com/docs/tokens/extensions](https://solana.com/docs/tokens/extensions);
  Neodyme, "Don't shoot yourself in the foot with extensions"
- sRFC-37 Token ACL: [solana-foundation/token-acl](https://github.com/solana-foundation/token-acl)
- Confidential transfers and the auditor key:
  [solana.com/docs/tokens/extensions/confidential-transfer](https://solana.com/docs/tokens/extensions/confidential-transfer)
- ZK ElGamal proof program timeline: disabled at epoch 805 (19 June 2025),
  re-enabled at epoch 982 (4 June 2026)
- The privacy and transparency dilemma in tokenization: "SoK of RWA
  Tokenization" (arXiv 2604.06608); Chainlink, "Privacy-Preserving Tokenization"
