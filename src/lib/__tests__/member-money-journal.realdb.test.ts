/** M1 contracts against the shipped migration and provisioning, never mock SQL. */
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addCalendarDays, clubCalendarDateOf, requireClubTimeZone, requireInstant } from "@/lib/club-time";
import { MEMBER_MONEY_RELATIONS } from "@/lib/member-money-tables";
import { verifyMemberMoneyJournal } from "@/lib/member-money";
import { MEMBER_MONEY_DATABASE_SHAPE } from "@/lib/member-money/internal/database-shape";
import { readMemberMoneyDefinitions } from "@/lib/member-money/internal/verify";
import { FROZEN_TEST_CLOCK_BASE_ISO } from "./helpers/clock";
import {
  createMemberMoneyScratchDatabase,
  MEMBER_MONEY_JOURNAL_MIGRATION as MIGRATION,
  memberMoneyScratchName,
  memberMoneyScratchRoles,
  type MemberMoneyScratchDatabase,
} from "./support/member-money-fixtures";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const url = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const prefix = memberMoneyScratchName("mm4513");
const roles = memberMoneyScratchRoles(prefix);
let scratch: MemberMoneyScratchDatabase | undefined;
let db: Client;
let app: Client;
let sequence = 0;
const next = () => `${prefix}_${++sequence}`;

// All economic instants come from the shared frozen clock, including SQL fixtures,
// and the event's civil date is derived from that instant by the club-time kernel.
const EFFECTIVE_AT = requireInstant(FROZEN_TEST_CLOCK_BASE_ISO);
const EFFECTIVE_DATE = clubCalendarDateOf(EFFECTIVE_AT, requireClubTimeZone("Pacific/Auckland"));
const REVENUE = "BOOKING_REVENUE";

