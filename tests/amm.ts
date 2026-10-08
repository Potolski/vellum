import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  addExtraAccountMetasForExecute,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createInitializeTransferHookInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
  getMintLen,
} from "@solana/spl-token";
import { assert } from "chai";
import { Vellum } from "../target/types/vellum";
import { VellumAmm } from "../target/types/vellum_amm";

const KYC = 1 << 0;
const VENUE = 1 << 2;
const REQUIRE_SENDER_KYC = 1 << 0;
const REQUIRE_RECEIVER_KYC = 1 << 1;
const ALLOW_VENUES = 1 << 2;
const FLAGS = REQUIRE_SENDER_KYC | REQUIRE_RECEIVER_KYC | ALLOW_VENUES;
const NO_BLOCKED = new Array(8).fill(0);

const DECIMALS = 6;
const UNIT = 10 ** DECIMALS;

describe("vellum_amm (composability shim)", () => {
  const envProvider = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(
    new anchor.web3.Connection(envProvider.connection.rpcEndpoint, "confirmed"),
    envProvider.wallet,
    { commitment: "confirmed", preflightCommitment: "confirmed" }
  );
  anchor.setProvider(provider);
  const connection = provider.connection;
  const gl = anchor.workspace.vellum as Program<Vellum>;
  const amm = anchor.workspace.vellumAmm as Program<VellumAmm>;
  const payer = provider.wallet as anchor.Wallet;

  // Separate registry namespace from the core test file (fresh authority).
  const attestor = Keypair.generate();
  const alice = Keypair.generate(); // KYC'd trader + LP
  const bob = Keypair.generate(); // unattested trader
  const eqMint = Keypair.generate(); // hooked "equity" token
  const usdMint = Keypair.generate(); // plain Token-2022 quote token

  const [registry] = PublicKey.findProgramAddressSync(
    [Buffer.from("registry"), attestor.publicKey.toBuffer()],
    gl.programId
  );
  const attestationOf = (subject: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("attest"), registry.toBuffer(), subject.toBuffer()],
      gl.programId
    )[0];
  const [policy] = PublicKey.findProgramAddressSync(
    [Buffer.from("policy"), eqMint.publicKey.toBuffer()],
    gl.programId
  );
  const [extraAccountMetaList] = PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), eqMint.publicKey.toBuffer()],
    gl.programId
  );
  const [pool] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), eqMint.publicKey.toBuffer(), usdMint.publicKey.toBuffer()],
    amm.programId
  );
  const [poolAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool-authority"), pool.toBuffer()],
    amm.programId
  );

  const ata = (mint: PublicKey, owner: PublicKey) =>
    getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
  const vaultEq = () => ata(eqMint.publicKey, poolAuthority);
  const vaultUsd = () => ata(usdMint.publicKey, poolAuthority);

  /** Resolve the hook's extra accounts for one EQ transfer leg. */
  const hookExtras = async (source: PublicKey, dest: PublicKey, owner: PublicKey) => {
    // The helper requires the transfer's base accounts to be present in the
    // instruction; seed them, then slice them off and keep only the extras.
    const probe = new TransactionInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      keys: [
        { pubkey: source, isSigner: false, isWritable: false },
        { pubkey: eqMint.publicKey, isSigner: false, isWritable: false },
        { pubkey: dest, isSigner: false, isWritable: false },
        { pubkey: owner, isSigner: false, isWritable: false },
      ],
    });
    await addExtraAccountMetasForExecute(
      connection,
      probe,
      gl.programId,
      source,
      eqMint.publicKey,
      dest,
      owner,
      BigInt(0),
      "confirmed"
    );
    // Anchor forbids extra signer metas in remaining accounts; extras are
    // read-only for the hook anyway.
    return probe.keys.slice(4).map((k) => ({ ...k, isSigner: false }));
  };

  const createMint = async (mint: Keypair, withHook: boolean) => {
    const extensions = withHook ? [ExtensionType.TransferHook] : [];
    const mintLen = getMintLen(extensions);
    const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mint.publicKey,
        space: mintLen,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      })
    );
    if (withHook) {
      tx.add(
        createInitializeTransferHookInstruction(
          mint.publicKey,
          payer.publicKey,
          gl.programId,
          TOKEN_2022_PROGRAM_ID
        )
      );
    }
    tx.add(
      createInitializeMintInstruction(
        mint.publicKey,
        DECIMALS,
        payer.publicKey,
        null,
        TOKEN_2022_PROGRAM_ID
      )
    );
    await provider.sendAndConfirm(tx, [mint]);
  };

  before("fund and set up compliance state", async () => {
    for (const kp of [attestor, alice, bob]) {
      const sig = await connection.requestAirdrop(kp.publicKey, 2_000_000_000);
      await connection.confirmTransaction(sig);
    }
    await gl.methods
      .initRegistry(attestor.publicKey)
      .accountsPartial({
        authority: attestor.publicKey,
        registry,
        systemProgram: SystemProgram.programId,
      })
      .signers([attestor])
      .rpc();
    for (const [subject, claims] of [
      [alice.publicKey, KYC],
      [poolAuthority, VENUE],
    ] as [PublicKey, number][]) {
      await gl.methods
        .attest(subject, claims, 0, new BN(0))
        .accountsPartial({
          attestor: attestor.publicKey,
          registry,
          attestation: attestationOf(subject),
          systemProgram: SystemProgram.programId,
        })
        .signers([attestor])
        .rpc();
    }
  });

  it("sets up hooked equity mint, quote mint, and the pool", async () => {
    await createMint(eqMint, true);
    await createMint(usdMint, false);
    await gl.methods
      .initPolicy(FLAGS, NO_BLOCKED)
      .accountsPartial({
        issuer: payer.publicKey,
        mint: eqMint.publicKey,
        registry,
        policy,
        extraAccountMetaList,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // ATAs: vaults (owned by the pool authority PDA) + traders, then seed balances.
    const tx = new Transaction();
    const atas: [PublicKey, PublicKey][] = [
      [eqMint.publicKey, poolAuthority],
      [usdMint.publicKey, poolAuthority],
      [eqMint.publicKey, alice.publicKey],
      [usdMint.publicKey, alice.publicKey],
      [eqMint.publicKey, bob.publicKey],
      [usdMint.publicKey, bob.publicKey],
    ];
    for (const [mint, owner] of atas) {
      tx.add(
        createAssociatedTokenAccountInstruction(
          payer.publicKey,
          ata(mint, owner),
          owner,
          mint,
          TOKEN_2022_PROGRAM_ID
        )
      );
    }
    tx.add(
      createMintToInstruction(
        eqMint.publicKey,
        ata(eqMint.publicKey, alice.publicKey),
        payer.publicKey,
        BigInt(2000 * UNIT),
        [],
        TOKEN_2022_PROGRAM_ID
      ),
      createMintToInstruction(
        usdMint.publicKey,
        ata(usdMint.publicKey, alice.publicKey),
        payer.publicKey,
        BigInt(20000 * UNIT),
        [],
        TOKEN_2022_PROGRAM_ID
      ),
      createMintToInstruction(
        usdMint.publicKey,
        ata(usdMint.publicKey, bob.publicKey),
        payer.publicKey,
        BigInt(1000 * UNIT),
        [],
        TOKEN_2022_PROGRAM_ID
      )
    );
    await provider.sendAndConfirm(tx);

    await amm.methods
      .initPool()
      .accountsPartial({
        payer: payer.publicKey,
        mintA: eqMint.publicKey,
        mintB: usdMint.publicKey,
        pool,
        poolAuthority,
        vaultA: vaultEq(),
        vaultB: vaultUsd(),
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  });

  it("KYC'd LP deposits hooked tokens into the pool (venue receives fine)", async () => {
    const extras = await hookExtras(
      ata(eqMint.publicKey, alice.publicKey),
      vaultEq(),
      alice.publicKey
    );
    await amm.methods
      .addLiquidity(new BN(1000 * UNIT), new BN(10000 * UNIT))
      .accountsPartial({
        user: alice.publicKey,
        pool,
        mintA: eqMint.publicKey,
        mintB: usdMint.publicKey,
        userAtaA: ata(eqMint.publicKey, alice.publicKey),
        userAtaB: ata(usdMint.publicKey, alice.publicKey),
        vaultA: vaultEq(),
        vaultB: vaultUsd(),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .remainingAccounts(extras)
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .signers([alice])
      .rpc();
    const v = await getAccount(connection, vaultEq(), "confirmed", TOKEN_2022_PROGRAM_ID);
    assert.equal(v.amount, BigInt(1000 * UNIT));
  });

  it("KYC'd trader swaps quote → hooked equity through the pool", async () => {
    const aliceEqBefore = (
      await getAccount(connection, ata(eqMint.publicKey, alice.publicKey), "confirmed", TOKEN_2022_PROGRAM_ID)
    ).amount;
    // Out-leg extras: vault -> alice, signed by the pool authority (VENUE).
    const extras = await hookExtras(
      vaultEq(),
      ata(eqMint.publicKey, alice.publicKey),
      poolAuthority
    );
    await amm.methods
      .swap(new BN(100 * UNIT), new BN(1))
      .accountsPartial({
        user: alice.publicKey,
        pool,
        poolAuthority,
        mintIn: usdMint.publicKey,
        mintOut: eqMint.publicKey,
        userAtaIn: ata(usdMint.publicKey, alice.publicKey),
        userAtaOut: ata(eqMint.publicKey, alice.publicKey),
        vaultIn: vaultUsd(),
        vaultOut: vaultEq(),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .remainingAccounts(extras)
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .signers([alice])
      .rpc();
    const aliceEqAfter = (
      await getAccount(connection, ata(eqMint.publicKey, alice.publicKey), "confirmed", TOKEN_2022_PROGRAM_ID)
    ).amount;
    assert.isTrue(aliceEqAfter > aliceEqBefore, "alice should receive equity tokens");
  });

  it("unattested trader's identical swap is rejected inside the token program", async () => {
    const extras = await hookExtras(
      vaultEq(),
      ata(eqMint.publicKey, bob.publicKey),
      poolAuthority
    );
    try {
      await amm.methods
        .swap(new BN(100 * UNIT), new BN(1))
        .accountsPartial({
          user: bob.publicKey,
          pool,
          poolAuthority,
          mintIn: usdMint.publicKey,
          mintOut: eqMint.publicKey,
          userAtaIn: ata(usdMint.publicKey, bob.publicKey),
          userAtaOut: ata(eqMint.publicKey, bob.publicKey),
          vaultIn: vaultUsd(),
          vaultOut: vaultEq(),
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .remainingAccounts(extras)
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
        .signers([bob])
        .rpc();
      assert.fail("bob's swap should have been rejected by the hook");
    } catch (err: any) {
      assert.include(
        err.toString() + JSON.stringify(err.logs ?? []),
        "ReceiverNotAttested",
        `expected hook rejection, got: ${err}`
      );
    }
    // Pool and bob's balances are untouched — the whole swap atomically reverted.
    const bobEq = await getAccount(
      connection,
      ata(eqMint.publicKey, bob.publicKey),
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );
    assert.equal(bobEq.amount, BigInt(0));
  });
});
