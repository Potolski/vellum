#!/usr/bin/env bash
#
# Mode B end to end: the Vellum account gate driving a real Token-2022
# confidential mint. Where confidential-baseline.sh isolates the crypto with
# `auto` approval, this runs the product configuration:
#
#   - mint is `--enable-confidential-transfers manual` + `--default-account-state frozen`
#   - the Policy PDA holds both the freeze authority and the
#     confidential-transfer-mint authority, so only Vellum can thaw or approve
#   - holders are thawed and approved only while attested, and re-frozen once not
#   - the issuer's auditor key is set on the mint before that handover, so
#     every transfer amount is also encrypted to the issuer
#
# Every step is asserted, including the ones that must fail.
#
# Prerequisites (see docs/TOOLCHAIN.md):
#   1. spl-token-cli >= 5.6.1, and a validator running the mainnet Token-2022
#      (same two pins as confidential-baseline.sh)
#   2. `anchor build` and `yarn install`; the program is deployed here if missing
#   3. for the auditor key and the decrypted views at the end:
#      cargo build --release --manifest-path tools/reveal/Cargo.toml
#
# Usage: scripts/confidential-e2e.sh [work_dir]     (default: ./.confidential-demo)
#        REDEPLOY=1 to push a rebuilt program before running

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${1:-$ROOT/.confidential-demo}"
RPC="${RPC_URL:-http://127.0.0.1:8899}"
TOKEN_2022="TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"

SPL="${SPL_TOKEN_BIN:-$HOME/.cargo/bin/spl-token}"
[ -x "$SPL" ] || SPL="$(command -v spl-token)"
[ -n "$SPL" ] || { echo "error: spl-token not found; cargo install spl-token-cli --locked"; exit 1; }

mkdir -p "$WORK"
CFG="$WORK/cli.yml"
DEPLOYER="$WORK/deployer.json"
ISS="$WORK/issuer.json"

# The deployer persists across runs (it is the program's upgrade authority);
# the actors are regenerated so each run starts from a clean registry.
[ -f "$DEPLOYER" ] || solana-keygen new -o "$DEPLOYER" --no-bip39-passphrase -s >/dev/null 2>&1
for k in issuer auditor alice bob carol; do
  solana-keygen new -o "$WORK/$k.json" --no-bip39-passphrase -s --force >/dev/null 2>&1
done
solana config set --config "$CFG" --url "$RPC" --keypair "$ISS" >/dev/null 2>&1

s()  { solana --config "$CFG" "$@"; }
t()  { "$SPL" --config "$CFG" --program-2022 "$@"; }
v()  { RPC_URL="$RPC" KEYPAIR="$ISS" node "$ROOT/scripts/vellum.js" "$@"; }
pk() { grep -oE "(Creating (token|account)|Address:) *[A-Za-z0-9]{32,}" | grep -oE "[A-Za-z0-9]{32,}" | head -1; }
as() { local who="$1"; shift; "$@" --owner "$WORK/$who.json" --fee-payer "$WORK/$who.json"; }

# Client-side decryption (holder and auditor views). Optional: without it the
# mint is created with no auditor and the run ends at the explorer's view.
REVEAL="$ROOT/tools/reveal/target/release/vellum-reveal"
[ -x "$REVEAL" ] || REVEAL=""
audit_as() { "$REVEAL" audit "$WORK/$1.json" < "$WORK/history.json"; }

PASS=0; FAIL=0
# ok <label> <cmd...>             the command must succeed
ok() {
  local label="$1" out; shift
  if out="$("$@" 2>&1)"; then PASS=$((PASS+1)); printf "  ok    %s\n" "$label"
  else FAIL=$((FAIL+1)); printf "  FAIL  %s\n%s\n" "$label" "$(echo "$out" | tail -6 | sed 's/^/          /')"; fi
}
# no <label> <expected> <cmd...>  the command must fail, mentioning <expected>
no() {
  local label="$1" want="$2" out; shift 2
  if out="$("$@" 2>&1)"; then FAIL=$((FAIL+1)); printf "  FAIL  %s (succeeded, expected %s)\n" "$label" "$want"
  elif echo "$out" | grep -q "$want"; then PASS=$((PASS+1)); printf "  ok    %s  -> %s\n" "$label" "$want"
  else FAIL=$((FAIL+1)); printf "  FAIL  %s (expected %s)\n%s\n" "$label" "$want" "$(echo "$out" | tail -6 | sed 's/^/          /')"; fi
}

