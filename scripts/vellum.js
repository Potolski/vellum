#!/usr/bin/env node
//
// Minimal client for the Vellum instructions the confidential flow needs. The
// spl-token CLI drives the Token-2022 side (it is the only client that can
// generate the ZK proofs); this drives the registry and the account gate.
//
// Usage: node scripts/vellum.js <command> [args]      (after `anchor build`)
//
//   policy-pda <mint>                       print the Policy PDA for a mint
//   init-registry                           registry owned and attested by the signer
//   attest <subject> [claims] [iso] [exp]   defaults: KYC, 840 (US), never expires
//   revoke <subject>
//   init-confidential-policy <mint> [flags] [blocked,iso,codes]
//   thaw <mint> <token_account>
//   approve <mint> <token_account>
//   refreeze <mint> <token_account>
//   history <mint>                          JSON for `vellum-reveal audit`: the
//                                           holders and every confidential movement
//
// Env: RPC_URL (default http://127.0.0.1:8899), KEYPAIR (default ~/.config/solana/id.json)

const fs = require("fs");
const os = require("os");
const path = require("path");
const anchor = require("@coral-xyz/anchor");
const { Connection, Keypair, PublicKey, SystemProgram } = require("@solana/web3.js");
const {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getExtensionData,
  getMint,
  unpackAccount,
} = require("@solana/spl-token");

const KYC = 1 << 0;
const REQUIRE_SENDER_KYC = 1 << 0;
const REQUIRE_RECEIVER_KYC = 1 << 1;

// Token-2022 instruction layout, for reading confidential history back.
const CONFIDENTIAL_TRANSFER_EXTENSION = 27;
const DEPOSIT = 5;
const WITHDRAW = 6;
const TRANSFER = 7;
const AE_CIPHERTEXT_LEN = 36;
const ELGAMAL_CIPHERTEXT_LEN = 64;
const ELGAMAL_PUBKEY_LEN = 32;

const idlPath = path.join(__dirname, "..", "target", "idl", "vellum.json");
if (!fs.existsSync(idlPath)) {
  console.error("error: target/idl/vellum.json not found; run `anchor build` first");
  process.exit(1);
}
const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));

const keypairPath =
  process.env.KEYPAIR || path.join(os.homedir(), ".config", "solana", "id.json");
const signer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf8")))
);
const connection = new Connection(
  process.env.RPC_URL || "http://127.0.0.1:8899",
  "confirmed"
);
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(signer), {
  commitment: "confirmed",
  preflightCommitment: "confirmed",
});
const program = new anchor.Program(idl, provider);

const pda = (...seeds) =>
  PublicKey.findProgramAddressSync(seeds, program.programId)[0];
const registryOf = (authority) => pda(Buffer.from("registry"), authority.toBuffer());
const policyOf = (mint) => pda(Buffer.from("policy"), mint.toBuffer());
const attestationOf = (registry, subject) =>
  pda(Buffer.from("attest"), registry.toBuffer(), subject.toBuffer());

/** Accounts shared by the three gate instructions. */
async function gateAccounts(mintArg, tokenAccountArg) {
  const mint = new PublicKey(mintArg);
  const tokenAccount = new PublicKey(tokenAccountArg);
  const policy = policyOf(mint);
  const { registry } = await program.account.policy.fetch(policy);
  const { owner } = await getAccount(
    connection,
    tokenAccount,
    "confirmed",
    TOKEN_2022_PROGRAM_ID
  );
  return {
    cranker: signer.publicKey,
    mint,
    tokenAccount,
    policy,
    attestation: attestationOf(registry, owner),
    tokenProgram: TOKEN_2022_PROGRAM_ID,
  };
}

