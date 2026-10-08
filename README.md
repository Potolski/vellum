# Vellum

**The confidential share register.** Compliant *and* private tokenized equities on Solana — an attestation registry that enforces securities policy (KYC, jurisdiction, accreditation, pause) while holders' balances stay encrypted on-chain and only the issuer holds the key to read them.

Built for the Colosseum Crypto World's Fair hackathon (Sept–Oct 2026). See [SPEC.md](SPEC.md) for the compliance layer and [SPEC-confidential.md](SPEC-confidential.md) for the confidential mode.

## Why

Every US stock is already held privately. Shares are registered to a single nominee — Cede & Co., which held 83% of all issued US equities — and beneficial owners are known only down the custody chain. Public blockchains threw that away: put a real book on-chain and every rival reads its size. Front-running, portfolio leakage, 13D/13G thresholds visible before filing. It is the documented blocker on institutional RWA adoption.

The obvious fix is Token-2022's `ConfidentialTransfer` extension: ElGamal-encrypted balances with a designated **auditor key**. But Token-2022 **refuses to carry `ConfidentialTransfer` and `TransferHook` on the same mint** — hooks are handed the plaintext amount. So a tokenized security could be compliant or confidential, never both.

Vellum's answer: **our policy never needed the amount.** It checks identity — KYC, accreditation, jurisdiction, expiry. So enforcement moves from the *transfer* to the *account*: the mint is `DefaultAccountState = Frozen`, its freeze authority is the `Policy` PDA, and an account thaws only while its owner holds a valid attestation. That is compatible with confidential transfers, and it is the shape of [sRFC-37 / Token ACL](https://github.com/solana-foundation/token-acl).

One registry, two enforcement modes:

| | Mode A — hook | Mode B — confidential |
|---|---|---|
| Enforcement | per **transfer** | per **account** (freeze gate) |
| Amounts | public | **ElGamal-encrypted** |
| Oversight | public ledger | **auditor key** decrypts |
| Composability | AMM / lending / any CPI | holding + direct transfer |

Mode B hides balances and transfer amounts. It does **not** hide addresses or the holder set — for a security that split is the point, since the transfer agent is required to know its holders. This is balance privacy, not anonymity.

## Programs

| Program | What it does |
|---|---|
| `vellum` | Attestation registry (per-wallet claims: KYC / ACCREDITED / VENUE, jurisdiction, expiry) + per-mint `Policy`, the transfer hook (Mode A), and the freeze gate (Mode B: `thaw_if_attested`, `approve_confidential_account`, `refreeze_if_invalid`) |
| `vellum_amm` | Minimal constant-product AMM proving venue integration costs ~one line: `spl_token_2022::onchain::invoke_transfer_checked` auto-forwards the hook's accounts |

The hook's ExtraAccountMetaList uses account-data seeds, so **standard SPL helpers resolve everything automatically** — off-chain (`createTransferCheckedWithTransferHookInstruction`) and on-chain (CPI from any venue). No custom client logic per token.

## Run it

```bash
anchor test
```

28 tests. Mode A: KYC'd↔KYC'd transfers, unattested rejection, jurisdiction blocklist, VENUE exemption (DeFi composability), revocation + re-attestation, issuer pause/unpause, direct-invocation protection, attestor auth — and the AMM flow where a KYC'd trader's swap succeeds while an unattested trader's identical swap reverts **inside the token program**. Mode B: accounts are born frozen; only attested holders can be thawed or approved for an encrypted balance; expiry, revocation, a blocked jurisdiction or an issuer pause each close the gate; a compliant holder cannot be re-frozen, including by substituting someone else's attestation account.

## Demo storyline

1. Issuer mints an equity token with the Vellum hook; policy: sender+receiver KYC required, venues allowed, sanctioned jurisdictions blocked.
2. Alice (KYC'd) → Dana (KYC'd): instant settlement. Alice → Bob (unattested): rejected by Token-2022 itself.
3. Alice swaps through the AMM — the pool authority holds a VENUE attestation. Works.
4. Bob tries the same swap: the out-leg fails in the hook. No venue-specific compliance code exists anywhere.
5. Issuer flips `paused` or updates the jurisdiction blocklist — policy changes apply to every venue instantly, no redeploys.

## Confidential mode

The public ledger shows nothing; the holder reads their own position back with
keys derived from their wallet signature; the issuer rebuilds the whole register
with the mint's auditor key. One run, on localnet, of a real
Token-2022 confidential mint whose freeze authority *and* confidential-transfer
authority are the Vellum policy PDA:

```bash
scripts/confidential-e2e.sh      # 34 asserted steps, including the ones that must fail
```

```
what any explorer sees:
  alice  public balance: 0
           Available Balance: dEvPNqI+DiWsT1YMmVgCums9b51dSeISlemqga...
  bob    public balance: 0
           Available Balance: bl+01vo7k+HqJUfvHUaeFHsVusO8N2KhYW7bln...

what each holder sees:
  alice  available 650.00
  alice  pending   0.00
  bob    available 450.00
  bob    pending   100.00

what the auditor sees:
  transfers
    GQkM…ntgK -> BooR…8Js4  450.00
    GQkM…ntgK -> BooR…8Js4  100.00
  register
    BooR…8Js4  public 0.00  confidential 550.00  total 550.00
    GQkM…ntgK  public 0.00  confidential 650.00  total 650.00
```

Along the way the script shows the gate binding: the policy cannot be created
until the issuer hands over freeze authority, an unattested wallet can be
neither thawed nor approved, a deposit is rejected until Vellum approves the
account, and revoking Bob freezes his position (never seizes it) until he is
re-attested.

The auditor key is set on the mint before the issuer hands the confidential
authority to the policy PDA; after that nobody can swap it. Balances are
encrypted to their holders, not to the auditor, so the audit reads them the way
a transfer agent would: deposits and withdrawals are public, each transfer
carries its amount encrypted to the auditor key, and the register is the sum.
The script checks the auditor's figures against each holder's own, and that a
holder's key cannot run the audit.

`tools/reveal` is the client-side decryption, for holder and auditor (`cargo
build --release --manifest-path tools/reveal/Cargo.toml`); `scripts/vellum.js`
is a small client for the registry and gate instructions, and `history <mint>`
feeds the audit.

Running confidential transfers locally needs two non-obvious version pins (both
surface as a generic `InvalidInstructionData`) — written up in
[docs/TOOLCHAIN.md](docs/TOOLCHAIN.md). `scripts/confidential-baseline.sh`
isolates the crypto from the gate if you need to tell the two apart.

## Landing page

`web/` is the marketing page (Next.js, static export): `cd web && yarn install && yarn dev`.

## Status / roadmap

- [x] M1 — core registry + hook + policy engine (11 tests)
- [x] M2 — AMM composability shim (4 tests)
- [x] M3 — confidential mode: freeze gate + account-level policy (13 tests),
      run end to end against a real confidential mint on localnet, with
      client-side balance decryption and an auditor-key register
- [ ] M4 — holder wallet UI, devnet deploy