# --- environment ------------------------------------------------------------
s cluster-version >/dev/null 2>&1 || { echo "error: no validator at $RPC"; exit 1; }
LEN="$(s program show "$TOKEN_2022" 2>/dev/null | grep -oE "Data Length: [0-9]+" | grep -oE "[0-9]+")"
[ "${LEN:-0}" -lt 1000000 ] 2>/dev/null && \
  echo "warning: looks like the bundled Token-2022; clone mainnet's (docs/TOOLCHAIN.md) or Deposit will fail."
[ -f "$ROOT/target/idl/vellum.json" ] || { echo "error: run \`anchor build\` first"; exit 1; }

s airdrop 100 "$(solana-keygen pubkey "$DEPLOYER")" >/dev/null 2>&1
s airdrop 100 >/dev/null 2>&1
for k in alice bob carol; do
  s transfer "$(solana-keygen pubkey "$WORK/$k.json")" 5 --allow-unfunded-recipient >/dev/null 2>&1
done
ALICE="$(solana-keygen pubkey "$WORK/alice.json")"
BOB="$(solana-keygen pubkey "$WORK/bob.json")"
CAROL="$(solana-keygen pubkey "$WORK/carol.json")"

PROGRAM_ID="$(solana-keygen pubkey "$ROOT/target/deploy/vellum-keypair.json")"
if [ -n "${REDEPLOY:-}" ] || ! s program show "$PROGRAM_ID" >/dev/null 2>&1; then
  echo "deploying vellum ($PROGRAM_ID)..."
  s program deploy "$ROOT/target/deploy/vellum.so" \
    --program-id "$ROOT/target/deploy/vellum-keypair.json" \
    --keypair "$DEPLOYER" --upgrade-authority "$DEPLOYER" >/dev/null 2>&1 \
    || { echo "error: deploy failed (is $DEPLOYER the upgrade authority?)"; exit 1; }
fi
echo "vellum:  $PROGRAM_ID"

# --- issuer: mint, registry, policy -----------------------------------------
echo
echo "issuer onboarding"
MINT="$(t create-token --decimals 2 --enable-confidential-transfers manual \
  --default-account-state frozen --enable-freeze 2>&1 | pk)"
[ -z "$MINT" ] && { echo "error: create-token failed"; exit 1; }
POLICY="$(v policy-pda "$MINT")"
echo "  mint    $MINT"
echo "  policy  $POLICY"

ok "create attestor registry"                    v init-registry
ok "attest alice (KYC, US)"                      v attest "$ALICE"
ok "attest bob (KYC, US)"                        v attest "$BOB"
no "policy refused while issuer keeps freeze authority" PolicyNotFreezeAuthority \
                                                 v init-confidential-policy "$MINT"
# Last chance to set it: once the policy PDA holds the confidential authority
# nobody can swap the auditor key, the issuer included.
[ -n "$REVEAL" ] && \
ok "set the issuer's auditor key on the mint"    t update-confidential-transfer-settings "$MINT" \
                                                   --auditor-pubkey "$("$REVEAL" auditor-key "$WORK/auditor.json")"
ok "hand freeze authority to the policy PDA"     t authorize "$MINT" freeze "$POLICY"
ok "hand confidential authority to the policy PDA" \
                                                 t authorize "$MINT" confidential-transfer-mint "$POLICY"
ok "create confidential policy"                  v init-confidential-policy "$MINT"

# --- holders: born frozen, thawed only if attested --------------------------
echo
echo "account gate"
AT="$(t create-account "$MINT" --owner "$ALICE" --fee-payer "$ISS" 2>&1 | pk)"
BT="$(t create-account "$MINT" --owner "$BOB"   --fee-payer "$ISS" 2>&1 | pk)"
CT="$(t create-account "$MINT" --owner "$CAROL" --fee-payer "$ISS" 2>&1 | pk)"
[ -n "$AT" ] && [ -n "$BT" ] && [ -n "$CT" ] || { echo "error: create-account failed"; exit 1; }

no "mint to alice while her account is still frozen" "frozen" \
                                                 t mint "$MINT" 1200 "$AT"
no "thaw carol (never attested)" HolderNotAttested \
                                                 v thaw "$MINT" "$CT"
