# Greenlight

**The transfer hook xStocks shipped switched off.** A composable compliance layer for tokenized equities on Solana: an attestation registry + Token-2022 transfer hook that enforces securities policy (KYC, jurisdiction, accreditation, pause) on **every** transfer — including through DeFi venues — plus a reference AMM proving a permissioned token still swaps, LPs, and composes.

Built for the Colosseum Crypto World's Fair hackathon (Sept–Oct 2026). See [SPEC.md](SPEC.md) for the full architecture and pitch framing.

## Why

xStocks on Solana ships its Token-2022 transfer hook *initialized but disabled* because hooks break DeFi integrations. US-facing issuers (Superstate, Securitize, Dinari) each build proprietary allowlists that don't compose. Project Open's "Token Shares" proposal to the SEC needs exactly this primitive: per-transfer compliance without giving up composability.

Greenlight's answer, in one sentence: **compliance lives in the hook, composability lives in a VENUE claim** — pool/vault authorities get attested as venues, so tokens flow user → pool → user with the hook firing on every leg, and the policy decides who ultimately ends up holding.

## Programs

| Program | What it does |
|---|---|
| `greenlight` | Attestation registry (per-wallet claims: KYC / ACCREDITED / VENUE, jurisdiction, expiry) + per-mint `Policy` + the transfer hook that enforces it |
| `greenlight_amm` | Minimal constant-product AMM proving venue integration costs ~one line: `spl_token_2022::onchain::invoke_transfer_checked` auto-forwards the hook's accounts |

The hook's ExtraAccountMetaList uses account-data seeds, so **standard SPL helpers resolve everything automatically** — off-chain (`createTransferCheckedWithTransferHookInstruction`) and on-chain (CPI from any venue). No custom client logic per token.

## Run it

```bash
anchor test
```

15 tests cover: KYC'd↔KYC'd transfers, unattested rejection, jurisdiction blocklist, VENUE exemption (DeFi composability), revocation + re-attestation, issuer pause/unpause, direct-invocation protection, attestor auth — and the AMM flow where a KYC'd trader's swap succeeds while an unattested trader's identical swap reverts **inside the token program**.

## Demo storyline

1. Issuer mints an equity token with the Greenlight hook; policy: sender+receiver KYC required, venues allowed, sanctioned jurisdictions blocked.
2. Alice (KYC'd) → Dana (KYC'd): instant settlement. Alice → Bob (unattested): rejected by Token-2022 itself.
3. Alice swaps through the AMM — the pool authority holds a VENUE attestation. Works.
4. Bob tries the same swap: the out-leg fails in the hook. No venue-specific compliance code exists anywhere.
5. Issuer flips `paused` or updates the jurisdiction blocklist — policy changes apply to every venue instantly, no redeploys.

## Status / roadmap

- [x] M1 — core registry + hook + policy engine (11 tests)
- [x] M2 — AMM composability shim (4 tests)
- [ ] M3 — TS SDK package, demo UI (wallet green/red flows), devnet deploy, pitch deck
