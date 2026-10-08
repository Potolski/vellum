# Vellum Confidential — compliant *and* confidential tokenized equities

Addendum to `SPEC.md`. Written 2026-10-06. Submission deadline **2026-10-12 23:59 BRT**.

---

## 1. Why the sub-wallet splitting idea doesn't work

The proposal: one user wallet, N derived sub-wallets, split the position across them so the total balance is unknowable.

It fails, and it fails worse here than for a generic token.

**The killer, specific to this product.** `Attestation` is a PDA at `["attest", registry, subject]` where `subject` is the token-account **owner**. A compliance-gated security therefore requires *every holding wallet to publish its own attestation account on-chain*, signed by the same attestor, with `jurisdiction` in plaintext. Those accounts are enumerable — `getProgramAccounts` filtered on `Attestation.registry` returns the complete holder set, and the attestor's signature plus block proximity clusters them by issuance batch. **The compliance layer is a public ownership index.** Splitting across sub-wallets publishes exactly the cluster it's meant to hide. This isn't a detail to patch: a regulated security requires the issuer/transfer agent to know every holder, so a per-wallet on-chain record is non-negotiable.

**And the generic failures, all of which also apply:**
- *Funding graph* — sub-wallets have to be funded. The first transfer out of the parent links them permanently.
- *Fee payer* — rent and fees come from somewhere; a shared payer links every wallet in the set.
- *Timing* — wallets created and funded in the same block or batch cluster trivially.
- *Consolidation* — the moment the user sells or rebalances, the wallets co-sign or sequence together and the set collapses.
- *It doesn't even hide amounts* — each sub-wallet's balance stays public. Known supply minus known holders narrows the unknown fast.
- *Cost* — rent, ATA creation and attestation accounts scale linearly with N.

This is Bitcoin address-splitting. Clustering heuristics have defeated it for over a decade, and here we'd be handing the adversary a labelled index for free.

**The fix is to encrypt the balance, not scatter it.**

---

## 2. The primitive that does work, and why now

**Token-2022 `ConfidentialTransfer`**: balances and transfer amounts are ElGamal ciphertexts. Addresses stay public; *amounts do not*. The mint can designate an **`auditor_elgamal_pubkey`** that decrypts every amount — compliance readable by the issuer, opaque to everyone else.

Timing, which is the whole "why now":

| Date | Event |
|---|---|
| Apr 2025 | Confidential Balances ships — "first ZK-powered encrypted token standard built for institutional compliance" |
| **19 Jun 2025** | ZK ElGamal Proof Program **disabled** (epoch 805) after a soundness bug |
| **4 Jun 2026** | **Re-enabled** on mainnet (epoch 982) |
| ~18 Jun 2026 | Token-2022 redeployed with the confidential instructions |
| 16 Jul 2026 | ZK ElGamal JS SDK v0.3.2; web3.js support landing |

**The primitive has been usable on mainnet for ~4 months.** It was dark for the preceding year, which is why nothing is built on it yet.

---

## 3. The insight

> **Token-2022 forbids `TransferHook` and `ConfidentialTransfer` on the same mint.** A tokenized security can be compliant or confidential — never both.

(`SPEC.md` already lists this under honest limitations. Confirmed: `ConfidentialTransfer` is mutually exclusive with `TransferHook`, `TransferFeeConfig` and `PermanentDelegate`, because hooks are handed the plaintext amount.)

Everyone reads that as a dead end. It isn't, because **Vellum's policy never needed the amount.** It checks identity: KYC claim, accreditation, jurisdiction, expiry. The amount argument is ignored. The incompatibility is an artifact of the extension design, not of the policy.

So: **move enforcement from the transfer to the account.**

- `DefaultAccountState = Frozen` — every new token account is born unusable.
- Freeze authority delegated to the Vellum program.
- A `thaw_if_attested` instruction thaws an account *only* if its owner holds a valid attestation in the policy's registry.
- `ConfidentialTransferMint` with `auto_approve_new_accounts = false` — confidential configuration is also gated.

`DefaultAccountState` **is** compatible with `ConfidentialTransferMint`. And this is not a bespoke trick: it's the shape of **sRFC-37 / Token ACL**, the Solana Foundation's permissioned-token standard (`solana-foundation/token-acl`), which exists precisely because hooks are not always available.

**One attestation registry, two enforcement modes:**

| | Mode A — Hook *(built)* | Mode B — Confidential *(this sprint)* |
|---|---|---|
| Enforcement | per **transfer**, via transfer hook | per **account**, via freeze gate |
| Amounts | public | **ElGamal-encrypted** |
| Oversight | public ledger | **auditor key** decrypts |
| Composability | AMM / lending / any CPI | holding + direct transfer only |
| Use | trading venue leg | institutional / cap-table leg |

Same `Registry`, same `Attestation`, same attestor. The issuer picks the mode per mint.

---

## 4. What Mode B hides — stated precisely

**Hides:** account balances, transfer amounts, position sizes, portfolio composition by value.