ok "thaw alice"                                  v thaw "$MINT" "$AT"
ok "thaw bob"                                    v thaw "$MINT" "$BT"
ok "mint 1200 to alice"                          t mint "$MINT" 1200 "$AT"

# --- confidential balances, approved only if attested -----------------------
echo
echo "confidential pipeline"
ok "alice configures her account for confidential transfers" \
                                                 as alice t configure-confidential-transfer-account --address "$AT"
ok "bob configures his account"                  as bob t configure-confidential-transfer-account --address "$BT"
# 0x18 = TokenError::ConfidentialTransferAccountNotApproved
no "deposit before Vellum approves the account" "0x18" \
                                                 as alice t deposit-confidential-tokens "$MINT" 1200 --address "$AT"
no "approve carol (never attested)" HolderNotAttested \
                                                 v approve "$MINT" "$CT"
ok "approve alice"                               v approve "$MINT" "$AT"
ok "approve bob"                                 v approve "$MINT" "$BT"
ok "alice deposits 1200 into her encrypted balance" \
                                                 as alice t deposit-confidential-tokens "$MINT" 1200 --address "$AT"
ok "alice applies pending balance"               as alice t apply-pending-balance --address "$AT"
ok "confidential transfer 450 alice -> bob"      as alice t transfer "$MINT" 450 "$BOB" --confidential --from "$AT"
ok "bob applies pending balance"                 as bob t apply-pending-balance --address "$BT"

# --- lifecycle: revocation freezes, never seizes ----------------------------
echo
echo "revocation"
no "refreeze alice while she is still eligible (grief-freeze guard)" HolderStillEligible \
                                                 v refreeze "$MINT" "$AT"
ok "attestor revokes bob"                        v revoke "$BOB"
ok "anyone can now refreeze bob"                 v refreeze "$MINT" "$BT"
no "confidential transfer to bob while frozen" "frozen" \
                                                 as alice t transfer "$MINT" 100 "$BOB" --confidential --from "$AT"
no "thaw bob while revoked" HolderNotAttested    v thaw "$MINT" "$BT"
ok "attestor re-attests bob"                     v attest "$BOB"
ok "thaw bob again"                              v thaw "$MINT" "$BT"
ok "confidential transfer 100 alice -> bob"      as alice t transfer "$MINT" 100 "$BOB" --confidential --from "$AT"

# --- the point --------------------------------------------------------------
echo
echo "what any explorer sees:"
for pair in "alice:$AT" "bob:$BT"; do
  who="${pair%%:*}"; acct="${pair#*:}"
  printf "  %-6s public balance: %s\n" "$who" "$(t balance --address "$acct" 2>&1 | grep -m1 .)"
  t account-info --address "$acct" 2>&1 | grep -E "Available Balance:" | head -1 | sed "s/^ */           /"
done

# The other half: each holder reads their own position back, client-side, with
# keys derived from their wallet signature.
if [ -n "$REVEAL" ]; then
  echo
  echo "what each holder sees:"
  for pair in "alice:$AT" "bob:$BT"; do
    who="${pair%%:*}"; acct="${pair#*:}"
    t account-info --address "$acct" --output json 2>/dev/null \
      | "$REVEAL" balance "$WORK/$who.json" 2>&1 | sed "s/^/  $(printf '%-6s' "$who") /"
  done

  # And the issuer reads all of them: the register, rebuilt from the mint's
  # history with the auditor key.
  echo
  echo "what the auditor sees:"
  v history "$MINT" > "$WORK/history.json"
  audit_as auditor 2>&1 | tee "$WORK/register.txt" | sed "s/^/  /"
  echo
  ok "auditor's figure for alice matches her own (650.00)" \
                                                   grep -q "$ALICE .*confidential 650.00" "$WORK/register.txt"
  ok "auditor's figure for bob matches his own (450.00 + 100.00 pending)" \
                                                   grep -q "$BOB .*confidential 550.00" "$WORK/register.txt"
  no "a holder's key cannot audit the mint" "not the mint's auditor" \
                                                   audit_as alice
else
  echo
  echo "(build tools/reveal to decrypt these: cargo build --release --manifest-path tools/reveal/Cargo.toml)"
fi

echo
echo "$PASS passed, $FAIL failed    (work dir: $WORK)"
[ "$FAIL" -eq 0 ]
