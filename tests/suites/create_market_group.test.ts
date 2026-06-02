// create_market_group covers:
//   1. happy path — Manual YesNo market with valid timestamps
//   2. bond transfer assertion (creator -> bond_vault for BOND_AMOUNT)
//   3. market_count increment
//   4. LockTimestampNotReached (lock_timestamp in the past)
//   5. ResolveDeadlineNotPassed (resolve_deadline <= lock_timestamp)
//   6. InvalidResolvedValueType (question > 256 chars)
//   7. OutcomeIndexOutOfRange (outcome_labels.len() > 4)
//   8. OracleTypeNotSupported (Pyth oracle without pyth_feed)
//   9. InvalidMint (creator_token_account.mint != accepted_mint)
//  10. state-unchanged: market_count is unchanged after the failed batch

import { expect } from "chai";
import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { setupGlobal, GlobalFixtures } from "../fixtures/global";
import {
  deriveMarketGroupPda,
  deriveBondPda,
  deriveBondVaultPda,
  deriveBondVaultAuthorityPda,
} from "../helpers/pda";
import { createMint, createTokenAccount } from "../helpers/token";
import { BOND_AMOUNT } from "../helpers/types";

// Anchor enum literals — variant name in camelCase, empty object as payload
const YESNO = { yesNo: {} };
const MULTI = { multiOutcome: {} };
const CAT_OTHER = { other: {} };
const ORACLE_MANUAL = { manual: {} };
const ORACLE_PYTH = { pyth: {} };

interface DerivedParams {
  groupIndex: anchor.BN;
  marketGroupPda: PublicKey;
  bondPda: PublicKey;
  bondVaultPda: PublicKey;
  bondVaultAuthorityPda: PublicKey;
  lockTimestamp: anchor.BN;
  resolveDeadline: anchor.BN;
}