/** Every Token-2022 instruction in a transaction, CPIs included. */
function tokenInstructions(tx) {
  const keys = tx.transaction.message.getAccountKeys({
    accountKeysFromLookups: tx.meta.loadedAddresses,
  });
  const outer = tx.transaction.message.compiledInstructions.map((ix) => ({
    programIdIndex: ix.programIdIndex,
    accounts: ix.accountKeyIndexes,
    data: Buffer.from(ix.data),
  }));
  const inner = (tx.meta.innerInstructions ?? []).flatMap(({ instructions }) =>
    instructions.map((ix) => ({
      programIdIndex: ix.programIdIndex,
      accounts: ix.accounts,
      data: Buffer.from(anchor.utils.bytes.bs58.decode(ix.data)),
    }))
  );
  return [...outer, ...inner]
    .filter((ix) => keys.get(ix.programIdIndex).equals(TOKEN_2022_PROGRAM_ID))
    .map((ix) => ({ data: ix.data, accounts: ix.accounts.map((i) => keys.get(i)) }));
}

/** A deposit, withdrawal or transfer of `mint`, or null for anything else.
 *  Transfer amounts stay encrypted: only the auditor ciphertexts are emitted. */
function confidentialEvent(ix, mint) {
  const { data, accounts } = ix;
  if (data[0] !== CONFIDENTIAL_TRANSFER_EXTENSION || !accounts[1]?.equals(mint)) return null;
  const account = accounts[0].toBase58();
  switch (data[1]) {
    case DEPOSIT:
      return { kind: "deposit", account, amount: data.readBigUInt64LE(2).toString() };
    case WITHDRAW:
      return { kind: "withdraw", account, amount: data.readBigUInt64LE(2).toString() };
    case TRANSFER: {
      const lo = 2 + AE_CIPHERTEXT_LEN;
      const hi = lo + ELGAMAL_CIPHERTEXT_LEN;
      return {
        kind: "transfer",
        account,
        destination: accounts[2].toBase58(),
        lo: data.subarray(lo, hi).toString("base64"),
        hi: data.subarray(hi, hi + ELGAMAL_CIPHERTEXT_LEN).toString("base64"),
      };
    }
    default:
      return null;
  }
}