async function event(c: Client, id: string, kind = "RECEIPT", { sourceKind = "OFFICER_FACT", date = EFFECTIVE_DATE as string } = {}) {
  await c.query(`INSERT INTO "MemberMoneyEvent"
    (id,"eventKey",kind,origin,"sourceKind","sourceIdentity","sourceVersion","payloadHash",reason,"effectiveAt","effectiveDate","recordedAt")
    VALUES ($1,$1,$2,'OFFICER',$3,$1,'v1',$4,'test evidence',$5,$6,$5)`,
  [id, kind, sourceKind, "a".repeat(64), EFFECTIVE_AT, date]);
}
async function header(c: Client, id: string, count = 2, reversal: string | null = null, currency = "NZD", obligations = 0, applications = 0) {
  await c.query(`INSERT INTO "MemberMoneyJournal"
    (id,"eventId",currency,"policyVersion","codingVersion","expectedLineCount","expectedObligationCount","expectedApplicationCount","reversesJournalId")
    VALUES ($1,$1,$2,'policy-1','coding-1',$3,$4,$5,$6)`, [id, currency, count, obligations, applications, reversal]);
}
async function source(c: Client, id: string) {
  await c.query(`INSERT INTO "MemberMoneySourceLink" (id,"journalId","sourceKind","sourceId","sourceVersion")
    VALUES ($1,$1,'OFFICER_FACT',$1,'v1')`, [id]);
}
async function line(c: Client, batch: string, side: string, amount = 100, original: string | null = null) {
  const id = next();
  await c.query(`INSERT INTO "MemberMoneyLine"
    (id,"journalId","sourceLinkId",account,side,"amountCents","debtorKind","memberId",evidence,"originalLineId")
    VALUES ($1,$2,$2,'BANK',$3,$4,'MEMBER','member-evidence','{}',$5)`, [id, batch, side, amount, original]);
  return id;
}
async function obligation(c: Client, batch: string, debtor: { member?: string; organisation?: string } = { member: "member-evidence" }) {
  const id = next();
  await c.query(`INSERT INTO "MemberMoneyObligation" (id,"journalId","obligationKey",kind,"debtorKind","memberId","organisationId","faceCents",evidence)
    VALUES ($1,$2,$1,'CHARGE',$3,$4,$5,100,'{}')`,
  [id, batch, debtor.organisation ? "ORGANISATION" : "MEMBER", debtor.member ?? null, debtor.organisation ?? null]);
  return id;
}
async function batch(c: Client, id = next()) {
  await event(c, id);
  await header(c, id);
  await source(c, id);
  const debit = await line(c, id, "DEBIT");
  const credit = await line(c, id, "CREDIT");
  return { id, debit, credit };
}
async function bridge(c: Client, batchId: string, lineId: string, legacy: string) {
  const link = next();
  await c.query(`INSERT INTO "MemberMoneySourceLink" (id,"journalId","sourceKind","sourceId","sourceVersion","bookingLedgerLineId")
    VALUES ($1,$2,'BOOKING_LEDGER',$3,'v1',$3)`, [link,batchId,legacy]);
  await c.query(`INSERT INTO "MemberMoneySourcePosting" (id,"journalId","sourceLinkId","lineId")
    VALUES ($1,$2,$3,$4)`, [next(),batchId,link,lineId]);
}
async function transaction(c: Client, run: () => Promise<unknown>) {
  await c.query("BEGIN");
  try { await run(); await c.query("COMMIT"); }
  catch (error) { await c.query("ROLLBACK"); throw error; }
}
/** The verifier as the operator command runs it: in its own read-only snapshot. */
async function verified(c: Client, role = roles.app) {
  await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try { return await verifyMemberMoneyJournal(c, role); } finally { await c.query("ROLLBACK"); }
}
async function findings(c: Client, role = roles.app) {
  return (await verified(c, role)).findings;
}
/** A DO block disabling one internal trigger of a foreign key, on the given table, or enabling it only for replicas. */
const disableForeignKeyTrigger = (constraint: string, table: string, how = "DISABLE") => `DO $$ BEGIN
  EXECUTE format('ALTER TABLE %I ${how} TRIGGER %I', '${table}', (SELECT tgname FROM pg_trigger
    WHERE tgconstraint = (SELECT oid FROM pg_constraint WHERE conname = '${constraint}')
      AND tgrelid = '"${table}"'::regclass LIMIT 1));
END $$`;
/** A charge of 115 cents: 100 net revenue and 15 GST, both credited, owed by one debtor. */
async function taxedCharge(c: Client, broken: { gst?: number; revenueAmount?: number } = {}) {
  const net = 100, tax = 15;
  const { gst = tax, revenueAmount = net } = broken;
  const id = next();
  await event(c, id, "CHARGE"); await header(c, id, gst ? 3 : 2); await source(c, id);
  await c.query(`INSERT INTO "MemberMoneyLine" (id,"journalId","sourceLinkId",account,side,"amountCents","debtorKind","memberId",evidence)
    VALUES ($1,$2,$2,'MEMBER_RECEIVABLE','DEBIT',$3,'MEMBER','member-evidence','{}')`, [next(), id, revenueAmount + gst]);
  await c.query(`INSERT INTO "MemberMoneyLine" (id,"journalId","sourceLinkId",account,side,"amountCents",evidence,"grossCents","netCents","taxCents","taxCode")
    VALUES ($1,$2,$2,$3,'CREDIT',$4,'{}',$5,$6,$7,'GST15')`, [next(), id, REVENUE, revenueAmount, net + tax, net, tax]);
  if (gst) await c.query(`INSERT INTO "MemberMoneyLine" (id,"journalId","sourceLinkId",account,side,"amountCents",evidence)
    VALUES ($1,$2,$2,'GST_PAYABLE','CREDIT',$3,'{}')`, [next(), id, gst]);
}

