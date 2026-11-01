/**
 * Shared member-money journal fixtures for tests (#4626, Ledger M3a): a posting
 * context on the frozen clock, plan builders for the common batch shapes, and a
 * scratch PostgreSQL database holding just the journal migration and its
 * provisioned roles. Door suites (M3b on) build their plans here instead of
 * re-deriving the shapes, and tear down through
 * `booking-financial-history-teardown.ts`.
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
import { FROZEN_TEST_CLOCK_BASE_ISO } from "../helpers/clock";
import { assertSafeRaceDbUrl } from "./race-db-url";

export const MEMBER_MONEY_JOURNAL_MIGRATION = "prisma/migrations/20261127010000_member_money_journal/migration.sql";

/** A context resolved as a door resolves it before its transaction, on the frozen test clock. */
export function memberMoneyTestContext(
  overrides: { taxSettings?: Partial<ClubTaxSettings>; effectiveAt?: string } = {},
): MemberMoneyPostingContext {
  return resolveMemberMoneyPostingContext({
    effectiveAt: requireInstant(overrides.effectiveAt ?? FROZEN_TEST_CLOCK_BASE_ISO),
    zone: requireClubTimeZone("Pacific/Auckland"),
    currency: "NZD",
    policyVersion: "policy-test-1",
    codingVersion: "coding-test-1",
    taxSettings: { ...CLUB_TAX_SETTINGS_DEFAULTS, ...overrides.taxSettings },
  });
}

/**
 * A booking charge as R01 posts one: Dr receivable for the gross against a new
 * charge obligation, Cr booking revenue at that gross (split by the context's
 * tax treatment into net revenue and GST).
 */
export function bookingChargePlan(input: {
  eventKey: string;
  debtor: MemberMoneyDebtor;
  grossCents: number;
  booking?: { bookingId: string; lodgeId: string };
  source?: MemberMoneySource;
  additionalSources?: MemberMoneySource[];
  chargeIdentity?: string;
}): Extract<MemberMoneyPlan, { kind: "CHARGE" }> {
  const chargeIdentity = input.chargeIdentity ?? `${input.eventKey}:nights`;
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
        debtor: input.debtor, obligationKey, booking: input.booking, chargeIdentity, evidence: { test: "receivable" },
      },
      {
        type: "revenue", account: "BOOKING_REVENUE", side: "CREDIT", grossCents: input.grossCents,
        booking: input.booking, chargeIdentity, source: revenueSource, evidence: { test: "nights" },
      },
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
  ownerUrl: string;
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
  await admin.query(`CREATE DATABASE "${name}"`);
  const ownerUrl = new URL(url);
  ownerUrl.pathname = `/${name}`;
  const owner = new Client({ connectionString: ownerUrl.toString() });
  await owner.connect();
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
  const appUrl = new URL(ownerUrl);
  appUrl.username = roles.app;
  appUrl.password = "a".repeat(28);
  return {
    name, roles, admin, owner, appUrl: appUrl.toString(), ownerUrl: ownerUrl.toString(),
    async drop() {
      await owner.end();
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      for (const role of Object.values(roles)) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      await admin.end();
    },
  };
}