describe("create_market_group", () => {
  let g: GlobalFixtures;
  let creator: Keypair;
  let creatorTokenAccount: PublicKey;

  before(async () => {
    g = await setupGlobal();
    creator = g.payer;
    creatorTokenAccount = g.creatorUsdcAccount;
  });

  // Fetches current market_count and derives every dependent PDA on top of it
  async function nextParams(): Promise<DerivedParams> {
    const cm = await g.program.account.cyperMarket.fetch(g.cyperMarketPda);
    const groupIndex = cm.marketCount;
    const marketGroupPda = deriveMarketGroupPda(
      g.program.programId,
      g.cyperMarketPda,
      BigInt(groupIndex.toString())
    );
    const bondPda = deriveBondPda(g.program.programId, marketGroupPda);
    const bondVaultPda = deriveBondVaultPda(g.program.programId, bondPda);
    const bondVaultAuthorityPda = deriveBondVaultAuthorityPda(
      g.program.programId,
      bondPda
    );
    const now = Math.floor(Date.now() / 1000);
    return {
      groupIndex,
      marketGroupPda,
      bondPda,
      bondVaultPda,
      bondVaultAuthorityPda,
      lockTimestamp: new anchor.BN(now + 300),
      resolveDeadline: new anchor.BN(now + 300 + 3600),
    };
  }

  function accountsFor(p: DerivedParams, overrides: Record<string, PublicKey> = {}) {
    return {
      cypherMarket: g.cyperMarketPda,
      marketGroup: p.marketGroupPda,
      bond: p.bondPda,
      bondVault: p.bondVaultPda,
      bondVaultAuthority: p.bondVaultAuthorityPda,
      creatorTokenAccount,
      acceptedMint: g.usdcMint,
      creator: creator.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      ...overrides,
    };
  }

  // ── Happy path ────────────────────────────────────────────────────────────

  it("creates a YesNo market group, locks the bond, and increments market_count", async () => {
    const p = await nextParams();
    const cmBefore = await g.program.account.cyperMarket.fetch(g.cyperMarketPda);
    const creatorBefore = await g.provider.connection.getTokenAccountBalance(
      creatorTokenAccount
    );

    const question = "Will SOL hit $300 by year end?";

    const sig = await g.program.methods
      .createMarketGroup(
        YESNO,
        CAT_OTHER,
        ORACLE_MANUAL,
        creator.publicKey,
        null,
        null,
        question,
        [],
        p.lockTimestamp,
        p.resolveDeadline
      )
      .accountsPartial(accountsFor(p))
      .rpc({ commitment: "confirmed" });
    console.log("CreateMarketGroup tx:", sig);

    const mg = await g.program.account.marketGroup.fetch(p.marketGroupPda);
    expect(mg.creator.toBase58()).to.equal(creator.publicKey.toBase58());
    expect(mg.config.toBase58()).to.equal(g.cyperMarketPda.toBase58());
    expect(mg.groupIndex.toString()).to.equal(p.groupIndex.toString());
    expect(mg.question).to.equal(question);
    expect(mg.outcomeLabels).to.deep.equal([]);
    expect(mg.lockTimestamp.toString()).to.equal(p.lockTimestamp.toString());
    expect(mg.resolveDeadline.toString()).to.equal(p.resolveDeadline.toString());
    expect(mg.resolvedAt).to.be.null;
    expect(mg.resolvedValue).to.be.null;
    expect(mg.disputeDeadline).to.be.null;
    expect(mg.marketType).to.have.property("yesNo");
    expect(mg.category).to.have.property("other");
    expect(mg.oracleType).to.have.property("manual");
    expect(mg.status).to.have.property("open");
    expect(mg.oracleAuthority.toBase58()).to.equal(creator.publicKey.toBase58());

    const bond = await g.program.account.bond.fetch(p.bondPda);
    expect(bond.group.toBase58()).to.equal(p.marketGroupPda.toBase58());
    expect(bond.creator.toBase58()).to.equal(creator.publicKey.toBase58());
    expect(bond.amount.toNumber()).to.equal(BOND_AMOUNT);
    expect(bond.vault.toBase58()).to.equal(p.bondVaultPda.toBase58());
    expect(bond.status).to.have.property("locked");

    const cmAfter = await g.program.account.cyperMarket.fetch(g.cyperMarketPda);
    expect(cmAfter.marketCount.toNumber()).to.equal(
      cmBefore.marketCount.toNumber() + 1
    );

    const vaultBal = await g.provider.connection.getTokenAccountBalance(
      p.bondVaultPda
    );
    expect(vaultBal.value.amount).to.equal(BOND_AMOUNT.toString());

    const creatorAfter = await g.provider.connection.getTokenAccountBalance(
      creatorTokenAccount
    );
    expect(
      Number(creatorBefore.value.amount) - Number(creatorAfter.value.amount)
    ).to.equal(BOND_AMOUNT);
  });

  // ── Validation error paths ───────────────────────────────────────────────

  it("rejects when lock_timestamp is in the past (LockTimestampNotReached)", async () => {
    const p = await nextParams();
    const past = new anchor.BN(Math.floor(Date.now() / 1000) - 1000);

    let succeeded = false;
    try {
      await g.program.methods
        .createMarketGroup(
          YESNO,
          CAT_OTHER,
          ORACLE_MANUAL,
          creator.publicKey,
          null,
          null,
          "Q?",
          [],
          past,
          p.resolveDeadline
        )
        .accountsPartial(accountsFor(p))
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      succeeded = true;
    } catch (e) {
      if (e instanceof AnchorError) {
        expect(e.error.errorCode.code).to.equal("LockTimestampNotReached");
      }
    }
    expect(succeeded, "past lock_timestamp should be rejected").to.be.false;
  });

  it("rejects when resolve_deadline <= lock_timestamp (ResolveDeadlineNotPassed)", async () => {
    const p = await nextParams();
    const badDeadline = new anchor.BN(p.lockTimestamp.toNumber() - 1);

    let succeeded = false;
    try {
      await g.program.methods
        .createMarketGroup(
          YESNO,
          CAT_OTHER,
          ORACLE_MANUAL,
          creator.publicKey,
          null,
          null,
          "Q?",
          [],
          p.lockTimestamp,
          badDeadline
        )
        .accountsPartial(accountsFor(p))
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      succeeded = true;
    } catch (e) {
      if (e instanceof AnchorError) {
        expect(e.error.errorCode.code).to.equal("ResolveDeadlineNotPassed");
      }
    }
    expect(
      succeeded,
      "resolve_deadline <= lock_timestamp should be rejected"
    ).to.be.false;
  });

  it("rejects when question > 256 chars (InvalidResolvedValueType)", async () => {
    const p = await nextParams();
    const longQuestion = "x".repeat(257);

    let succeeded = false;
    try {
      await g.program.methods
        .createMarketGroup(
          YESNO,
          CAT_OTHER,
          ORACLE_MANUAL,
          creator.publicKey,
          null,
          null,
          longQuestion,
          [],
          p.lockTimestamp,
          p.resolveDeadline
        )
        .accountsPartial(accountsFor(p))
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      succeeded = true;
    } catch (e) {
      if (e instanceof AnchorError) {
        expect(e.error.errorCode.code).to.equal("InvalidResolvedValueType");
      }
    }
    expect(succeeded, "question > 256 chars should be rejected").to.be.false;
  });

  it("rejects when outcome_labels.len() > 4 (OutcomeIndexOutOfRange)", async () => {
    const p = await nextParams();
    const labels = ["A", "B", "C", "D", "E"];

    let succeeded = false;
    try {
      await g.program.methods
        .createMarketGroup(
          MULTI,
          CAT_OTHER,
          ORACLE_MANUAL,
          creator.publicKey,
          null,
          null,
          "Pick one",
          labels,
          p.lockTimestamp,
          p.resolveDeadline
        )
        .accountsPartial(accountsFor(p))
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      succeeded = true;
    } catch (e) {
      if (e instanceof AnchorError) {
        expect(e.error.errorCode.code).to.equal("OutcomeIndexOutOfRange");
      }
    }
    expect(succeeded, "5+ outcome_labels should be rejected").to.be.false;
  });

  it("rejects Pyth oracle without pyth_feed (OracleTypeNotSupported)", async () => {
    const p = await nextParams();

    let succeeded = false;
    try {
      await g.program.methods
        .createMarketGroup(
          YESNO,
          CAT_OTHER,
          ORACLE_PYTH,
          creator.publicKey,
          null, // pyth_feed missing
          null,
          "Q?",
          [],
          p.lockTimestamp,
          p.resolveDeadline
        )
        .accountsPartial(accountsFor(p))
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      succeeded = true;
    } catch (e) {
      if (e instanceof AnchorError) {
        expect(e.error.errorCode.code).to.equal("OracleTypeNotSupported");
      }
    }
    expect(
      succeeded,
      "Pyth oracle without pyth_feed should be rejected"
    ).to.be.false;
  });

  it("rejects when creator_token_account uses a different mint (InvalidMint)", async () => {
    const p = await nextParams();
    const foreignMint = await createMint(
      g.provider.connection,
      g.payer,
      g.payer.publicKey
    );
    const foreignTokenAccount = await createTokenAccount(
      g.provider.connection,
      g.payer,
      foreignMint,
      creator.publicKey
    );

    let succeeded = false;
    try {
      await g.program.methods
        .createMarketGroup(
          YESNO,
          CAT_OTHER,
          ORACLE_MANUAL,
          creator.publicKey,
          null,
          null,
          "Q?",
          [],
          p.lockTimestamp,
          p.resolveDeadline
        )
        .accountsPartial(
          accountsFor(p, { creatorTokenAccount: foreignTokenAccount })
        )
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      succeeded = true;
    } catch (e) {
      if (e instanceof AnchorError) {
        expect(e.error.errorCode.code).to.equal("InvalidMint");
      }
    }
    expect(
      succeeded,
      "creator token account with wrong mint should be rejected"
    ).to.be.false;
  });

  // ── State-unchanged check ────────────────────────────────────────────────

  it("market_count is unchanged after the failed-call batch", async () => {
    // 6 failed calls above should have left market_count at exactly 1
    // (incremented once by the single happy-path test)
    const cm = await g.program.account.cyperMarket.fetch(g.cyperMarketPda);
    expect(cm.marketCount.toNumber()).to.equal(1);
  });
});
