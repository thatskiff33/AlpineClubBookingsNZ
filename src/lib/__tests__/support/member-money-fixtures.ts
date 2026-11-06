/**
 * Shared member-money journal fixtures for tests (#4626, Ledger M3a): a posting
 * context on the frozen clock, plan builders for the common batch shapes, and a
 * scratch PostgreSQL database holding only the journal migration, stub parent
 * tables and the provisioned roles.
 *
 * The scratch database proves the engine against the journal's own constraints.
 * Its stub parents carry no booking columns, so it is NOT for door suites: those
 * run on the fully migrated race database, post through the plan builders here,
 * and tear down through `booking-financial-history-teardown.ts`, as
 * `booking-financial-history.realdb.test.ts` does.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { CLUB_TAX_SETTINGS_DEFAULTS, type ClubTaxSettings } from "@/lib/club-tax-settings";
import { requireClubTimeZone, requireInstant } from "@/lib/club-time";
import { buildDatabaseRolesSql } from "@/lib/database-roles";
import {
  resolveMemberMoneyPostingContext,
  type MemberMoneyDebtor,
  type MemberMoneyPlan,
  type MemberMoneyPostingContext,
  type MemberMoneySource,
} from "@/lib/member-money";
import type { MemberMoneyEventKey } from "@/lib/member-money/internal/keys";
import { FROZEN_TEST_CLOCK_BASE_ISO } from "../helpers/clock";
import { CLUB_FORMAT_TEST } from "./club-format-fixture";
import { assertSafeRaceDbUrl } from "./race-db-url";

export const MEMBER_MONEY_JOURNAL_MIGRATION = "prisma/migrations/20261127010000_member_money_journal/migration.sql";

/** A context resolved as a door resolves it before its transaction, on the frozen test clock. */
export function memberMoneyTestContext(
  overrides: { taxSettings?: Partial<ClubTaxSettings>; effectiveAt?: string } = {},
): MemberMoneyPostingContext {
  return resolveMemberMoneyPostingContext({
    effectiveAt: requireInstant(overrides.effectiveAt ?? FROZEN_TEST_CLOCK_BASE_ISO),
    zone: requireClubTimeZone("Pacific/Auckland"),
    format: CLUB_FORMAT_TEST,
    policyVersion: "policy-test-1",
    codingVersion: "coding-test-1",
    taxSettings: { ...CLUB_TAX_SETTINGS_DEFAULTS, ...overrides.taxSettings },
  });
}

/**
 * A booking charge as R01 posts one: Dr receivable for the total against a new
 * charge obligation, Cr booking revenue for each component at its gross (split
 * by the context's tax treatment into net revenue and GST).
 */
export function bookingChargePlan(input: {
  eventKey: MemberMoneyEventKey;
  debtor: MemberMoneyDebtor;
  grossCents: number;
  /** Components the gross is made of; one `<eventKey>:nights` component by default. */
  components?: readonly { chargeIdentity: string; grossCents: number }[];
  booking?: { bookingId: string; lodgeId: string };
  source?: MemberMoneySource;
  additionalSources?: MemberMoneySource[];
}): Extract<MemberMoneyPlan, { legs: unknown }> {
  const components = input.components ?? [{ chargeIdentity: `${input.eventKey}:nights`, grossCents: input.grossCents }];
  const obligationKey = `${input.eventKey}:obligation`;
  const revenueSource = input.additionalSources?.find((source) => source.kind === "BOOKING_LEDGER");
  return {
    kind: "CHARGE",
    eventKey: input.eventKey,
    origin: "APP",
    source: input.source ?? { kind: "BOOKING", id: input.booking?.bookingId ?? input.eventKey, version: input.eventKey },
    additionalSources: input.additionalSources,
    reason: "test booking charge",
    obligations: [{ key: obligationKey, kind: "CHARGE", debtor: input.debtor, faceCents: input.grossCents, evidence: { test: true } }],
    legs: [
      {
        type: "amount", account: "MEMBER_RECEIVABLE", side: "DEBIT", amountCents: input.grossCents,
        debtor: input.debtor, obligationKey, booking: input.booking, evidence: { test: "receivable" },
      },
      ...components.map(({ chargeIdentity, grossCents }) => ({
        type: "revenue" as const, account: "BOOKING_REVENUE" as const, side: "CREDIT" as const, grossCents,
        booking: input.booking, chargeIdentity, source: revenueSource, evidence: { test: "nights" },
      })),
    ],
  };
}

/** A unique scratch database name; a suite that needs its role names at collection time picks it up front. */
export function memberMoneyScratchName(prefix: string): string {
  return `${prefix}_${randomBytes(5).toString("hex")}`;
}

export function memberMoneyScratchRoles(name: string) {
  return { migrator: `${name}_migration`, app: `${name}_app`, retention: `${name}_retention` };
}

export interface MemberMoneyScratchDatabase {
  name: string;
  roles: { migrator: string; app: string; retention: string };
  /** The race server, connected to its maintenance database. */
  admin: Client;
  /** The scratch database as its owner. */
  owner: Client;
  /** A URL for the scratch database as the INSERT/SELECT-only application role. */
  appUrl: string;
  drop(): Promise<void>;
}

/**
 * A disposable database on the race server holding the journal migration, the
 * stub parents it references (`Lodge`, `Booking`, `BookingLedgerLine`,
 * `AuditLog`) and the least-privilege roles provisioning creates. The full
 * migration history is rehearsed in `database-roles.realdb.test.ts`.
 */
export async function createMemberMoneyScratchDatabase(
  url: string,
  label: string,
  name = memberMoneyScratchName("mm"),
): Promise<MemberMoneyScratchDatabase> {
  assertSafeRaceDbUrl(url, label);
  const roles = memberMoneyScratchRoles(name);
  const admin = new Client({ connectionString: url });
  await admin.connect();
  const ownerUrl = new URL(url);
  ownerUrl.pathname = `/${name}`;
  const owner = new Client({ connectionString: ownerUrl.toString() });
  let connected = false;
  const drop = async () => {
    if (connected) await owner.end();
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    for (const role of Object.values(roles)) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
    await admin.end();
  };
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    await owner.connect();
    connected = true;
    await owner.query(`CREATE TABLE "Lodge" (id text PRIMARY KEY);
      CREATE TABLE "Booking" (id text PRIMARY KEY, "lodgeId" text REFERENCES "Lodge"(id));
      CREATE TABLE "BookingLedgerLine" (id text PRIMARY KEY);
      CREATE TABLE "AuditLog" (id text PRIMARY KEY, "ipAddress" text, "userAgent" text)`);
    await owner.query(readFileSync(MEMBER_MONEY_JOURNAL_MIGRATION, "utf8"));
    const statements = buildDatabaseRolesSql({
      databaseName: name,
      migrator: { roleName: roles.migrator, password: "m".repeat(28) },
      app: { roleName: roles.app, password: "a".repeat(28) },
      auditRetention: { roleName: roles.retention, password: "r".repeat(28) },
    });
    await owner.query("BEGIN");
    try {
      for (const statement of statements) await owner.query(statement);
      await owner.query("COMMIT");
    } catch (error) {
      await owner.query("ROLLBACK");
      throw error;
    }
  } catch (error) {
    // Nothing a half-built scratch database made may outlive the failure.
    await drop();
    throw error;
  }
  const appUrl = new URL(ownerUrl);
  appUrl.username = roles.app;
  appUrl.password = "a".repeat(28);
  return { name, roles, admin, owner, appUrl: appUrl.toString(), drop };
}
