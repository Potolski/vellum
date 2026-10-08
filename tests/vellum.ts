import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createInitializeTransferHookInstruction,
  createMintToInstruction,
  createTransferCheckedWithTransferHookInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
  getMintLen,
} from "@solana/spl-token";
import { assert } from "chai";
import { Vellum } from "../target/types/vellum";

// Claims bitmask (mirror of state.rs)
const KYC = 1 << 0;
const ACCREDITED = 1 << 1;
const VENUE = 1 << 2;
// Policy flags
const REQUIRE_SENDER_KYC = 1 << 0;
const REQUIRE_RECEIVER_KYC = 1 << 1;
const ALLOW_VENUES = 1 << 2;

const US = 840;
const DE = 276;
const KP = 408; // sanctioned jurisdiction for the demo blocklist

const DECIMALS = 6;
const UNIT = 10 ** DECIMALS;

describe("vellum", () => {
  // Pin everything to "confirmed": the transfer helper resolves the hook's
  // extra accounts off-chain at "confirmed", so writes must be visible there.
  const envProvider = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(
    new anchor.web3.Connection(envProvider.connection.rpcEndpoint, "confirmed"),
    envProvider.wallet,
    { commitment: "confirmed", preflightCommitment: "confirmed" }
  );
  anchor.setProvider(provider);
  const connection = provider.connection;
  const program = anchor.workspace.vellum as Program<Vellum>;
  const authority = provider.wallet as anchor.Wallet; // registry authority, attestor, issuer

  // Actors
  const alice = Keypair.generate(); // KYC, US
  const dana = Keypair.generate(); // KYC, DE
  const karim = Keypair.generate(); // KYC, blocked jurisdiction
  const bob = Keypair.generate(); // unattested
  const venueAuthority = Keypair.generate(); // VENUE claim, no KYC (simulates AMM pool authority)
  const mint = Keypair.generate();

  // PDAs
  const [registry] = PublicKey.findProgramAddressSync(
    [Buffer.from("registry"), authority.publicKey.toBuffer()],
    program.programId
  );
  const attestationOf = (subject: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("attest"), registry.toBuffer(), subject.toBuffer()],
      program.programId
    )[0];
  const [policy] = PublicKey.findProgramAddressSync(
    [Buffer.from("policy"), mint.publicKey.toBuffer()],
    program.programId
  );
  const [extraAccountMetaList] = PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), mint.publicKey.toBuffer()],
    program.programId
  );

  const ataOf = (owner: PublicKey) =>
    getAssociatedTokenAddressSync(mint.publicKey, owner, false, TOKEN_2022_PROGRAM_ID);

  const blocked = (...codes: number[]): number[] => {
    const arr = new Array(8).fill(0);
    codes.forEach((c, i) => (arr[i] = c));
    return arr;
  };
  const DEFAULT_FLAGS = REQUIRE_SENDER_KYC | REQUIRE_RECEIVER_KYC | ALLOW_VENUES;
  const DEFAULT_BLOCKED = blocked(KP);

  const attest = (subject: PublicKey, claims: number, jurisdiction: number) =>
    program.methods
      .attest(subject, claims, jurisdiction, new BN(0))
      .accountsPartial({
        attestor: authority.publicKey,
        registry,
        attestation: attestationOf(subject),
        systemProgram: SystemProgram.programId,
      })
      .rpc();

  const hookTransfer = async (
    from: Keypair,
    fromOwner: PublicKey,
    toOwner: PublicKey,
    amount: number
  ) => {
    const ix = await createTransferCheckedWithTransferHookInstruction(
      connection,
      ataOf(fromOwner),
      mint.publicKey,
      ataOf(toOwner),
      fromOwner,
      BigInt(amount),
      DECIMALS,
      [],
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );
    return sendAndConfirmTransaction(connection, new Transaction().add(ix), [from], {
      commitment: "confirmed",
    });
  };

  /** Assert a promise rejects with a specific Vellum error surfaced in logs. */
  const expectHookError = async (p: Promise<unknown>, errorName: string) => {
    try {
      await p;
    } catch (err: any) {
      const haystack =
        (err.logs ?? err.transactionLogs ?? []).join("\n") + "\n" + err.message;
      assert.include(
        haystack,
        errorName,
        `expected ${errorName}, got: ${err.message}`
      );
      return;
    }
    assert.fail(`expected transaction to fail with ${errorName}`);
  };

  before("fund actors", async () => {
    for (const kp of [alice, dana, karim, bob]) {
      const sig = await connection.requestAirdrop(kp.publicKey, 2_000_000_000);
      await connection.confirmTransaction(sig);
    }
  });

  it("initializes the attestor registry", async () => {
    await program.methods
      .initRegistry(authority.publicKey)
      .accountsPartial({
        authority: authority.publicKey,
        registry,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    const state = await program.account.registry.fetch(registry);
    assert.ok(state.attestor.equals(authority.publicKey));
  });

  it("issues attestations (KYC wallets + a venue)", async () => {
    await attest(alice.publicKey, KYC, US);
    await attest(dana.publicKey, KYC, DE);
    await attest(karim.publicKey, KYC, KP);
    await attest(venueAuthority.publicKey, VENUE, 0);

    const a = await program.account.attestation.fetch(attestationOf(alice.publicKey));
    assert.equal(a.claims, KYC);
    assert.equal(a.jurisdiction, US);
  });

  it("creates a hooked Token-2022 mint and onboards it with a policy", async () => {
    const mintLen = getMintLen([ExtensionType.TransferHook]);
    const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: authority.publicKey,
        newAccountPubkey: mint.publicKey,
        space: mintLen,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeTransferHookInstruction(
        mint.publicKey,
        authority.publicKey,
        program.programId,
        TOKEN_2022_PROGRAM_ID
      ),
      createInitializeMintInstruction(
        mint.publicKey,
        DECIMALS,
        authority.publicKey,
        null,
        TOKEN_2022_PROGRAM_ID
      )
    );
    await provider.sendAndConfirm(tx, [mint]);

    await program.methods
      .initPolicy(DEFAULT_FLAGS, DEFAULT_BLOCKED)
      .accountsPartial({
        issuer: authority.publicKey,
        mint: mint.publicKey,
        registry,
        policy,
        extraAccountMetaList,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const p = await program.account.policy.fetch(policy);
    assert.equal(p.flags, DEFAULT_FLAGS);
    assert.isFalse(p.paused);

    // ATAs for everyone + initial supply to alice (mint_to does not invoke the hook)
    const ataTx = new Transaction();
    for (const owner of [alice, dana, karim, bob, venueAuthority].map((k) => k.publicKey)) {
      ataTx.add(
        createAssociatedTokenAccountInstruction(
          authority.publicKey,
          ataOf(owner),
          owner,
          mint.publicKey,
          TOKEN_2022_PROGRAM_ID
        )
      );
    }
    ataTx.add(
      createMintToInstruction(
        mint.publicKey,
        ataOf(alice.publicKey),
        authority.publicKey,
        BigInt(1000 * UNIT),
        [],
        TOKEN_2022_PROGRAM_ID
      )
    );
    await provider.sendAndConfirm(ataTx);
  });

  it("allows transfer between two KYC'd wallets", async () => {
    await hookTransfer(alice, alice.publicKey, dana.publicKey, 100 * UNIT);
    const danaAcc = await getAccount(
      connection,
      ataOf(dana.publicKey),
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );
    assert.equal(danaAcc.amount, BigInt(100 * UNIT));
  });

  it("rejects transfer to an unattested wallet", async () => {
    await expectHookError(
      hookTransfer(alice, alice.publicKey, bob.publicKey, 10 * UNIT),
      "ReceiverNotAttested"
    );
  });

  it("rejects transfer to a blocked jurisdiction", async () => {
    await expectHookError(
      hookTransfer(alice, alice.publicKey, karim.publicKey, 10 * UNIT),
      "JurisdictionBlocked"
    );
  });

  it("allows transfer to a VENUE without KYC (DeFi composability)", async () => {
    await hookTransfer(alice, alice.publicKey, venueAuthority.publicKey, 50 * UNIT);
    const venueAcc = await getAccount(
      connection,
      ataOf(venueAuthority.publicKey),
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );
    assert.equal(venueAcc.amount, BigInt(50 * UNIT));
  });

  it("rejects sends from a revoked wallet, and re-attestation restores them", async () => {
    await program.methods
      .revoke(dana.publicKey)
      .accountsPartial({
        attestor: authority.publicKey,
        registry,
        attestation: attestationOf(dana.publicKey),
      })
      .rpc();
    await expectHookError(
      hookTransfer(dana, dana.publicKey, alice.publicKey, 10 * UNIT),
      "SenderNotAttested"
    );
    await attest(dana.publicKey, KYC, DE);
    await hookTransfer(dana, dana.publicKey, alice.publicKey, 10 * UNIT);
  });

  it("pause halts all transfers; unpause restores them", async () => {
    await program.methods
      .updatePolicy(DEFAULT_FLAGS, DEFAULT_BLOCKED, true)
      .accountsPartial({ issuer: authority.publicKey, policy })
      .rpc();
    await expectHookError(
      hookTransfer(alice, alice.publicKey, dana.publicKey, 10 * UNIT),
      "TransfersPaused"
    );
    await program.methods
      .updatePolicy(DEFAULT_FLAGS, DEFAULT_BLOCKED, false)
      .accountsPartial({ issuer: authority.publicKey, policy })
      .rpc();
    await hookTransfer(alice, alice.publicKey, dana.publicKey, 10 * UNIT);
  });

  it("rejects direct hook invocation outside a real transfer", async () => {
    try {
      await program.methods
        .transferHook(new BN(1))
        .accountsPartial({
          sourceToken: ataOf(alice.publicKey),
          mint: mint.publicKey,
          destinationToken: ataOf(dana.publicKey),
          owner: alice.publicKey,
          extraAccountMetaList,
          policy,
          sourceAttestation: attestationOf(alice.publicKey),
          destinationAttestation: attestationOf(dana.publicKey),
        })
        .rpc();
      assert.fail("direct invocation should fail");
    } catch (err: any) {
      assert.include(err.toString(), "NotTransferring");
    }
  });

  it("rejects attestations from a non-attestor", async () => {
    try {
      await program.methods
        .attest(bob.publicKey, KYC, US, new BN(0))
        .accountsPartial({
          attestor: bob.publicKey,
          registry,
          attestation: attestationOf(bob.publicKey),
          systemProgram: SystemProgram.programId,
        })
        .signers([bob])
        .rpc();
      assert.fail("non-attestor should not be able to attest");
    } catch (err: any) {
      assert.include(err.toString(), "UnauthorizedAttestor");
    }
  });
});
