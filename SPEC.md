# Vellum: the compliance layer

Vellum is an on-chain attestation registry and policy engine for tokenized
securities on Solana. An attestor (a KYC provider or the issuer) records what it
knows about a wallet; an issuer attaches a policy to its mint; the token program
itself refuses any movement the policy does not allow.

This document covers the registry, the policy, and **Mode A**, where the policy
runs on every transfer through a Token-2022 transfer hook and amounts are
public. **Mode B**, where balances are encrypted and the policy runs at the
account level, is specified in [SPEC-confidential.md](SPEC-confidential.md).
Both modes share the same registry and attestations.

## The problem

A regulated security has transfer restrictions: who may hold it, where they
are, whether they are accredited. On Solana today those restrictions are
enforced, if at all, in the issuer's own front end or in a proprietary
allowlist.

- Tokenized stocks already on Solana ship with a Token-2022 transfer hook
  **initialized but disabled**, because an enabled hook breaks most DeFi
  integrations.
- Issuers that need per-transfer compliance each build their own allowlist.
  None of them composes with a permissionless venue.
- Proposals for registered equities traded wallet to wallet between KYC'd
  holders need exactly this: transfers that enforce policy without giving up
  composability.

A Solana transfer hook binds at the token program, so it is enforced in every
venue and every cross-program call, not in one pool or one app. Vellum is that
hook, built so that venues can integrate without writing any Vellum-specific
code.

## How it works

```
                       ┌─────────────────────────────┐
  Attestor (KYC        │  vellum program              │
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

1. An attestor creates a **registry** and issues **attestations** to wallets.
2. An issuer creates a **policy** for its mint, naming the registry it trusts.
3. On every transfer, Token-2022 calls the hook. The hook loads the policy and
   both parties' attestations and either lets the transfer through or fails it.

A rejected transfer fails inside the token program. There is no venue logic and
no front-end gating to bypass.

## Accounts

| Account | Seeds | Contents |
|---|---|---|
| `Registry` | `["registry", authority]` | the attestor allowed to issue claims |
| `Attestation` | `["attest", registry, subject]` | claims bitmask, jurisdiction (ISO 3166-1 numeric), expiry |
| `Policy` | `["policy", mint]` | issuer, trusted registry, flags, blocked jurisdictions, paused |
| ExtraAccountMetaList | `["extra-account-metas", mint]` | tells Token-2022 to pass the policy and both attestations to the hook |

### Claims

An attestation carries any combination of:

- `KYC`: the wallet's owner has been identified.
- `ACCREDITED`: the owner is an accredited investor.
- `VENUE`: the wallet is a compliant venue, such as an AMM pool authority or a
  lending vault.

plus a jurisdiction and an optional expiry. Attestations are public accounts:
anyone can see that a wallet is attested, by whom, and for which jurisdiction.

### Policy flags

- `REQUIRE_SENDER_KYC` / `REQUIRE_RECEIVER_KYC`: the party must hold a valid
  `KYC` attestation from the policy's registry.
- `ALLOW_VENUES`: a wallet with a `VENUE` claim passes without KYC. This is how
  a permissioned token can still be pooled, swapped and used as collateral.
- `REQUIRE_RECEIVER_ACCREDITED`: the receiver must hold an `ACCREDITED` claim.
- `blocked_jurisdictions`: up to eight ISO 3166 codes a receiver may not be in.
- `paused`: the issuer halts every transfer (regulatory stop, corporate action).

Changing a flag, the blocklist or the pause takes effect on the next transfer in
every venue. Nothing is redeployed.

## Instructions

| Instruction | Signer | Effect |
|---|---|---|
| `init_registry(attestor)` | registry authority | creates a registry |
| `attest(subject, claims, jurisdiction, expires_at)` | attestor | issues or updates a wallet's attestation |
| `revoke(subject)` | attestor | closes an attestation |
| `init_policy(flags, blocked_jurisdictions)` | issuer | creates the policy and the hook's account list for a mint, in one call |
| `update_policy(flags, blocked_jurisdictions, paused)` | issuer | changes the policy |
| `transfer_hook` (Execute) | Token-2022 | validates or rejects a transfer |

## Composability

The hook needs three extra accounts on every transfer: the policy and each
party's attestation. Their addresses are derived from data already in the
transaction: the attestation PDAs come from each token account's `owner` field
and the policy's `registry` field.

Because of that, the standard SPL helpers resolve everything on their own:
`createTransferCheckedWithTransferHookInstruction` off-chain, and
`spl_token_2022::onchain::invoke_transfer_checked` from another program. A
venue that already uses those helpers supports a Vellum token with no
Vellum-specific code.

`vellum_amm`, a minimal constant-product AMM in this repository, demonstrates
it. Its pool authority holds a `VENUE` attestation. A KYC'd trader's swap goes
through; an unattested trader's identical swap reverts in the hook.

## Security properties

- **The hook cannot be called outside a real transfer.** It checks that both
  token accounts carry Token-2022's `transferring` flag.
- **Attestations cannot be substituted.** Each one is checked against the
  policy's registry and against the owner of the token account it is presented
  for.
- **Expiry is enforced on-chain**, against the cluster clock.
- **Only the attestor can attest or revoke; only the issuer can change a
  policy.**

## Limits

- **Venue support is not universal.** The large Solana AMMs and aggregators do
  not route transfer-hook tokens today. The integration is small (see
  `vellum_amm`), but it is each venue's to make.
- **No confidentiality in this mode.** Token-2022 does not allow a transfer hook
  and confidential transfers on the same mint. Mode B exists for that.
- **Vellum is infrastructure, not an issuer.** The tests and demos use mock
  equities. Issuing a real security needs a licensed issuer or transfer agent,
  who would be the user of this program.
- **Not audited.** The programs run on a local validator and have not been
  reviewed by a third party.

## Status

Both programs are implemented and tested: `anchor test` runs 34 tests, 15 of
them for this mode (registry, policy, hook and the AMM flow). The
[README](README.md) has the commands.
