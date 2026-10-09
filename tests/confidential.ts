import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  AccountState,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TokenInstruction,
  createAssociatedTokenAccountInstruction,
  createInitializeDefaultAccountStateInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
  getMintLen,
} from "@solana/spl-token";
import { assert } from "chai";
import { Vellum } from "../target/types/vellum";

// Claims and policy flags (mirror of state.rs)
const KYC = 1 << 0;
const ACCREDITED = 1 << 1;
const VENUE = 1 << 2;
const REQUIRE_SENDER_KYC = 1 << 0;
const REQUIRE_RECEIVER_KYC = 1 << 1;
const ALLOW_VENUES = 1 << 2;
const REQUIRE_RECEIVER_ACCREDITED = 1 << 3;
const CONFIDENTIAL = 1 << 4;

const US = 840;
const KP = 408; // sanctioned jurisdiction for the demo blocklist

const DECIMALS = 2;

// Mode B: the account gate on a confidential mint. This file covers who may be
// thawed, approved and re-frozen. The encrypted transfers themselves need ZK
// proofs no JS client can generate; scripts/confidential-e2e.sh runs those
// against the same gate.
describe("vellum confidential (account gate)", () => {
  const envProvider = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(
    new anchor.web3.Connection(envProvider.connection.rpcEndpoint, "confirmed"),
    envProvider.wallet,
    { commitment: "confirmed", preflightCommitment: "confirmed" }
  );
  anchor.setProvider(provider);
  const connection = provider.connection;
  const program = anchor.workspace.vellum as Program<Vellum>;
  const issuer = provider.wallet as anchor.Wallet;

  // Separate registry namespace from the other test files (fresh authority).
  const attestor = Keypair.generate();

  // Actors
  const alice = Keypair.generate(); // KYC, US
  const bob = Keypair.generate(); // KYC, US, later revoked
  const erin = Keypair.generate(); // KYC, US, attestation already expired
  const karim = Keypair.generate(); // KYC, blocked jurisdiction
  const carol = Keypair.generate(); // unattested
  const mint = Keypair.generate();

  const [registry] = PublicKey.findProgramAddressSync(
    [Buffer.from("registry"), attestor.publicKey.toBuffer()],
    program.programId
  );
  const attestationOf = (subject: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("attest"), registry.toBuffer(), subject.toBuffer()],
      program.programId
    )[0];
  const policyOf = (m: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), m.toBuffer()],
      program.programId
    )[0];
  const policy = policyOf(mint.publicKey);

  const ataOf = (owner: PublicKey) =>
    getAssociatedTokenAddressSync(mint.publicKey, owner, false, TOKEN_2022_PROGRAM_ID);

  const blocked = (...codes: number[]): number[] => {
    const arr = new Array(8).fill(0);
    codes.forEach((c, i) => (arr[i] = c));
    return arr;
  };
  const FLAGS = REQUIRE_SENDER_KYC | REQUIRE_RECEIVER_KYC;
  const BLOCKED = blocked(KP);

  const attest = (subject: PublicKey, jurisdiction: number, expiresAt = 0, claims = KYC) =>
    program.methods
      .attest(subject, claims, jurisdiction, new BN(expiresAt))
      .accountsPartial({
        attestor: attestor.publicKey,
        registry,
        attestation: attestationOf(subject),
        systemProgram: SystemProgram.programId,
      })
      .signers([attestor])
      .rpc();

  const revoke = (subject: PublicKey) =>
    program.methods
      .revoke(subject)
      .accountsPartial({
        attestor: attestor.publicKey,
        registry,
        attestation: attestationOf(subject),
      })
      .signers([attestor])
      .rpc();

  /** Accounts for the gate instructions; `attestation` is overridable so a
   *  test can try to substitute someone else's. */
  const gate = (owner: PublicKey, attestation = attestationOf(owner)) => ({
    cranker: issuer.publicKey,
    mint: mint.publicKey,
    tokenAccount: ataOf(owner),
    policy,
    attestation,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
  });
  const thaw = (owner: PublicKey) =>
    program.methods.thawIfAttested().accountsPartial(gate(owner)).rpc();
  const refreeze = (owner: PublicKey) =>
    program.methods.refreezeIfInvalid().accountsPartial(gate(owner)).rpc();
  const setPaused = (paused: boolean) =>
    program.methods
      .updatePolicy(FLAGS, BLOCKED, paused)
      .accountsPartial({ issuer: issuer.publicKey, policy })
      .rpc();

  const isFrozen = async (owner: PublicKey) =>
    (await getAccount(connection, ataOf(owner), "confirmed", TOKEN_2022_PROGRAM_ID))
      .isFrozen;

  const expectError = async (p: Promise<unknown>, errorName: string) => {
    try {
      await p;
    } catch (err: any) {
      const haystack =
        (err.logs ?? err.transactionLogs ?? []).join("\n") + "\n" + err.toString();
      assert.include(haystack, errorName, `expected ${errorName}, got: ${err.message}`);
      return;
    }
    assert.fail(`expected transaction to fail with ${errorName}`);
  };

  // Stands in for the issuer's ElGamal auditor key. Token-2022 stores the 32
  // bytes as given, and nothing here decrypts with it; the e2e script uses a
  // real one.
  const AUDITOR_KEY = Keypair.generate().publicKey.toBuffer();
  const NO_AUDITOR = Buffer.alloc(32);

  /** `ConfidentialTransferInstruction::InitializeMint`. spl-token 0.4 ships the
   *  extension's layout but no instruction builders, so it is encoded by hand:
   *  authority, auto_approve_new_accounts, auditor ElGamal pubkey. */
  const initializeConfidentialMintIx = (
    m: PublicKey,
    authority: PublicKey,
    auditor: Buffer,
    autoApprove: boolean
  ) =>
    new TransactionInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      keys: [{ pubkey: m, isSigner: false, isWritable: true }],
      data: Buffer.concat([
        Buffer.from([TokenInstruction.ConfidentialTransferExtension, 0]),
        authority.toBuffer(),
        Buffer.from([autoApprove ? 1 : 0]),
        auditor,
      ]),
    });

  /** A mint as an issuer would configure it for Mode B: both authorities with
   *  the policy PDA, manual approval, an auditor key. Each test that expects a
   *  refusal overrides the one thing it gets wrong. */
  const createConfidentialMint = async (
    m: Keypair,
    {
      freezeAuthority = policyOf(m.publicKey),
      confidentialAuthority = policyOf(m.publicKey),
      auditor = AUDITOR_KEY,
      autoApprove = false,
    } = {}
  ) => {
    const mintLen = getMintLen([
      ExtensionType.ConfidentialTransferMint,
      ExtensionType.DefaultAccountState,
    ]);
    const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: issuer.publicKey,
        newAccountPubkey: m.publicKey,
        space: mintLen,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      initializeConfidentialMintIx(m.publicKey, confidentialAuthority, auditor, autoApprove),
      createInitializeDefaultAccountStateInstruction(
        m.publicKey,
        AccountState.Frozen,
        TOKEN_2022_PROGRAM_ID
      ),
      createInitializeMintInstruction(
        m.publicKey,
        DECIMALS,
        issuer.publicKey,
        freezeAuthority,
        TOKEN_2022_PROGRAM_ID
      )
    );
    await provider.sendAndConfirm(tx, [m]);
  };

  before("fund the attestor and issue attestations", async () => {
    const sig = await connection.requestAirdrop(attestor.publicKey, 2_000_000_000);
    await connection.confirmTransaction(sig);

    await program.methods
      .initRegistry(attestor.publicKey)
      .accountsPartial({
        authority: attestor.publicKey,
        registry,
        systemProgram: SystemProgram.programId,
      })
      .signers([attestor])
      .rpc();

    await attest(alice.publicKey, US);
    await attest(bob.publicKey, US);
    await attest(erin.publicKey, US, 1); // expired in 1970
    await attest(karim.publicKey, KP);
  });

  const initPolicy = (m: PublicKey, policyFlags = FLAGS) =>
    program.methods
      .initConfidentialPolicy(policyFlags, BLOCKED)
      .accountsPartial({
        issuer: issuer.publicKey,
        mint: m,
        registry,
        policy: policyOf(m),
        systemProgram: SystemProgram.programId,
      })
      .rpc();

  it("refuses a policy when the mint's freeze authority is not the policy PDA", async () => {
    const decorative = Keypair.generate();
    await createConfidentialMint(decorative, { freezeAuthority: issuer.publicKey });
    await expectError(initPolicy(decorative.publicKey), "PolicyNotFreezeAuthority");
  });

  it("refuses a policy when the issuer keeps the confidential transfer authority", async () => {
    const swappable = Keypair.generate();
    await createConfidentialMint(swappable, { confidentialAuthority: issuer.publicKey });
    await expectError(initPolicy(swappable.publicKey), "PolicyNotConfidentialAuthority");
  });

  it("refuses a policy when the mint auto-approves confidential accounts", async () => {
    const open = Keypair.generate();
    await createConfidentialMint(open, { autoApprove: true });
    await expectError(initPolicy(open.publicKey), "ConfidentialAutoApprove");
  });

  it("refuses a policy when the mint has no auditor key", async () => {
    const dark = Keypair.generate();
    await createConfidentialMint(dark, { auditor: NO_AUDITOR });
    await expectError(initPolicy(dark.publicKey), "AuditorKeyRequired");
  });

  it("onboards a confidential mint the policy PDA fully controls", async () => {
    await createConfidentialMint(mint);
    await initPolicy(mint.publicKey);

    const p = await program.account.policy.fetch(policy);
    assert.equal(p.flags, FLAGS | CONFIDENTIAL);
  });

  it("token accounts are born frozen", async () => {
    const tx = new Transaction();
    for (const owner of [alice, bob, erin, karim, carol].map((k) => k.publicKey)) {
      tx.add(
        createAssociatedTokenAccountInstruction(
          issuer.publicKey,
          ataOf(owner),
          owner,
          mint.publicKey,
          TOKEN_2022_PROGRAM_ID
        )
      );
    }
    await provider.sendAndConfirm(tx);
    for (const owner of [alice, carol]) {
      assert.isTrue(await isFrozen(owner.publicKey));
    }
  });

  it("thaws an attested holder", async () => {
    await thaw(alice.publicKey);
    await thaw(bob.publicKey);
    assert.isFalse(await isFrozen(alice.publicKey));
  });

  it("refuses to thaw an unattested holder", async () => {
    await expectError(thaw(carol.publicKey), "HolderNotAttested");
    assert.isTrue(await isFrozen(carol.publicKey));
  });

  it("refuses to thaw a holder whose attestation has expired", async () => {
    await expectError(thaw(erin.publicKey), "HolderNotAttested");
  });

  it("refuses to thaw a holder in a blocked jurisdiction", async () => {
    await expectError(thaw(karim.publicKey), "JurisdictionBlocked");
  });

  it("refuses to approve an unattested holder for confidential balances", async () => {
    await expectError(
      program.methods
        .approveConfidentialAccount()
        .accountsPartial(gate(carol.publicKey))
        .rpc(),
      "HolderNotAttested"
    );
  });

  it("cannot re-freeze a holder who is still eligible", async () => {
    await expectError(refreeze(alice.publicKey), "HolderStillEligible");
    assert.isFalse(await isFrozen(alice.publicKey));
  });

  it("cannot grief-freeze a valid holder by substituting another attestation account", async () => {
    // Carol has no attestation, so her (empty) PDA would read as "unattested".
    await expectError(
      program.methods
        .refreezeIfInvalid()
        .accountsPartial(gate(alice.publicKey, attestationOf(carol.publicKey)))
        .rpc(),
      "ConstraintSeeds"
    );
    assert.isFalse(await isFrozen(alice.publicKey));
  });

  it("revocation freezes the position without seizing it; re-attestation restores it", async () => {
    await provider.sendAndConfirm(
      new Transaction().add(
        createMintToInstruction(
          mint.publicKey,
          ataOf(bob.publicKey),
          issuer.publicKey,
          500,
          [],
          TOKEN_2022_PROGRAM_ID
        )
      )
    );

    await revoke(bob.publicKey);
    await refreeze(bob.publicKey);
    const frozen = await getAccount(
      connection,
      ataOf(bob.publicKey),
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );
    assert.isTrue(frozen.isFrozen);
    assert.equal(frozen.amount, BigInt(500));

    await expectError(thaw(bob.publicKey), "HolderNotAttested");
    await attest(bob.publicKey, US);
    await thaw(bob.publicKey);
    assert.isFalse(await isFrozen(bob.publicKey));
  });

  it("pause blocks thawing and lets anyone freeze; unpause restores", async () => {
    await setPaused(true);
    await expectError(thaw(bob.publicKey), "TransfersPaused");
    await refreeze(alice.publicKey);
    assert.isTrue(await isFrozen(alice.publicKey));

    await setPaused(false);
    await thaw(alice.publicKey);
    assert.isFalse(await isFrozen(alice.publicKey));
  });

  it("a policy update cannot clear the confidential flag", async () => {
    // setPaused passed flags without CONFIDENTIAL, twice.
    const p = await program.account.policy.fetch(policy);
    assert.equal(p.flags, FLAGS | CONFIDENTIAL);
  });

  // A second mint with a stricter policy. In Mode B one account both sends and
  // receives, so the receiver-side rules apply to anyone who holds at all.
  describe("accredited-only mint that admits venues", () => {
    const restricted = Keypair.generate();
    const dana = Keypair.generate(); // KYC + ACCREDITED
    const pool = Keypair.generate(); // VENUE only: an AMM or lending vault

    const accountOf = (owner: PublicKey) =>
      getAssociatedTokenAddressSync(restricted.publicKey, owner, false, TOKEN_2022_PROGRAM_ID);
    const thawRestricted = (owner: PublicKey) =>
      program.methods
        .thawIfAttested()
        .accountsPartial({
          ...gate(owner),
          mint: restricted.publicKey,
          tokenAccount: accountOf(owner),
          policy: policyOf(restricted.publicKey),
        })
        .rpc();
    const frozen = async (owner: PublicKey) =>
      (await getAccount(connection, accountOf(owner), "confirmed", TOKEN_2022_PROGRAM_ID))
        .isFrozen;

    before("mint, policy, attestations, accounts", async () => {
      await createConfidentialMint(restricted);
      await initPolicy(
        restricted.publicKey,
        FLAGS | REQUIRE_RECEIVER_ACCREDITED | ALLOW_VENUES
      );
      await attest(dana.publicKey, US, 0, KYC | ACCREDITED);
      await attest(pool.publicKey, 0, 0, VENUE);

      const tx = new Transaction();
      for (const owner of [alice, dana, pool].map((k) => k.publicKey)) {
        tx.add(
          createAssociatedTokenAccountInstruction(
            issuer.publicKey,
            accountOf(owner),
            owner,
            restricted.publicKey,
            TOKEN_2022_PROGRAM_ID
          )
        );
      }
      await provider.sendAndConfirm(tx);
    });

    it("refuses to thaw a KYC'd holder who is not accredited", async () => {
      await expectError(thawRestricted(alice.publicKey), "AccreditationRequired");
      assert.isTrue(await frozen(alice.publicKey));
    });

    it("thaws an accredited holder", async () => {
      await thawRestricted(dana.publicKey);
      assert.isFalse(await frozen(dana.publicKey));
    });

    it("thaws a venue without KYC", async () => {
      await thawRestricted(pool.publicKey);
      assert.isFalse(await frozen(pool.publicKey));
    });
  });
});
