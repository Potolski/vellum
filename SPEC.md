# Greenlight — a composable compliance layer for tokenized equities on Solana

**One-liner:** the transfer hook xStocks shipped switched off — an attestation registry + Token-2022 transfer hook that enforces securities compliance on *every* transfer, chain-wide, while keeping the token composable with DeFi (AMMs, lending, routing).

## Why (the gap)

- xStocks tokens on Solana ship with a Token-2022 **transfer hook initialized but disabled** — because hooks break DeFi integrations (Solana Foundation xStocks case study).
- US-facing tokenized equities (Superstate, Securitize, Dinari) all need per-transfer compliance; today each builds a proprietary allowlist, and none composes with permissionless DeFi.
- Project Open (Solana Policy Institute → SEC) proposes "Token Shares": registered equities traded wallet-to-wallet with KYC'd wallets. That needs exactly this primitive: **policy-enforced transfers that don't sacrifice composability**.
- Structural edge over EVM: a Solana transfer hook binds at the *token program* level — enforced in every venue and CPI. Uniswap v4 hooks only bind one pool; Base's B20 policy registry is a Coinbase-controlled precompile, closed to third-party issuers. ERC-3643 exists but breaks vanilla-ERC-20 composability.

## Architecture

```
                       ┌─────────────────────────────┐
  Attestor (KYC        │  greenlight program          │
  provider / issuer) ──►  Registry ── Attestation PDA │  per-wallet claims:
                       │  (authority)  ["attest",     │  KYC | ACCREDITED | VENUE
                       │               registry,      │  + jurisdiction (ISO 3166)
                       │               wallet]        │  + expiry
                       └──────────────▲──────────────┘
                                      │ read on every transfer
┌──────────────┐   transfer_checked   │
│ Token-2022   │──── invokes hook ────┤
│ mint w/      │                      │
│ TransferHook │   ┌──────────────────┴───────────────┐
└──────────────┘   │ Execute: load Policy ["policy",   │
                   │ mint] → check sender + receiver   │
   any venue:      │ attestations → allow / reject     │
   wallet, AMM,    │ VENUE claim ⇒ pool vaults pass    │
   lending, CPI    └──────────────────────────────────┘
```

### Accounts

| Account | Seeds | Contents |
|---|---|---|
| `Registry` | `["registry", authority]` | attestor authority allowed to issue claims |
| `Attestation` | `["attest", registry, subject]` | claims bitmask, jurisdiction (ISO 3166-1 numeric), expiry |
| `Policy` | `["policy", mint]` | issuer, trusted registry, flags, blocked jurisdictions, paused |
| ExtraAccountMetaList | `["extra-account-metas", mint]` | tells Token-2022 to pass Policy + both parties' Attestations to the hook |

The extra-account resolution uses **account-data seeds**: the attestation PDAs are derived from the token accounts' `owner` field (offset 32) and the policy's `registry` field — so *any* client or CPI caller (AMM, lending protocol) resolves them automatically with the standard SPL helpers (`createTransferCheckedWithTransferHookInstruction` off-chain, `onchain::invoke_transfer_checked` on-chain). That auto-resolution is the whole composability story.

### Policy flags

- `REQUIRE_SENDER_KYC` / `REQUIRE_RECEIVER_KYC` — both parties must hold a valid KYC attestation from the policy's registry
- `ALLOW_VENUES` — a wallet with a `VENUE` claim (AMM pool authority, lending vault) passes without KYC: this is how a permissioned token still LPs, swaps and collateralizes
- `REQUIRE_RECEIVER_ACCREDITED` — Reg D-style gating
- `blocked_jurisdictions` — receiver-side ISO-3166 blocklist
- `paused` — issuer emergency halt (regulatory stop, corporate action)

### Instructions

1. `init_registry(attestor)` — create attestor registry
2. `attest(claims, jurisdiction, expires_at)` — issue/update a wallet's attestation (attestor-signed)
3. `revoke()` — close an attestation
4. `init_policy(flags, blocked_jurisdictions)` — create Policy + ExtraAccountMetaList for a mint (one call onboards a mint)
5. `update_policy(flags, blocked_jurisdictions, paused)` — issuer-only
6. `transfer_hook (Execute)` — invoked by Token-2022 on every transfer; validates or rejects

Security details: the hook verifies both token accounts carry the `transferring` flag (can't be invoked outside a real transfer), attestation fields are matched against the policy's registry and the token-account owners, and expiry is checked against the clock.

## Milestones

- **M1 (core, this repo now):** greenlight program + localnet tests proving: attested→attested OK, →unattested rejected, blocked jurisdiction rejected, venue passes, pause halts.
- **M2 (the shim):** minimal CPMM (`greenlight_amm`) that swaps hooked tokens via `onchain::invoke_transfer_checked` — proof that a venue integrates with ~20 lines; pool authority gets a VENUE attestation.
- **M3 (demo polish):** TS SDK (`sdk/`), demo script minting a mock equity ("AAPLg") with hook + metadata, a wallet UI showing green/red transfer outcomes, pitch deck framing vs Project Open.

## Demo script (3 min)

1. Issuer mints AAPLg (Token-2022 + Greenlight hook). Alice is KYC'd (US), Dana KYC'd (DE), Bob unattested.
2. Alice → Dana: settles instantly. Alice → Bob: **fails inside the token program** — no venue logic, no frontend gating.
3. Alice swaps AAPLg on the AMM (pool = VENUE): works — a *permissioned* security routed through a permissionless venue.
4. Issuer adds Dana's jurisdiction to the blocklist / hits pause: the same transfers now fail. Compliance is a policy knob, not a redeploy.

## Honest limitations (for the pitch)

- Major AMMs (Raydium/Orca) and Jupiter don't route transfer-hook tokens *today* — our CPMM + SDK shows the integration cost is trivial; the ask is ecosystem adoption of the standard resolution helpers.
- Transfer hooks don't compose with confidential transfers (known Token-2022 limitation).
- Greenlight is infrastructure, not a securities issuer: demos use mock equities; real issuance needs a licensed issuer/transfer agent (that's the customer, not us).
