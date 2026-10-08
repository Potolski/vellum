#!/usr/bin/env bash
#
# Proves the Token-2022 confidential transfer pipeline end to end: configure ->
# deposit -> apply -> confidential transfer, leaving a holder whose public
# balance reads 0 while the real position sits in an ElGamal ciphertext.
#
# Isolates the crypto by using `--enable-confidential-transfers auto`. The
# product uses `manual`, where approval is gated by
# `vellum::approve_confidential_account`.
#
# Prerequisites (see docs/TOOLCHAIN.md -- both pins matter):
#   1. spl-token-cli >= 5.6.1    cargo install spl-token-cli --locked
#   2. a validator running the *mainnet* Token-2022, not the bundled one:
#        solana-test-validator --reset --quiet \
#          --url https://api.mainnet-beta.solana.com \
#          --clone-upgradeable-program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
#
# Usage: scripts/confidential-baseline.sh [work_dir]     (default: ./.confidential-demo)

set -uo pipefail

WORK="${1:-$(pwd)/.confidential-demo}"
RPC="${RPC_URL:-http://127.0.0.1:8899}"
TOKEN_2022="TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"

# Prefer a cargo-installed spl-token: the CLI bundled with the Solana release
# generates ElGamal proofs the patched on-chain verifier rejects.
SPL="${SPL_TOKEN_BIN:-$HOME/.cargo/bin/spl-token}"
[ -x "$SPL" ] || SPL="$(command -v spl-token)"
[ -n "$SPL" ] || { echo "error: spl-token not found; cargo install spl-token-cli --locked"; exit 1; }

VER="$($SPL --version 2>/dev/null | grep -oE "[0-9]+\.[0-9]+\.[0-9]+")"
echo "spl-token $VER  ($SPL)"
case "$VER" in
  5.5.*|5.4.*|5.3.*|4.*|3.*)
    echo "warning: $VER predates the ZK ElGamal proof fix; ConfigureAccount will fail."
    echo "         run: cargo install spl-token-cli --locked"
    ;;
esac

mkdir -p "$WORK"
CFG="$WORK/cli.yml"
ISS="$WORK/issuer.json"

[ -f "$ISS" ] || solana-keygen new -o "$ISS" --no-bip39-passphrase -s >/dev/null 2>&1
solana config set --config "$CFG" --url "$RPC" --keypair "$ISS" >/dev/null 2>&1

t()  { "$SPL" --config "$CFG" --program-2022 "$@"; }
pk() { grep -oE "(Creating (token|account)|Address:) *[A-Za-z0-9]{32,}" | grep -oE "[A-Za-z0-9]{32,}" | head -1; }

solana --config "$CFG" cluster-version >/dev/null 2>&1 \
  || { echo "error: no validator at $RPC"; exit 1; }

# The bundled Token-2022 is too old for current confidential instructions;
# Deposit fails with a bare InvalidInstructionData. ~1.38MB means it's the real one.
LEN="$(solana --config "$CFG" program show "$TOKEN_2022" 2>/dev/null | grep -oE "Data Length: [0-9]+" | grep -oE "[0-9]+")"
echo "Token-2022 data length: ${LEN:-unknown}"
[ "${LEN:-0}" -lt 1000000 ] 2>/dev/null && \
  echo "warning: looks like the bundled Token-2022; clone mainnet's (see header) or Deposit will fail."

# --- fund -------------------------------------------------------------------
solana --config "$CFG" airdrop 500 >/dev/null 2>&1
for k in alice bob; do
  [ -f "$WORK/$k.json" ] || solana-keygen new -o "$WORK/$k.json" --no-bip39-passphrase -s >/dev/null 2>&1
  # --reset wipes balances, so re-fund on every run or steps fail silently
  solana --config "$CFG" transfer "$(solana-keygen pubkey "$WORK/$k.json")" 25 \
    --allow-unfunded-recipient >/dev/null 2>&1
done
ALICE="$(solana-keygen pubkey "$WORK/alice.json")"
BOB="$(solana-keygen pubkey "$WORK/bob.json")"

# --- mint -------------------------------------------------------------------
MINT="$(t create-token --decimals 2 --enable-confidential-transfers auto --enable-freeze 2>&1 | pk)"
[ -z "$MINT" ] && { echo "error: create-token failed"; exit 1; }
echo "mint: $MINT"

# --owner isn't a signer, so the CLI can't infer a fee payer
AT="$(t create-account "$MINT" --owner "$ALICE" --fee-payer "$ISS" 2>&1 | pk)"
BT="$(t create-account "$MINT" --owner "$BOB"   --fee-payer "$ISS" 2>&1 | pk)"
echo "alice: $AT"
echo "bob:   $BT"
t mint "$MINT" 1200 "$AT" >/dev/null 2>&1 && echo "minted 1200 to alice"

# --- confidential pipeline --------------------------------------------------
sig() { grep -oE "Signature: [A-Za-z0-9]{40,}|InstructionError\([^)]*\)" | head -1 | sed 's/^/    /'; }

echo "configure:"
t configure-confidential-transfer-account --address "$AT" --owner "$WORK/alice.json" --fee-payer "$WORK/alice.json" 2>&1 | sig
t configure-confidential-transfer-account --address "$BT" --owner "$WORK/bob.json"   --fee-payer "$WORK/bob.json"   2>&1 | sig

echo "deposit 1200 + apply:"
t deposit-confidential-tokens "$MINT" 1200 --address "$AT" --owner "$WORK/alice.json" --fee-payer "$WORK/alice.json" 2>&1 | sig
t apply-pending-balance --address "$AT" --owner "$WORK/alice.json" --fee-payer "$WORK/alice.json" 2>&1 | sig

echo "confidential transfer 450 alice -> bob:"
t transfer "$MINT" 450 "$BOB" --confidential --from "$AT" --owner "$WORK/alice.json" --fee-payer "$WORK/alice.json" 2>&1 | sig
t apply-pending-balance --address "$BT" --owner "$WORK/bob.json" --fee-payer "$WORK/bob.json" >/dev/null 2>&1

# --- the point --------------------------------------------------------------
echo
echo "what any explorer sees:"
for pair in "alice:$AT" "bob:$BT"; do
  who="${pair%%:*}"; acct="${pair#*:}"
  printf "  %-6s public balance: %s\n" "$who" "$(t balance --address "$acct" 2>&1 | tail -1)"
  t account-info --address "$acct" 2>&1 | grep -E "Available Balance:" | head -1 | sed "s/^ */           /"
done
echo
echo "work dir: $WORK"