const commands = {
  "policy-pda": async ([mint]) => {
    console.log(policyOf(new PublicKey(mint)).toBase58());
  },

  "init-registry": async () => {
    const registry = registryOf(signer.publicKey);
    const sig = await program.methods
      .initRegistry(signer.publicKey)
      .accountsPartial({
        authority: signer.publicKey,
        registry,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`registry ${registry.toBase58()}  sig ${sig}`);
  },

  attest: async ([subjectArg, claims = KYC, jurisdiction = 840, expiresAt = 0]) => {
    const subject = new PublicKey(subjectArg);
    const registry = registryOf(signer.publicKey);
    const sig = await program.methods
      .attest(subject, Number(claims), Number(jurisdiction), new anchor.BN(expiresAt))
      .accountsPartial({
        attestor: signer.publicKey,
        registry,
        attestation: attestationOf(registry, subject),
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`attested ${subject.toBase58()}  sig ${sig}`);
  },

  revoke: async ([subjectArg]) => {
    const subject = new PublicKey(subjectArg);
    const registry = registryOf(signer.publicKey);
    const sig = await program.methods
      .revoke(subject)
      .accountsPartial({
        attestor: signer.publicKey,
        registry,
        attestation: attestationOf(registry, subject),
      })
      .rpc();
    console.log(`revoked ${subject.toBase58()}  sig ${sig}`);
  },

  "init-confidential-policy": async ([
    mintArg,
    policyFlags = REQUIRE_SENDER_KYC | REQUIRE_RECEIVER_KYC,
    blockedArg = "",
  ]) => {
    const mint = new PublicKey(mintArg);
    const blocked = new Array(8).fill(0);
    blockedArg
      .split(",")
      .filter(Boolean)
      .forEach((code, i) => (blocked[i] = Number(code)));
    const sig = await program.methods
      .initConfidentialPolicy(Number(policyFlags), blocked)
      .accountsPartial({
        issuer: signer.publicKey,
        mint,
        registry: registryOf(signer.publicKey),
        policy: policyOf(mint),
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`policy ${policyOf(mint).toBase58()}  sig ${sig}`);
  },

  thaw: async ([mint, tokenAccount]) => {
    const sig = await program.methods
      .thawIfAttested()
      .accountsPartial(await gateAccounts(mint, tokenAccount))
      .rpc();
    console.log(`thawed ${tokenAccount}  sig ${sig}`);
  },

  approve: async ([mint, tokenAccount]) => {
    const sig = await program.methods
      .approveConfidentialAccount()
      .accountsPartial(await gateAccounts(mint, tokenAccount))
      .rpc();
    console.log(`approved ${tokenAccount}  sig ${sig}`);
  },

  refreeze: async ([mint, tokenAccount]) => {
    const sig = await program.methods
      .refreezeIfInvalid()
      .accountsPartial(await gateAccounts(mint, tokenAccount))
      .rpc();
    console.log(`refroze ${tokenAccount}  sig ${sig}`);
  },

  history: async ([mintArg]) => {
    const mint = new PublicKey(mintArg);
    const mintInfo = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
    // ConfidentialTransferMint: authority (32), auto-approve (1), auditor key (32)
    const config = getExtensionData(ExtensionType.ConfidentialTransferMint, mintInfo.tlvData);
    const auditor = config?.subarray(33, 33 + ELGAMAL_PUBKEY_LEN);

    // Deposit, Withdraw and Transfer all name the mint, so its signature
    // history is the complete confidential history. Newest first, paged.
    const signatures = [];
    for (let before; ; ) {
      const page = await connection.getSignaturesForAddress(mint, { before });
      signatures.push(...page.filter((s) => !s.err).map((s) => s.signature));
      if (page.length === 0) break;
      before = page[page.length - 1].signature;
    }

    // The holders come out of the same history: any token account of this
    // mint shows up in a transaction's token balances. Public RPC nodes refuse
    // to scan the token program for them.
    const seen = new Map();
    const events = [];
    for (const signature of signatures.reverse()) {
      const tx = await connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) continue;
      const keys = tx.transaction.message.getAccountKeys({
        accountKeysFromLookups: tx.meta.loadedAddresses,
      });
      for (const balance of tx.meta.postTokenBalances ?? []) {
        if (balance.mint !== mint.toBase58()) continue;
        const address = keys.get(balance.accountIndex);
        seen.set(address.toBase58(), address);
      }
      for (const ix of tokenInstructions(tx)) {
        const event = confidentialEvent(ix, mint);
        if (event) events.push({ signature, ...event });
      }
    }

    const addresses = [...seen.values()];
    const infos = await connection.getMultipleAccountsInfo(addresses);
    const accounts = addresses.flatMap((address, i) => {
      if (!infos[i]) return []; // closed since
      const { owner, amount } = unpackAccount(address, infos[i], TOKEN_2022_PROGRAM_ID);
      return [
        {
          address: address.toBase58(),
          owner: owner.toBase58(),
          publicBalance: amount.toString(),
        },
      ];
    });

    console.log(
      JSON.stringify({
        mint: mint.toBase58(),
        decimals: mintInfo.decimals,
        auditor: auditor?.some(Boolean) ? Buffer.from(auditor).toString("base64") : null,
        accounts,
        events,
      })
    );
  },
};

const [command, ...args] = process.argv.slice(2);
if (!commands[command]) {
  console.error(`usage: vellum.js <${Object.keys(commands).join("|")}> [args]`);
  process.exit(1);
}
commands[command](args).catch((err) => {
  // Surface the program's own error name so callers can assert on it.
  const code = err.error?.errorCode?.code;
  const logs = (err.logs ?? err.transactionLogs ?? []).join("\n");
  console.error(`error: ${code ?? err.message}`);
  if (!code && logs) console.error(logs);
  process.exit(1);
});