**Does not hide:** that wallet A transferred to wallet B, who holds the asset at all, or the holder set.

For a *security* that split is arguably correct — the transfer agent is legally required to know its holders — and it is exactly the stated goal: **the total balance is private.** It is **not** anonymity, and the pitch must not claim it is.

**Why balance privacy is the actual institutional blocker.** Public positions mean: front-running of large orders, portfolio composition leaking to competitors, 13D/13G threshold crossings visible before filing, employee compensation legible to anyone. This is documented as the central barrier to institutional RWA adoption — the "privacy–transparency dilemma". No desk puts a real book on a ledger where every rival reads its size.

---

## 5. Honest trade-offs (for the pitch and the technical video)

1. **Per-account gating is coarser than per-transfer.** Jurisdiction is checked at thaw, not on every transfer. Mitigation: `refreeze_if_invalid`, a permissionless crank anyone can call once an attestation expires or is revoked — the position is frozen, never seized.
2. **No amount-based policy.** No per-transfer caps or volume limits — impossible by construction once amounts are encrypted. Honest answer: that class of rule moves off-chain to the auditor key.
3. **Confidential balances don't trade on an AMM.** Mode A remains the venue leg. The dual-mode architecture is the honest answer, not a workaround.
4. **`ConfidentialTransfer` sits behind a feature gate that has been switched off before** (Jun 2025 – Jun 2026). Real platform risk; name it rather than hide it.
5. **Decryption is client-side work.** Scanning balances requires the ElGamal secret; UX needs careful key handling.

---

## 6. Competitive position

- **Arcium + Umbra** — encrypted MPC network + shielded wallet, mainnet alpha Feb 2026. Viewing keys, risk screening, geo-blocking. General private payments/swaps. Closest neighbour; not a securities standard.
- **Helius Solana Rings** — programmable privacy infra, private asset+amount with public sender/recipient, optional compliance.
- **Encrypt.xyz** — private transfer infrastructure.
- **Cloak** (Brazil, Cohort 4) — ZKP privacy layer at Solana speed.

All horizontal privacy infrastructure. **None targets compliant tokenized equities.** The lane — a confidential, policy-gated equity register with an issuer-held viewing key — is open.

---

## 7. Five-day plan (Oct 6 → 12)

| Day | Deliverable |
|---|---|
| **1 — Oct 6** | `vellum` program: `init_confidential_policy`, `thaw_if_attested`, `refreeze_if_invalid`. Reuses `Registry`/`Attestation` unchanged. Unit + localnet tests. |
| **2 — Oct 7** | TS: create the confidential mint (`DefaultAccountState=Frozen` + `ConfidentialTransferMint{auto_approve=false, auditor}`); configure account; deposit → apply → confidential transfer between two thawed accounts. Prove encrypted transfer end to end. |
| **3 — Oct 8** | The demo. Side-by-side: public mint balance readable by anyone vs confidential mint showing ciphertext; unattested wallet cannot open an account; auditor key reveals the true number. |
| **4 — Oct 9** | `auditor-report` script (regulatory export: decrypt the full holder register). README + architecture diagram. Visible commit velocity. |
| **5 — Oct 10/11** | Pitch video ≤3 min (startup pitch, not a demo) + technical video 2–3 min (why we prioritised the freeze gate). Submission fields. **Oct 12 = buffer.** |

**Risk to resolve on Day 2:** the ZK ElGamal Proof Program is a native program — confirm it's active on the local validator; fall back to devnet if not. Decide early, it gates days 2–4.

**Track:** Solana ($100k, 10 × $10k) + the general pool. With five days and a Solana codebase, the multi-track plan from `worlds-fair-2026.md` is off — one submission per team, and a chain switch now would be fatal. Stated plainly rather than hedged.

---

## 8. Sources

- Token-2022 extension compatibility (`ConfidentialTransfer` × `TransferHook`/`TransferFeeConfig`/`PermanentDelegate` mutually exclusive; `DefaultAccountState` compatible with `ConfidentialTransferMint` at `auto_approve_new_accounts=false`) — solana.com/docs/tokens/extensions, Neodyme "Don't shoot yourself in the foot with extensions"
- sRFC-37 Token ACL — `solana-foundation/SRFCs` discussion #2, `solana-foundation/token-acl`, solana.com/developers/guides/advanced/acl
- ZK ElGamal Proof Program disable/re-enable timeline — Solana Changelog 16 Jul 2026; epoch 805 (19 Jun 2025) → epoch 982 (4 Jun 2026)
- Confidential transfer docs incl. auditor key — solana.com/docs/tokens/extensions/confidential-transfer/*, solana.com/docs/finance/privacy
- Institutional privacy–transparency dilemma — "SoK of RWA Tokenization" (arXiv 2604.06608), Chainlink "Privacy-Preserving Tokenization"
- Competitors — Messari "Arcium: Bringing Privacy to Solana with Umbra"; The Block, 2 Feb 2026; Helius Privacy docs