describe.skipIf(!RUN)("member money journal database contracts (#4513)", () => {
  beforeAll(async () => {
    // The shipped journal migration in isolation, with only its legacy FK parents
    // and the provisioned roles (the shared fixture holds the one definition).
    // Full-history/migration-role rehearsal belongs to database-roles.realdb.test.ts.
    scratch = await createMemberMoneyScratchDatabase(url, "member money journal", prefix);
    db = scratch.owner;
    app = new Client({ connectionString: scratch.appUrl }); await app.connect();
  }, 30_000);
  afterAll(async () => {
    await app?.end();
    await scratch?.drop();
  });

  it("commits a balanced complete batch as the INSERT/SELECT-only role and verifies it", async () => {
    await transaction(app, () => batch(app));
    expect(await verified(app, roles.app)).toEqual({ findings: [], grantCheck: "checked" });
  });

  it("reports the grant check as not applicable for a superuser or owner connection", async () => {
    const operator = (await db.query(`SELECT current_user AS name`)).rows[0].name as string;
    expect(await verified(db, operator)).toEqual({ findings: [], grantCheck: "not_applicable" });
    expect(await verified(db, roles.migrator)).toEqual({ findings: [], grantCheck: "not_applicable" });
  });

  it.each([
    ["the application, verified as the owner", `GRANT UPDATE, DELETE ON "MemberMoneyLine" TO "${roles.app}"`, `MemberMoneyLine:${roles.app}`],
    ["PUBLIC, on one column", `GRANT UPDATE (evidence) ON "MemberMoneyLine" TO PUBLIC`, "MemberMoneyLine:PUBLIC"],
    ["the audit-retention role", `GRANT TRUNCATE ON "MemberMoneyEvent" TO "${roles.retention}"`, `MemberMoneyEvent:${roles.retention}`],
  ])("reports a right that changes rows granted to %s, whichever role is checked", async (_grantee, grant, identity) => {
    await db.query("BEGIN");
    try {
      await db.query(grant);
      const result = await verifyMemberMoneyJournal(db, roles.migrator);
      expect(result.grantCheck).toBe("not_applicable");
      expect(result.findings).toContainEqual({ identity, problem: "change_granted_beyond_owner" });
    } finally { await db.query("ROLLBACK"); }
    expect(await verified(db, roles.migrator)).toEqual({ findings: [], grantCheck: "not_applicable" });
  });

  it.each(MEMBER_MONEY_RELATIONS)("refuses direct UPDATE, DELETE and TRUNCATE of %s", async (table) => {
    // No predicate or matching row is needed: PostgreSQL refuses the privilege itself.
    for (const sql of [`UPDATE "${table}" SET id = id`, `DELETE FROM "${table}"`, `TRUNCATE "${table}"`]) {
      await expect(app.query(sql)).rejects.toMatchObject({ code: "42501" });
      // Even an unrestricted operator cannot accidentally mutate posted rows.
      if (table === "MemberMoneyLine" && !sql.startsWith("TRUNCATE")) await expect(db.query(sql)).rejects.toMatchObject({ code: "23514" });
    }
    await expect(db.query(`SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE') AS allowed`, [roles.retention, `"${table}"`]))
      .resolves.toMatchObject({ rows: [{ allowed: false }] });
  });

  it("refuses operator TRUNCATE even on an empty leaf relation", async () => {
    await expect(db.query(`TRUNCATE "MemberMoneySourcePosting"`)).rejects.toMatchObject({ code: "23514" });
  });

  it("stamps the real creating transaction and cluster even if SQL supplies forged ones", async () => {
    await transaction(app, async () => {
      const id = next(); await event(app,id,"ZERO");
      await app.query(`INSERT INTO "MemberMoneyJournal" (id,"eventId",currency,"policyVersion","codingVersion","expectedLineCount",
          "expectedObligationCount","expectedApplicationCount","creatingTransaction","creatingSystemIdentifier")
        VALUES ($1,$1,'NZD','policy-1','coding-1',0,0,0,0,0)`, [id]);
      await source(app,id);
      expect((await app.query(`SELECT "creatingTransaction" = txid_current() AS tx,
          "creatingSystemIdentifier" = (SELECT system_identifier FROM pg_control_system()) AS cluster
        FROM "MemberMoneyJournal" WHERE id=$1`, [id])).rows).toEqual([{ tx: true, cluster: true }]);
    });
  });

  it("refuses a balanced pair appended after commit and denies rewriting its transaction stamp", async () => {
    let id = "";
    await transaction(app, async () => { id = (await batch(app)).id; });
    await expect(transaction(app, async () => {
      await line(app, id, "DEBIT"); await line(app, id, "CREDIT");
    })).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("sealed") });
    // An explicit old creatingTransaction cannot overwrite the database's stamp.
    const newer = next();
    await transaction(app, async () => {
      await event(app, newer); await header(app, newer); await source(app, newer);
      await line(app, newer, "DEBIT"); await line(app, newer, "CREDIT");
    });
    await expect(app.query(`UPDATE "MemberMoneyJournal" SET "creatingTransaction" = txid_current() WHERE id=$1`, [id]))
      .rejects.toMatchObject({ code: "42501" });
  });

  it("refuses a leg for a header stamped by another cluster, even in the same transaction id", async () => {
    // A restore into a new cluster can reach an old header's transaction id again;
    // its cluster identity cannot match. Forge such a header past the stamp, in
    // this very transaction, so only the cluster comparison can refuse the leg.
    await expect(transaction(db, async () => {
      const id = next();
      await db.query(`SET LOCAL session_replication_role = replica`);
      await event(db, id);
      await db.query(`INSERT INTO "MemberMoneyJournal"
        (id,"eventId",currency,"policyVersion","codingVersion","expectedLineCount","expectedObligationCount","expectedApplicationCount","creatingSystemIdentifier")
        VALUES ($1,$1,'NZD','policy-1','coding-1',2,0,0,1)`, [id]);
      await db.query(`SET LOCAL session_replication_role = origin`);
      await source(db, id);
      await line(db, id, "DEBIT");
    })).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("sealed") });
  });

  it.each(["unbalanced", "incomplete", "missing source", "one leg", "zero with legs", "nonzero without legs"])("rejects %s at commit and rolls back the event", async (problem) => {
    const id = next();
    await expect(transaction(app, async () => {
      await event(app, id, ["zero with legs", "missing source"].includes(problem) ? "ZERO" : "RECEIPT");
      await header(app, id, problem === "one leg" ? 1 : ["nonzero without legs", "missing source"].includes(problem) ? 0 : 2);
      if (problem !== "missing source") await source(app, id);
      // Missing source gets FK-safe lines via another link in no case: zero lines still fails mandatory-link.
      if (!["missing source", "nonzero without legs"].includes(problem)) {
        await line(app, id, "DEBIT");
        if (!["incomplete", "one leg"].includes(problem)) await line(app, id, "CREDIT", problem === "unbalanced" ? 99 : 100);
      }
    })).rejects.toMatchObject({ code: "23514", message: expect.stringContaining(
      problem === "missing source" ? "missing_source_link" : problem === "incomplete" ? "incomplete_batch"
        : problem === "unbalanced" ? "unbalanced_batch" : "invalid_zero_event",
    ) });
    expect((await app.query(`SELECT id FROM "MemberMoneyEvent" WHERE id=$1`, [id])).rows).toEqual([]);
  });

  it("rejects an orphan event and accepts an explicit zero event with a source", async () => {
    await expect(transaction(app, () => event(app, next()))).rejects.toMatchObject({ code: "23514" });
    await transaction(app, async () => {
      const id = next(); await event(app, id, "ZERO"); await header(app, id, 0); await source(app, id);
    });
  });

  it("requires the mandatory source link to match the event's source kind too", async () => {
    await expect(transaction(app, async () => {
      const id = next(); await event(app, id, "ZERO", { sourceKind: "PAYMENT" }); await header(app, id, 0); await source(app, id);
    })).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("missing_source_link") });
  });

  it("refuses an effective date no club zone could give its instant", async () => {
    // Every zone is within a day of UTC, so two days away is never a civil date of this instant.
    await expect(transaction(app, async () => {
      const id = next(); await event(app, id, "ZERO", { date: addCalendarDays(EFFECTIVE_DATE, 2) }); await header(app, id, 0); await source(app, id);
    })).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("effective_date_out_of_range") });
    expect((await app.query(`SELECT to_char("effectiveDate", 'YYYY-MM-DD') AS d FROM "MemberMoneyEvent" ORDER BY "recordedAt" LIMIT 1`)).rows)
      .toEqual([{ d: EFFECTIVE_DATE }]);
  });

  it("refuses nonpositive cents and invalid tax evidence", async () => {
    for (const amount of [0, -1]) await expect(transaction(app, async () => {
      const id = next(); await event(app, id); await header(app, id); await source(app, id);
      await line(app, id, "DEBIT", amount);
    })).rejects.toMatchObject({ code: "23514" });
    await expect(transaction(app, async () => {
      const b = await batch(app);
      await app.query(`INSERT INTO "MemberMoneyLine" (id,"journalId","sourceLinkId",account,side,"amountCents",evidence,"grossCents","netCents","taxCents","taxCode")
        VALUES ($1,$2,$2,'BANK','DEBIT',100,'{}',100,90,11,'tax')`, [next(), b.id]);
    })).rejects.toMatchObject({ code: "23514" });
  });

  it("ties a taxed revenue leg's net cents and the batch's GST legs to its recorded tax", async () => {
    await transaction(app, () => taxedCharge(app));
    for (const broken of [{ gst: 14 }, { revenueAmount: 115, gst: 0 }]) {
      await expect(transaction(app, () => taxedCharge(app, broken)))
        .rejects.toMatchObject({ code: "23514", message: expect.stringContaining("tax_tie_mismatch") });
    }
    expect(await findings(app)).toEqual([]);
  });

  it("refuses a debtor naming both or neither of a member and an organisation", async () => {
    for (const [kind, member, organisation] of [["MEMBER", null, "org"], ["MEMBER", "m", "org"], ["ORGANISATION", null, null], [null, "m", null]]) {
      await expect(transaction(app, async () => {
        const id = next(); await event(app, id); await header(app, id); await source(app, id);
        await app.query(`INSERT INTO "MemberMoneyLine" (id,"journalId","sourceLinkId",account,side,"amountCents","debtorKind","memberId","organisationId",evidence)
          VALUES ($1,$2,$2,'BANK','DEBIT',100,$3,$4,$5,'{}')`, [next(), id, kind, member, organisation]);
      })).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("member_money_line_debtor") });
    }
    await expect(transaction(app, async () => {
      const id = next(); await event(app, id); await header(app, id); await source(app, id);
      await app.query(`INSERT INTO "MemberMoneyLine" (id,"journalId","sourceLinkId",account,side,"amountCents",evidence)
        VALUES ($1,$2,$2,'MEMBER_RECEIVABLE','DEBIT',100,'{}')`, [next(), id]);
    })).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("member_money_line_shape") });
  });

  it("holds member credit only for a member, never an organisation", async () => {
    const credit = (debtor: "MEMBER" | "ORGANISATION") => transaction(app, async () => {
      const id = next(); await event(app, id, "CREDIT_GRANT"); await header(app, id); await source(app, id);
      await app.query(`INSERT INTO "MemberMoneyLine" (id,"journalId","sourceLinkId",account,side,"amountCents","debtorKind","memberId","organisationId","creditLotId",evidence)
        VALUES ($1,$2,$2,'MEMBER_CREDIT','CREDIT',100,$3,$4,$5,'lot-1','{}')`,
      [next(), id, debtor, debtor === "MEMBER" ? "member-evidence" : null, debtor === "ORGANISATION" ? "org-evidence" : null]);
      await line(app, id, "DEBIT");
    });
    await expect(credit("ORGANISATION")).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("member_money_line_shape") });
    await credit("MEMBER");
  });

  it("requires exact debtor/currency applications and exact, unique application reversals", async () => {
    let receipt!: Awaited<ReturnType<typeof batch>>;
    let owed = "", otherMember = "", organisationOwed = "";
    await transaction(app, async () => {
      receipt = { id: next(), debit: "", credit: "" };
      await event(app, receipt.id); await header(app, receipt.id, 2, null, "NZD", 3); await source(app, receipt.id);
      receipt.debit = await line(app, receipt.id, "DEBIT"); receipt.credit = await line(app, receipt.id, "CREDIT");
      owed = await obligation(app, receipt.id);
      otherMember = await obligation(app, receipt.id, { member: "another-member" });
      // An organisation debtor whose id equals a member's must still not match it.
      organisationOwed = await obligation(app, receipt.id, { organisation: "member-evidence" });
    });
    const apply = async (amount: number, reversal: string | null = null, currency = "NZD", target = owed) => {
      const application = next();
      await transaction(app, async () => {
        const id = next(); await event(app,id); await header(app,id,2,null,currency,0,1); await source(app,id);
        await line(app,id,"DEBIT"); await line(app,id,"CREDIT");
        await app.query(`INSERT INTO "MemberMoneyApplication" (id,"applicationKey","journalId","sourceLineId","obligationId","amountCents","reversesApplicationId")
          VALUES ($1,$1,$2,$3,$4,$5,$6)`, [application,id,receipt.debit,target,amount,reversal]);
      });
      return application;
    };
    await expect(apply(100,null,"USD")).rejects.toMatchObject({ code: "23514" });
    await expect(apply(100,null,"NZD",otherMember)).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("application_mismatch") });
    await expect(apply(100,null,"NZD",organisationOwed)).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("application_mismatch") });
    const first = await apply(100);
    await expect(apply(99,first)).rejects.toMatchObject({ code: "23514" });
    await apply(100,first);
    await expect(apply(100,first)).rejects.toMatchObject({ code: "23505" });
    await expect(app.query(`INSERT INTO "MemberMoneyObligation" (id,"journalId","obligationKey",kind,"debtorKind","memberId","faceCents",evidence)
      VALUES ($1,$2,$1,'CHARGE','MEMBER','member-evidence',100,'{}')`, [next(),receipt.id]))
      .rejects.toMatchObject({ code: "23514", message: expect.stringContaining("sealed") });
  });

  it("counts a header's obligations and applications as part of a complete batch", async () => {
    for (const [declared, posted, problem] of [[1, 0, "incomplete_obligations"], [0, 1, "incomplete_obligations"]] as const) {
      await expect(transaction(app, async () => {
        const id = next(); await event(app, id); await header(app, id, 2, null, "NZD", declared); await source(app, id);
        await line(app, id, "DEBIT"); await line(app, id, "CREDIT");
        if (posted) await obligation(app, id);
      })).rejects.toMatchObject({ code: "23514", message: expect.stringContaining(problem) });
    }
    await expect(transaction(app, async () => {
      const id = next(); await event(app, id); await header(app, id, 2, null, "NZD", 0, 1); await source(app, id);
      await line(app, id, "DEBIT"); await line(app, id, "CREDIT");
    })).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("incomplete_applications") });
  });

  it("refuses cross-batch source links, duplicate event/source keys and invalid bridge identity", async () => {
    let original = ""; await transaction(app, async () => { original = (await batch(app)).id; });
    await expect(transaction(app, () => event(app, original))).rejects.toMatchObject({ code: "23505" });
    await expect(transaction(app, async () => {
      const b = await batch(app);
      await app.query(`INSERT INTO "MemberMoneySourceLink" (id,"journalId","sourceKind","sourceId","sourceVersion")
        VALUES ($1,$2,'OFFICER_FACT',$3,'v1')`, [next(), b.id, original]);
    })).rejects.toMatchObject({ code: "23505" });
    await expect(transaction(app, async () => {
      const b = await batch(app);
      await app.query(`INSERT INTO "MemberMoneyLine" (id,"journalId","sourceLinkId",account,side,"amountCents",evidence)
        VALUES ($1,$2,$3,'BANK','DEBIT',1,'{}')`, [next(), b.id, original]);
    })).rejects.toMatchObject({ code: "23503" });
    await expect(transaction(app, async () => {
      const b = await batch(app);
      await app.query(`INSERT INTO "MemberMoneySourceLink" (id,"journalId","sourceKind","sourceId","sourceVersion")
        VALUES ($1,$2,'BOOKING_LEDGER','missing','v1')`, [next(), b.id]);
    })).rejects.toMatchObject({ code: "23514" });
  });

  it("accepts only exact reversals and refuses a second reversal", async () => {
    let original!: Awaited<ReturnType<typeof batch>>;
    await transaction(app, async () => { original = await batch(app); });
    const reverse = async (amount = 100) => transaction(app, async () => {
      const id = next(); await event(app, id, "REVERSAL"); await header(app, id, 2, original.id); await source(app, id);
      await line(app, id, "CREDIT", amount, original.debit); await line(app, id, "DEBIT", amount, original.credit);
    });
    await expect(reverse(99)).rejects.toMatchObject({ code: "23514" });
    await reverse();
    await expect(reverse()).rejects.toMatchObject({ code: "23505" });
  });

  it("lets a late compatibility link attach without allowing another leg", async () => {
    let original!: Awaited<ReturnType<typeof batch>>;
    await transaction(app, async () => { original = await batch(app); });
    const legacy = next(); await db.query(`INSERT INTO "BookingLedgerLine" VALUES ($1)`, [legacy]);
    await transaction(app, () => bridge(app,original.id,original.debit,legacy));
    await expect(line(app,original.id,"DEBIT")).rejects.toMatchObject({ code: "23514" });
  });

  it("reports disabled enforcement rather than a false green on valid balances", async () => {
    await db.query(`ALTER TABLE "MemberMoneyLine" DISABLE TRIGGER member_money_seal`);
    try {
      expect(await findings(app)).toContainEqual({ identity: "MemberMoneyLine.member_money_seal", problem: "missing_or_disabled_trigger" });
    } finally { await db.query(`ALTER TABLE "MemberMoneyLine" ENABLE TRIGGER member_money_seal`); }
    // A trigger enabled ALWAYS still enforces, including under replication.
    await db.query(`ALTER TABLE "MemberMoneyLine" ENABLE ALWAYS TRIGGER member_money_seal`);
    try {
      expect(await findings(app)).toEqual([]);
    } finally { await db.query(`ALTER TABLE "MemberMoneyLine" ENABLE TRIGGER member_money_seal`); }
  });

  it("reads back exactly the pinned constraint, trigger and unique-index definitions", async () => {
    // The definitions are the catalog's normalised text, so they are derived here,
    // from the migration as PostgreSQL applied it, never from migration.sql.
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      const definitions = await readMemberMoneyDefinitions(db);
      expect(definitions.filter((found) => !found.usable)).toEqual([]);
      const read = { constraints: {}, triggers: {}, uniqueIndexes: {} } as Record<string, Record<string, Record<string, string>>>;
      for (const { kind, relation, name, definition } of definitions) (read[kind]![relation] ??= {})[name] = definition;
      const { constraints, triggers, uniqueIndexes } = MEMBER_MONEY_DATABASE_SHAPE;
      expect(read).toEqual({ constraints, triggers, uniqueIndexes });
      // The settings the text depends on are fixed while it is read; the
      // caller's own, SET LOCAL included, come back exactly and stay local.
      await db.query(`SET LOCAL search_path = pg_catalog`);
      await db.query(`SET LOCAL quote_all_identifiers = on`);
      expect(await readMemberMoneyDefinitions(db)).toEqual(definitions);
      expect((await db.query(`SELECT current_setting('search_path') AS path, current_setting('quote_all_identifiers') AS quote`)).rows)
        .toEqual([{ path: "pg_catalog", quote: "on" }]);
    } finally { await db.query("ROLLBACK"); }
    expect((await db.query(`SELECT current_setting('quote_all_identifiers') AS quote`)).rows).toEqual([{ quote: "off" }]);
  });

  it("refuses to read the definitions outside a transaction", async () => {
    await expect(readMemberMoneyDefinitions(db)).rejects.toThrow(/inside a transaction/);
  });

  it.each([
    ["a constraint weakened to CHECK (true)", { identity: "MemberMoneyLine.member_money_tax_split", problem: "changed_constraint", found: "CHECK (true)" },
      `ALTER TABLE "MemberMoneyLine" DROP CONSTRAINT member_money_tax_split, ADD CONSTRAINT member_money_tax_split CHECK (true)`],
    ["a dropped unique index", { identity: "MemberMoneyJournal.MemberMoneyJournal_reversesJournalId_key", problem: "missing_or_invalid_unique_index" },
      `DROP INDEX "MemberMoneyJournal_reversesJournalId_key"`],
    ["a unique index left invalid", { identity: "MemberMoneyJournal.MemberMoneyJournal_eventId_key", problem: "missing_or_invalid_unique_index" },
      `UPDATE pg_index SET indisvalid = false WHERE indexrelid = '"MemberMoneyJournal_eventId_key"'::regclass`],
    ["a unique index not ready for inserts", { identity: "MemberMoneyEvent.MemberMoneyEvent_eventKey_key", problem: "missing_or_invalid_unique_index" },
      `UPDATE pg_index SET indisready = false WHERE indexrelid = '"MemberMoneyEvent_eventKey_key"'::regclass`],
    ["a foreign key's check trigger disabled on the journal table",
      { identity: "MemberMoneyLine.MemberMoneyLine_journalId_fkey", problem: "disabled_foreign_key_trigger" },
      disableForeignKeyTrigger("MemberMoneyLine_journalId_fkey", "MemberMoneyLine")],
    ["a foreign key's action trigger disabled on its parent, outside the journal",
      { identity: "MemberMoneyLine.MemberMoneyLine_bookingId_fkey", problem: "disabled_foreign_key_trigger" },
      disableForeignKeyTrigger("MemberMoneyLine_bookingId_fkey", "Booking")],
    ["a foreign key's check trigger set to fire only under replication",
      { identity: "MemberMoneyLine.MemberMoneyLine_journalId_fkey", problem: "disabled_foreign_key_trigger" },
      disableForeignKeyTrigger("MemberMoneyLine_journalId_fkey", "MemberMoneyLine", "ENABLE REPLICA")],
    ["an enforcement function's search_path reset",
      { identity: "member_money_check_seal", problem: "changed_function_settings", found: "config=[]" },
      `ALTER FUNCTION member_money_check_seal() RESET search_path`],
    ["an enforcement function made SECURITY DEFINER",
      { identity: "member_money_refuse_mutation", problem: "changed_function_settings", found: "securityDefiner=true" },
      `ALTER FUNCTION member_money_refuse_mutation() SECURITY DEFINER`],
    ["an immutability trigger re-pointed to a no-op function", { identity: "MemberMoneyLine.member_money_immutable", problem: "changed_trigger",
      found: `CREATE TRIGGER member_money_immutable BEFORE DELETE OR UPDATE ON public."MemberMoneyLine" FOR EACH ROW EXECUTE FUNCTION mm4513_tamper_noop()` },
      `CREATE FUNCTION mm4513_tamper_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
       DROP TRIGGER member_money_immutable ON "MemberMoneyLine";
       CREATE TRIGGER member_money_immutable BEFORE UPDATE OR DELETE ON "MemberMoneyLine"
         FOR EACH ROW EXECUTE FUNCTION mm4513_tamper_noop()`],
    ["an extra BEFORE INSERT trigger the shape does not name", { identity: "MemberMoneyLine.mm4513_extra", problem: "unexpected_trigger",
      found: `CREATE TRIGGER mm4513_extra BEFORE INSERT ON public."MemberMoneyLine" FOR EACH ROW EXECUTE FUNCTION mm4513_tamper_passthrough()` },
      `CREATE FUNCTION mm4513_tamper_passthrough() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
       CREATE TRIGGER mm4513_extra BEFORE INSERT ON "MemberMoneyLine"
         FOR EACH ROW EXECUTE FUNCTION mm4513_tamper_passthrough()`],
  ])("reports %s", async (_tampering, finding, sql) => {
    // DDL is transactional: the verifier reads the tampered catalog inside the
    // transaction, and the rollback puts the migration's definitions back. A
    // changed or unexpected definition is reported with the text it found.
    await db.query("BEGIN");
    try {
      await db.query(sql);
      expect((await verifyMemberMoneyJournal(db, roles.app)).findings).toContainEqual(finding);
    } finally { await db.query("ROLLBACK"); }
    expect(await findings(app)).toEqual([]);
  });

  it("reports a replaced enforcement function and an unvalidated constraint", async () => {
    const migration = readFileSync(MIGRATION, "utf8");
    const original = /CREATE FUNCTION member_money_refuse_mutation\(\)[\s\S]*?\$\$;/.exec(migration)?.[0];
    expect(original).toBeTruthy();
    await db.query(`CREATE OR REPLACE FUNCTION member_money_refuse_mutation() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$ BEGIN RETURN NULL; END $$`);
    try {
      expect(await findings(app)).toContainEqual({ identity: "member_money_refuse_mutation", problem: "changed_function" });
    } finally { await db.query(original!.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION")); }
    const check = `CHECK ("grossCents" IS NULL OR "grossCents" >= 0)`;
    await db.query(`ALTER TABLE "MemberMoneyLine" DROP CONSTRAINT member_money_tax_split,
      ADD CONSTRAINT member_money_tax_split ${check} NOT VALID`);
    try {
      expect(await findings(app)).toContainEqual({ identity: "MemberMoneyLine.member_money_tax_split", problem: "missing_or_unvalidated_constraint" });
    } finally {
      const restored = /ADD CONSTRAINT "member_money_tax_split" (CHECK \([\s\S]*?\n\));/.exec(migration)?.[1];
      await db.query(`ALTER TABLE "MemberMoneyLine" DROP CONSTRAINT member_money_tax_split, ADD CONSTRAINT member_money_tax_split ${restored}`);
    }
    expect(await findings(app)).toEqual([]);
  });

  it("retains bridged legacy evidence and booking/lodge parents with RESTRICT", async () => {
    const booking = next(), lodge = next(), legacy = next();
    await db.query(`INSERT INTO "Lodge" VALUES ($1)`, [lodge]);
    await db.query(`INSERT INTO "Booking" VALUES ($1,$2)`, [booking, lodge]);
    await db.query(`INSERT INTO "BookingLedgerLine" VALUES ($1)`, [legacy]);
    await transaction(app, async () => {
      const b = await batch(app);
      await bridge(app,b.id,b.debit,legacy);
    });
    await expect(db.query(`DELETE FROM "BookingLedgerLine" WHERE id=$1`, [legacy])).rejects.toMatchObject({ code: "23503" });
    // A valid lodge-scoped line on a new batch retains both its parents.
    await transaction(app, async () => {
      const id = next(); await event(app,id); await header(app,id); await source(app,id);
      await app.query(`INSERT INTO "MemberMoneyLine" (id,"journalId","sourceLinkId",account,side,"amountCents",evidence,"bookingId","lodgeId")
        VALUES ($1,$2,$2,'BANK','DEBIT',100,'{}',$3,$4)`, [next(),id,booking,lodge]);
      await line(app,id,"CREDIT");
    });
    for (const [table, id] of [["Booking",booking],["Lodge",lodge]]) {
      await expect(db.query(`DELETE FROM "${table}" WHERE id=$1`, [id])).rejects.toMatchObject({ code: "23503" });
      await expect(db.query(`UPDATE "${table}" SET id=$1 WHERE id=$2`, [next(),id])).rejects.toMatchObject({ code: "23503" });
    }
  });
});
