#!/usr/bin/env bash
set -uo pipefail
cd /tmp/gl-demo
CFG=/tmp/gl-demo/cli.yml; ISS=/tmp/gl-demo/issuer.json
t() { ~/.cargo/bin/spl-token --config "$CFG" --program-2022 "$@"; }
pk() { grep -oE "(Creating (token|account)|Address:) *[A-Za-z0-9]{32,}" | grep -oE "[A-Za-z0-9]{32,}" | head -1; }
solana --config "$CFG" airdrop 500 >/dev/null 2>&1
for k in alice bob; do solana --config "$CFG" transfer "$(solana-keygen pubkey $k.json)" 25 --allow-unfunded-recipient >/dev/null 2>&1; done
ALICE=$(solana-keygen pubkey alice.json); BOB=$(solana-keygen pubkey bob.json)

MINT=$(t create-token --decimals 2 --enable-confidential-transfers auto --enable-freeze 2>&1 | pk)
echo "MINT=$MINT"
AT=$(t create-account "$MINT" --owner "$ALICE" --fee-payer "$ISS" 2>&1 | pk)
BT=$(t create-account "$MINT" --owner "$BOB"   --fee-payer "$ISS" 2>&1 | pk)
t mint "$MINT" 1200 "$AT" >/dev/null 2>&1 && echo "minted 1200 to alice"

echo "-- configure both"
t configure-confidential-transfer-account --address "$AT" --owner alice.json --fee-payer alice.json >/dev/null 2>&1 && echo "   alice configured"
t configure-confidential-transfer-account --address "$BT" --owner bob.json --fee-payer bob.json >/dev/null 2>&1 && echo "   bob configured"

echo "-- deposit 1200 + apply"
t deposit-confidential-tokens "$MINT" 1200 --address "$AT" --owner alice.json --fee-payer alice.json 2>&1 | grep -oE "Signature: [A-Za-z0-9]{40,}|InstructionError\([^)]*\)" | head -2 | sed 's/^/   /'
t apply-pending-balance --address "$AT" --owner alice.json --fee-payer alice.json 2>&1 | grep -oE "Signature: [A-Za-z0-9]{40,}|InstructionError\([^)]*\)" | head -2 | sed 's/^/   /'
echo "   alice PUBLIC balance after deposit: $(t balance --address "$AT" 2>&1 | tail -1)"

echo "-- CONFIDENTIAL transfer 450 alice -> bob"
t transfer "$MINT" 450 "$BOB" --confidential --from "$AT" --owner alice.json --fee-payer alice.json 2>&1 | grep -oE "Signature: [A-Za-z0-9]{40,}|InstructionError\([^)]*\)|panicked|InsufficientFunds" | head -4 | sed 's/^/   /'
t apply-pending-balance --address "$BT" --owner bob.json --fee-payer bob.json >/dev/null 2>&1 && echo "   bob applied pending"

echo "-- PUBLIC view (what an explorer sees)"
echo "   alice: $(t balance --address "$AT" 2>&1 | tail -1)"
echo "   bob:   $(t balance --address "$BT" 2>&1 | tail -1)"
echo "-- alice confidential ciphertext"
t account-info --address "$AT" 2>&1 | grep -E "Available Balance|Decryptable" | sed 's/^/  /'
echo "-- bob confidential ciphertext"
t account-info --address "$BT" 2>&1 | grep -E "Available Balance|Decryptable" | sed 's/^/  /'
echo "MINT=$MINT AT=$AT BT=$BT" > /tmp/gl-demo/auto.env
