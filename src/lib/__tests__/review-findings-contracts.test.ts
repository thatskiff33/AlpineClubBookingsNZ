import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { spawnSync } from "child_process";
import { describe, expect, it } from "vitest";

function readRepoFile(relativePath: string) {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

function sliceFrom(source: string, startMarker: string, endMarker?: string) {
  const start = source.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`Could not find marker: ${startMarker}`);
  }

  if (!endMarker) {
    return source.slice(start);
  }

  const end = source.indexOf(endMarker, start);
  if (end === -1) {
    throw new Error(`Could not find end marker: ${endMarker}`);
  }

  return source.slice(start, end);
}

// #1159 (finding F4): the person-night guard is only race-free if every
// member-linked guest-night writer takes the global booking advisory lock
// (pg_advisory_xact_lock(1)) BEFORE running the guard
// (assertNoBookingMemberNightConflicts) in the same transaction. indexOf proves
// the source ordering (lock text precedes guard text inside the function body);
// each writer was separately confirmed to run both markers under one
// prisma.$transaction, so source order reflects execution order.
function assertLockBeforeGuard(block: string, label: string) {
  // The lock is either the per-lodge capacity lock (multi-lodge:
  // acquireLodgeCapacityLock, which runs pg_advisory_xact_lock on a per-lodge
  // key) or a raw advisory lock. Either satisfies the lock-before-guard
  // contract; take whichever appears first.
  const lockMarkers = ["acquireLodgeCapacityLock", "pg_advisory_xact_lock"]
    .map((marker) => block.indexOf(marker))
    .filter((idx) => idx >= 0);
  const lockIdx = lockMarkers.length > 0 ? Math.min(...lockMarkers) : -1;
  const guardIdx = block.indexOf("assertNoBookingMemberNightConflicts");
  expect(lockIdx, `${label}: advisory lock present`).toBeGreaterThanOrEqual(0);
  expect(
    guardIdx,
    `${label}: person-night guard runs after the advisory lock`
  ).toBeGreaterThan(lockIdx);
}

// #1529: the two request-approval pipelines delegate the person-night guard to
// buildApprovalGuestCreates (booking-request-shared.ts), which runs it against
// the caller's tx — lock-first stays the caller's responsibility, same
// two-half idiom as the modify pipeline's delegated-guard test below.
function assertLockBeforeDelegatedGuard(
  block: string,
  delegateMarker: string,
  label: string
) {
  const lockMarkers = ["acquireLodgeCapacityLock", "pg_advisory_xact_lock"]
    .map((marker) => block.indexOf(marker))
    .filter((idx) => idx >= 0);
  const lockIdx = lockMarkers.length > 0 ? Math.min(...lockMarkers) : -1;
  const delegateIdx = block.indexOf(delegateMarker);
  expect(lockIdx, `${label}: advisory lock present`).toBeGreaterThanOrEqual(0);
  expect(
    delegateIdx,
    `${label}: ${delegateMarker} delegated after the advisory lock`
  ).toBeGreaterThan(lockIdx);
}

function createTempMigration(sql: string, ledger: string) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "tac-migration-safety-"));
  const migrationDir = path.join(tempDir, "20990101000000_test_migration");
  const migrationPath = path.join(migrationDir, "migration.sql");
  const ledgerPath = path.join(tempDir, "safety.tsv");

  mkdirSync(migrationDir, { recursive: true });
  writeFileSync(migrationPath, sql);
  writeFileSync(ledgerPath, ledger);

  return { tempDir, migrationPath, ledgerPath };
}

function runMigrationSafetyValidator(
  migrationPath: string,
  ledgerPath: string,
  env: Record<string, string> = {}
) {
  return spawnSync("bash", ["scripts/validate-blue-green-migrations.sh", migrationPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MIGRATION_SAFETY_LEDGER: ledgerPath,
      ...env,
    },
    encoding: "utf8",
  });
}

const LEDGER_HEADER =
  "# migration_name\tphase\tprevious_expand_release\told_code_compatible\tlock_impact_plan";

function createTempMigrationsTree(
  migrations: { name: string; sql: string }[],
  ledger: string
) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "tac-migration-coverage-"));
  const migrationsDir = path.join(tempDir, "migrations");
  const ledgerPath = path.join(tempDir, "safety.tsv");

  for (const migration of migrations) {
    const dir = path.join(migrationsDir, migration.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "migration.sql"), migration.sql);
  }
  writeFileSync(ledgerPath, ledger);

  return { tempDir, migrationsDir, ledgerPath };
}

function runMigrationSafetyCoverage(
  env: Record<string, string> = {}
) {
  return spawnSync("bash", ["scripts/check-migration-safety-coverage.sh"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env,
    },
    encoding: "utf8",
  });
}

describe("review finding source/schema contracts", () => {
  it("keeps guest chore token links read-only", () => {
    const source = readRepoFile("src/app/api/chores/[token]/route.ts");
    const putBlock = sliceFrom(source, "export async function PUT");

    expect(putBlock).not.toContain("Public endpoint");
    expect(putBlock).not.toContain("auth(");
    expect(putBlock).not.toContain("validateGuestChoreToken");
    expect(putBlock).not.toContain("choreAssignment.update");
    expect(putBlock).toContain("status: 405");
    expect(putBlock).toContain('Allow: "GET"');
  });

  it("wraps draft booking creation in the advisory-lock transaction", () => {
    // Booking creation lives in the booking-create service; the route handler
    // delegates here. Scan the service for the architectural invariants.
    const source = readRepoFile("src/lib/booking-create.ts");
    const draftBlock = sliceFrom(
      source,
      "export async function createDraftBooking",
      "export async function createConfirmedBooking"
    );

    expect(draftBlock).toContain("prisma.$transaction");
    // The capacity lock is per-lodge since multi-lodge phase 3; the contract
    // is that draft creation stays serialized under the capacity lock.
    expect(draftBlock).toContain("acquireLodgeCapacityLock(tx,");
    expect(draftBlock).toContain("tx.booking.create");
    expect(draftBlock).toMatch(/redeemPromoCode\(\s*tx,/);
    expect(draftBlock).not.toContain("prisma.booking.create");
    expect(draftBlock).not.toMatch(/redeemPromoCode\(\s*prisma,/);
  });

  it("wraps waitlist booking creation in a transaction instead of standalone Prisma writes", () => {
    const source = readRepoFile("src/lib/booking-create.ts");
    const createWaitlistedBookingBlock = sliceFrom(
      source,
      "export async function createWaitlistedBooking"
    );

    expect(createWaitlistedBookingBlock).toContain("prisma.$transaction");
    expect(createWaitlistedBookingBlock).toContain("acquireLodgeCapacityLock(tx,");
  });

  it("takes the booking advisory lock before the person-night guard in every same-transaction member-linked guest writer", () => {
    // #1159: freeze lock->guard ordering for every writer that persists a
    // member-linked BookingGuest/BookingGuestNight and runs the guard in the
    // same transaction. (The modify guest-edit path delegates its guard to a
    // helper and is frozen by the next test; group-booking's non-member join
    // path carries no member guest, so the guard is a no-op there and is out of
    // scope by design.)
    const bookingCreate = readRepoFile("src/lib/booking-create.ts");
    assertLockBeforeGuard(
      sliceFrom(
        bookingCreate,
        "export async function createDraftBooking",
        "export async function createConfirmedBooking"
      ),
      "createDraftBooking"
    );
    assertLockBeforeGuard(
      sliceFrom(
        bookingCreate,
        "export async function createConfirmedBooking",
        "export async function createWaitlistedBooking"
      ),
      "createConfirmedBooking"
    );
    assertLockBeforeGuard(
      sliceFrom(bookingCreate, "export async function createWaitlistedBooking"),
      "createWaitlistedBooking"
    );

    assertLockBeforeGuard(
      sliceFrom(
        readRepoFile("src/lib/booking-date-modification-service.ts"),
        "export async function modifyBookingDates"
      ),
      "modifyBookingDates"
    );

    // #1529: both approval pipelines now delegate the guard to
    // buildApprovalGuestCreates inside the same transaction; freeze
    // lock -> delegation per caller here, and the guard inside the shared
    // helper once (below, after the callers).
    assertLockBeforeDelegatedGuard(
      sliceFrom(
        readRepoFile("src/lib/booking-request.ts"),
        "export async function approveBookingRequest",
        "export async function purgeExpiredBookingRequests"
      ),
      "buildApprovalGuestCreates(",
      "approveBookingRequest"
    );

    assertLockBeforeGuard(
      sliceFrom(
        readRepoFile("src/lib/booking-request-quotes.ts"),
        "export async function holdBookingRequestSlots"
      ),
      "holdBookingRequestSlots"
    );

    assertLockBeforeDelegatedGuard(
      sliceFrom(
        readRepoFile("src/lib/school-booking-request.ts"),
        "export async function approveSchoolBookingRequest"
      ),
      "buildApprovalGuestCreates(",
      "approveSchoolBookingRequest"
    );

    // Second half of the #1529 delegation contract: the shared helper both
    // pipelines call actually runs the person-night guard.
    const requestShared = readRepoFile("src/lib/booking-request-shared.ts");
    expect(
      sliceFrom(
        requestShared,
        "export async function buildApprovalGuestCreates",
        "export async function sendOwnerSubstitutionAdminAlert"
      )
    ).toContain("assertNoBookingMemberNightConflicts");

    assertLockBeforeGuard(
      sliceFrom(
        readRepoFile("src/app/api/bookings/[id]/guests/route.ts"),
        "export async function POST"
      ),
      "guests route POST (member self-add)"
    );
  });

  it("keeps the modify pipeline's advisory lock ahead of its delegated person-night guard", () => {
    // The guest-editing modify path (single + batch) runs through
    // modifyBookingBatch, which takes the advisory lock and then delegates the
    // person-night guard to prepareGuestPlan inside the SAME transaction: the
    // guard runs against the passed-in tx, so taking the lock first is the
    // caller's responsibility. Freeze both halves of that contract.
    const batchService = readRepoFile(
      "src/lib/booking-batch-modification-service.ts"
    );
    const modifyBlock = sliceFrom(
      batchService,
      "export async function modifyBookingBatch"
    );
    const lockMarkers = ["acquireLodgeCapacityLock", "pg_advisory_xact_lock"]
      .map((marker) => modifyBlock.indexOf(marker))
      .filter((idx) => idx >= 0);
    const lockIdx = lockMarkers.length > 0 ? Math.min(...lockMarkers) : -1;
    const delegateIdx = modifyBlock.indexOf("prepareGuestPlan(");
    expect(lockIdx, "modifyBookingBatch: advisory lock present").toBeGreaterThanOrEqual(0);
    expect(
      delegateIdx,
      "modifyBookingBatch: prepareGuestPlan delegated after the advisory lock"
    ).toBeGreaterThan(lockIdx);

    const plan = readRepoFile("src/lib/booking-modify-plan.ts");
    const prepareBlock = sliceFrom(
      plan,
      "export async function prepareGuestPlan",
      "export async function loadActiveSeasonRates"
    );
    expect(prepareBlock).toContain("assertNoBookingMemberNightConflicts");
  });

  it("wraps age-up membership upgrades and token issuance in a transaction", () => {
    const source = readRepoFile("src/lib/cron-age-up.ts");

    expect(source).toContain("prisma.$transaction");
  });

  it("uses stable booking-modification idempotency keys instead of Date.now()", () => {
    const modifyRoute = readRepoFile("src/app/api/bookings/[id]/modify/route.ts");
    const modifyDatesRoute = readRepoFile(
      "src/app/api/bookings/[id]/modify-dates/route.ts"
    );
    const guestsRoute = readRepoFile("src/app/api/bookings/[id]/guests/route.ts");

    expect(modifyRoute).not.toContain("Date.now()");
    expect(modifyDatesRoute).not.toContain("Date.now()");
    expect(guestsRoute).not.toContain("Date.now()");
  });

  it("persists executed Stripe refunds as first-class records instead of only cumulative totals", () => {
    const schema = readRepoFile("prisma/schema.prisma");
    const paymentTransactions = readRepoFile("src/lib/payment-transactions.ts");
    const stripeWebhook = [
      readRepoFile("src/app/api/webhooks/stripe/route.ts"),
      readRepoFile("src/lib/stripe-webhook-service.ts"),
    ].join("\n");

    expect(schema).toMatch(/model\s+(?!RefundRequest\b)\w*Refund\w*\s*\{/);
    expect(schema).toContain("stripeRefundId");
    expect(schema).toContain("stripeChargeId");
    expect(schema).toContain("stripePaymentIntentId");
    expect(schema).toContain("currency");
    expect(schema).toContain("status");
    expect(paymentTransactions).toContain("paymentRefund.upsert");
    expect(paymentTransactions).toContain("recordStripeRefundLedgerEntry");
    expect(stripeWebhook).toContain("listRefundsForCharge");
    expect(stripeWebhook).toContain("syncRefundsFromStripeCharge");
  });

  it("documents BookingEvent as narrative facts rather than the full transition ledger", () => {
    const source = readRepoFile("src/lib/booking-events.ts");
    const docs = readRepoFile("docs/STATE_MACHINES.md");

    expect(source).toContain("not a complete transition");
    expect(source).toContain("durable narrative fact store");
    expect(source).toContain("Status fields, AuditLog, CronJobRun");
    expect(source).not.toContain("Every booking/payment transition writes one BookingEvent");
    expect(docs).toContain("### BookingEvent Scope");
    expect(docs).toContain("not the complete transition");
    expect(docs).toContain("payment, transaction, refund, recovery, and Xero outbox ledgers");
  });

  it("does not rely on regex tag stripping in the booking notes route", () => {
    const source = readRepoFile("src/app/api/bookings/[id]/notes/route.ts");

    expect(source).not.toContain("function stripHtmlTags");
    expect(source).not.toContain("/<[^>]*>/g");
  });

  it("renders NZ-local expiry timestamps in email verification and email-change templates", () => {
    const source = readRepoFile("src/lib/email-templates.ts");
    const verificationTemplateBlock = sliceFrom(
      source,
      "export function emailVerificationTemplate",
      "export function nominationRequestTemplate"
    );
    const emailChangeTemplateBlock = sliceFrom(
      source,
      "export function emailChangeVerificationTemplate",
      "export function emailChangeNotificationTemplate"
    );

    expect(verificationTemplateBlock).toContain("formatNZDateTime");
    expect(verificationTemplateBlock).not.toContain("This link expires in 24 hours");
    expect(emailChangeTemplateBlock).toContain("formatNZDateTime");
    expect(emailChangeTemplateBlock).not.toContain("This link expires in 1 hour");
  });

  it("surfaces email-change outcome query state on the profile page", () => {
    const source = readRepoFile("src/app/(authenticated)/profile/page.tsx");

    expect(source).toContain("emailChangeError");
    expect(source).toContain("emailChanged");
  });

  it("validates booking-cancel mutations and removes guest-chore token mutations", () => {
    const cancelRoute = readRepoFile("src/app/api/bookings/[id]/cancel/route.ts");
    const guestChoreRoute = readRepoFile("src/app/api/chores/[token]/route.ts");
    const schemaPattern = /z\.(object|enum|string|number)|safeParse\(|\.parse\(/;

    expect(cancelRoute).toMatch(schemaPattern);
    expect(guestChoreRoute).not.toContain("guestChoreMutationSchema");
    expect(guestChoreRoute).not.toContain("choreAssignment.update");
    expect(cancelRoute).not.toContain('default to "card"');
  });

  it("rate-limits public token-bearing verification and guest-chore routes", () => {
    const verifyEmailRoute = readRepoFile("src/app/api/auth/verify-email/route.ts");
    const confirmEmailChangeRoute = readRepoFile(
      "src/app/api/auth/confirm-email-change/route.ts"
    );
    const guestChoreRoute = readRepoFile("src/app/api/chores/[token]/route.ts");

    expect(verifyEmailRoute).toContain("applyRateLimit");
    expect(confirmEmailChangeRoute).toContain("applyRateLimit");
    expect(guestChoreRoute).toContain("applyRateLimit");
  });

  it("uses schemas for the remaining manual query and search parsing routes", () => {
    const schemaPattern = /z\.(object|enum|string|number)|safeParse\(|\.parse\(/;
    const routes = [
      "src/app/api/availability/route.ts",
      "src/app/api/availability/check/route.ts",
      "src/app/api/booking-policies/check/route.ts",
      "src/app/api/admin/bookings/search/route.ts",
      "src/app/api/admin/xero/search-contacts/route.ts",
      "src/app/api/admin/xero/sync-memberships/route.ts",
    ];

    for (const route of routes) {
      expect(readRepoFile(route)).toMatch(schemaPattern);
    }
  });

  it("adds the missing foreign-key indexes for Booking.createdById and FamilyGroupJoinRequest.linkedMemberId", () => {
    const schema = readRepoFile("prisma/schema.prisma");
    const bookingBlock = sliceFrom(schema, "model Booking {", "model Payment {");
    const familyGroupJoinRequestBlock = sliceFrom(
      schema,
      "model FamilyGroupJoinRequest {",
      "model NotificationPreference {"
    );

    expect(bookingBlock).toContain("@@index([createdById])");
    expect(familyGroupJoinRequestBlock).toContain("@@index([linkedMemberId])");
  });

  it("keeps financial-history relations from cascading deletes off Member and Booking", () => {
    const schema = readRepoFile("prisma/schema.prisma");

    // The original finding banned exact relation lines, which broke on any
    // unrelated model whose formatting coincided (e.g. the ADR-004 waitlist
    // opt-in junction, which legitimately cascades with its booking). Assert
    // the actual invariant instead: within each financial-history model, no
    // relation to Booking or Member may cascade, regardless of formatting.
    const FINANCIAL_HISTORY_MODELS = [
      "BookingEvent",
      "Payment",
      "PaymentTransaction",
      "PaymentRefund",
      "RefundRequest",
      "MemberCredit",
      "AdminCreditAdjustmentRequest",
      "PaymentRecoveryOperation",
    ];
    for (const model of FINANCIAL_HISTORY_MODELS) {
      const block = schema.match(
        new RegExp(`^model ${model} \\{[\\s\\S]*?^\\}`, "m")
      );
      expect(block, `model ${model} missing from schema`).not.toBeNull();
      const offending = (block![0].match(/^.*@relation.*$/gm) ?? []).filter(
        (line) =>
          /\b(Booking|Member)\b\s+@relation/.test(line) &&
          line.includes("onDelete: Cascade")
      );
      expect(offending, `${model} cascades off Booking/Member`).toEqual([]);
    }
  });

  it("serializes stale waitlist-offer expiry and re-offer selection behind a transaction", () => {
    const source = readRepoFile("src/lib/waitlist.ts");
    const expireStaleOffersBlock = sliceFrom(
      source,
      "export async function expireStaleOffers",
      "/**\n * Recalculate and update waitlistPosition"
    );

    expect(expireStaleOffersBlock).toContain("prisma.$transaction");
    expect(expireStaleOffersBlock).toContain("acquireLodgeCapacityLock");
  });

  it("adds SES bounce and complaint ingestion instead of retry-only email recovery", () => {
    const emailCronSource = readRepoFile("src/lib/cron-email-retry.ts");
    const emailSource = readRepoFile("src/lib/email.ts");
    const emailSenderSource = readRepoFile("src/lib/email-sender.ts");
    const suppressionSource = readRepoFile("src/lib/email-suppression.ts");
    const snsRoute = readRepoFile("src/app/api/webhooks/ses-sns/route.ts");
    const sesSnsVerifier = readRepoFile("src/lib/ses-sns.ts");
    const schema = readRepoFile("prisma/schema.prisma");
    const combined = `${emailCronSource}\n${emailSource}\n${emailSenderSource}\n${suppressionSource}\n${snsRoute}\n${sesSnsVerifier}`;

    expect(combined).toMatch(/bounce|complaint/i);
    expect(combined).toMatch(/sns|ses/i);
    expect(combined).toContain("verifySnsWebhookMessage");
    expect(combined).toContain("getActiveEmailSuppression");
    expect(schema).toContain("model EmailSuppression");
  });

  it("keeps nomination token page and confirmation lookups hashed at rest", () => {
    const pageSource = readRepoFile("src/app/(authenticated)/nominations/[token]/page.tsx");
    const nominationSource = readRepoFile("src/lib/nomination.ts");
    const schema = readRepoFile("prisma/schema.prisma");

    expect(schema).toContain("model NominationToken");
    expect(schema).toContain("tokenHash");
    expect(schema).not.toContain("token             String    @unique");
    expect(pageSource).toContain("hashActionToken(token)");
    expect(nominationSource).toContain("where: { tokenHash }");
  });

  it("wires logger and Sentry through shared token scrubbing", () => {
    const loggerSource = readRepoFile("src/lib/logger.ts");
    const sentryServer = readRepoFile("sentry.server.config.ts");
    const sentryEdge = readRepoFile("sentry.edge.config.ts");

    expect(loggerSource).toMatch(/redact:|redactSensitiveJson|serializers:/);
    expect(sentryServer).toMatch(
      /redactSensitiveJson|stripeToken|stripe_token|access_token|refresh_token/
    );
    expect(sentryEdge).toMatch(
      /redactSensitiveJson|stripeToken|stripe_token|access_token|refresh_token/
    );
  });

  it("keeps the active Caddy upstream file consistent if reload fails", () => {
    const source = readRepoFile("scripts/run-production-blue-green-deploy.sh");
    const cutoverBlock = sliceFrom(source, 'step "16/19"', 'step "17/19"');
    const writeIndex = cutoverBlock.indexOf("write_active_upstream_file");
    const reloadIndex = cutoverBlock.indexOf("reload_caddy");
    const hasExplicitRestorePath =
      /restore.*upstream|previous.*upstream|original.*upstream/i.test(source);

    expect(writeIndex).toBeGreaterThan(-1);
    expect(reloadIndex).toBeGreaterThan(-1);
    expect(reloadIndex < writeIndex || hasExplicitRestorePath).toBe(true);
  });

  it("gates blue/green migrations with an explicit safety ledger", () => {
    const source = readRepoFile("scripts/run-production-blue-green-deploy.sh");
    const validator = readRepoFile("scripts/validate-blue-green-migrations.sh");
    const ledger = readRepoFile("docs/BLUE_GREEN_MIGRATION_SAFETY.tsv");

    expect(source).toContain("MIGRATION_SAFETY_LEDGER");
    expect(source).toContain("validate-blue-green-migrations.sh");
    expect(validator).toContain("HOT_TABLE_SQL_REGEX");
    expect(validator).toContain("lock impact plan");
    expect(ledger).toContain("old_code_compatible");
  });

  it("requires lock-impact documentation for hot-table migrations", () => {
    const fixture = createTempMigration(
      'ALTER TABLE "Payment" ADD COLUMN "processorReference" TEXT;\n',
      "# migration_name\tphase\tprevious_expand_release\told_code_compatible\tlock_impact_plan\n"
    );

    try {
      const result = runMigrationSafetyValidator(
        fixture.migrationPath,
        fixture.ledgerPath
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("missing");
      expect(result.stderr).toContain("blue/green migration safety review");
    } finally {
      rmSync(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it("allows documented hot-table expand migrations without breaking-SQL override", () => {
    const fixture = createTempMigration(
      'ALTER TABLE "Payment" ADD COLUMN "processorReference" TEXT;\n',
      [
        "# migration_name\tphase\tprevious_expand_release\told_code_compatible\tlock_impact_plan",
        "20990101000000_test_migration\texpand\tn/a\tyes\tAdds a nullable Payment column; run during low traffic and verify no long payment writes.",
      ].join("\n")
    );

    try {
      const result = runMigrationSafetyValidator(
        fixture.migrationPath,
        fixture.ledgerPath
      );

      expect(result.status).toBe(0);
    } finally {
      rmSync(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it("requires operator acknowledgement for documented destructive contract migrations", () => {
    const fixture = createTempMigration(
      'ALTER TABLE "Member" DROP COLUMN "legacyPhone";\n',
      [
        "# migration_name\tphase\tprevious_expand_release\told_code_compatible\tlock_impact_plan",
        "20990101000000_test_migration\tcontract\t20261201000000_member_phone_expand\tyes\tDrops a retired Member column after all runtime callers moved to structured phone fields.",
      ].join("\n")
    );

    try {
      const blocked = runMigrationSafetyValidator(
        fixture.migrationPath,
        fixture.ledgerPath
      );
      const allowed = runMigrationSafetyValidator(
        fixture.migrationPath,
        fixture.ledgerPath,
        {
          ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS: "1",
          BLUE_GREEN_MIGRATION_OVERRIDE_REASON:
            "contract phase verified against previous deployed runtime",
        }
      );

      expect(blocked.status).not.toBe(0);
      expect(blocked.stderr).toContain("ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS");
      expect(allowed.status).toBe(0);
    } finally {
      rmSync(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it(
    "passes a SET NOT NULL paired with a same-column non-NULL SET DEFAULT without an override (H4)",
    { timeout: 20000 },
    () => {
      // The multi-lodge contract migration (20260708001100) SET NOT NULL on
      // lodgeId while giving the same column a default_lodge_id() DEFAULT in the
      // same migration: an old (pre-lodge) colour's omitted-column INSERT gets
      // the default, so no null is written and the NOT NULL is old-code-safe. The
      // validator must treat that pairing as reviewed-safe (no ALLOW_BREAKING
      // override), while still requiring a well-formed ledger entry. LodgeRoom is
      // deliberately not a hot table, so no lock-impact plan is needed here.
      const fixture = createTempMigration(
        [
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET DEFAULT default_lodge_id();',
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET NOT NULL;',
          "",
        ].join("\n"),
        [
          LEDGER_HEADER,
          "20990101000000_test_migration\texpand\tn/a\tyes\tPaired same-column SET DEFAULT keeps old-colour inserts non-null; no row rewrite.",
        ].join("\n")
      );

      try {
        const result = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath
        );

        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toContain("Reviewed no-outage NOT NULL");
      } finally {
        rmSync(fixture.tempDir, { recursive: true, force: true });
      }
    }
  );

  it(
    "requires an override for an unmatched SET NOT NULL with no same-column SET DEFAULT (H4)",
    { timeout: 20000 },
    () => {
      const fixture = createTempMigration(
        'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET NOT NULL;\n',
        [
          LEDGER_HEADER,
          "20990101000000_test_migration\texpand\tn/a\tyes\tSET NOT NULL with no paired default; documented as breaking.",
        ].join("\n")
      );

      try {
        const blocked = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath
        );
        const allowed = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath,
          {
            ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS: "1",
            BLUE_GREEN_MIGRATION_OVERRIDE_REASON:
              "unmatched NOT NULL verified old-code compatible out of band",
          }
        );

        expect(blocked.status).not.toBe(0);
        expect(blocked.stderr).toContain("ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS");
        expect(blocked.stderr).not.toContain("Reviewed no-outage NOT NULL");
        expect(allowed.status).toBe(0);
      } finally {
        rmSync(fixture.tempDir, { recursive: true, force: true });
      }
    }
  );

  it(
    "requires an override for a RENAME COLUMN (H4)",
    { timeout: 20000 },
    () => {
      // RENAME hits the destructive-removal regex, so the ledger must record it
      // as phase=contract naming the previous expand release (mirrors the
      // DROP COLUMN fixture) before it can even reach the breaking-SQL gate.
      const fixture = createTempMigration(
        'ALTER TABLE "LodgeRoom" RENAME COLUMN "oldName" TO "name";\n',
        [
          LEDGER_HEADER,
          "20990101000000_test_migration\tcontract\t20261201000000_room_rename_expand\tyes\tRenames a retired column after all readers moved to the new name.",
        ].join("\n")
      );

      try {
        const blocked = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath
        );
        const allowed = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath,
          {
            ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS: "1",
            BLUE_GREEN_MIGRATION_OVERRIDE_REASON:
              "rename verified against previous deployed runtime",
          }
        );

        expect(blocked.status).not.toBe(0);
        expect(blocked.stderr).toContain("ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS");
        expect(allowed.status).toBe(0);
      } finally {
        rmSync(fixture.tempDir, { recursive: true, force: true });
      }
    }
  );

  it(
    "requires an override for an ALTER COLUMN ... TYPE change (H4)",
    { timeout: 20000 },
    () => {
      const fixture = createTempMigration(
        'ALTER TABLE "LodgeRoom" ALTER COLUMN "sortOrder" TYPE BIGINT;\n',
        [
          LEDGER_HEADER,
          "20990101000000_test_migration\texpand\tn/a\tyes\tWidens a column type; documented as breaking for blue/green.",
        ].join("\n")
      );

      try {
        const blocked = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath
        );
        const allowed = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath,
          {
            ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS: "1",
            BLUE_GREEN_MIGRATION_OVERRIDE_REASON:
              "type change verified compatible with both colours",
          }
        );

        expect(blocked.status).not.toBe(0);
        expect(blocked.stderr).toContain("ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS");
        expect(allowed.status).toBe(0);
      } finally {
        rmSync(fixture.tempDir, { recursive: true, force: true });
      }
    }
  );

  it(
    "rejects a SET NOT NULL paired only with SET DEFAULT NULL as vacuous (H4)",
    { timeout: 20000 },
    () => {
      // A SET DEFAULT NULL fills nothing, so an old colour's omitted-column
      // INSERT still lands a null and the NOT NULL would abort mid-cutover. The
      // pairing is vacuous: the NOT NULL must stay breaking (override required),
      // never quietly waived like a real non-null default.
      const fixture = createTempMigration(
        [
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET DEFAULT NULL;',
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET NOT NULL;',
          "",
        ].join("\n"),
        [
          LEDGER_HEADER,
          "20990101000000_test_migration\texpand\tn/a\tyes\tSET DEFAULT NULL does not backfill; NOT NULL stays breaking.",
        ].join("\n")
      );

      try {
        const blocked = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath
        );
        const allowed = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath,
          {
            ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS: "1",
            BLUE_GREEN_MIGRATION_OVERRIDE_REASON:
              "NULL-default NOT NULL accepted after out-of-band verification",
          }
        );

        expect(blocked.status).not.toBe(0);
        expect(blocked.stderr).toContain("ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS");
        expect(blocked.stderr).not.toContain("Reviewed no-outage NOT NULL");
        expect(allowed.status).toBe(0);
      } finally {
        rmSync(fixture.tempDir, { recursive: true, force: true });
      }
    }
  );

  it(
    "rejects a SET NOT NULL paired only with a cast-form SET DEFAULT NULL as vacuous (#1587 item 7)",
    { timeout: 20000 },
    () => {
      // A cast-wrapped NULL default still fills nothing, exactly like a bare
      // SET DEFAULT NULL: an old colour's omitted-column INSERT lands a null and
      // the NOT NULL aborts mid-cutover. The validator must normalise the cast away
      // and treat the pairing as vacuous (override required), not waive it as if the
      // cast made it a real non-null default. Both cast spellings named in the spec
      // are pinned: the tight "NULL::text" and the spaced/parenthesised
      // "NULL :: varchar(10)".
      const castDefaults = ["NULL::text", "NULL :: varchar(10)"];
      for (const castDefault of castDefaults) {
        const fixture = createTempMigration(
          [
            `ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET DEFAULT ${castDefault};`,
            'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET NOT NULL;',
            "",
          ].join("\n"),
          [
            LEDGER_HEADER,
            "20990101000000_test_migration\texpand\tn/a\tyes\tCast-form NULL default does not backfill; NOT NULL stays breaking.",
          ].join("\n")
        );

        try {
          const blocked = runMigrationSafetyValidator(
            fixture.migrationPath,
            fixture.ledgerPath
          );
          const allowed = runMigrationSafetyValidator(
            fixture.migrationPath,
            fixture.ledgerPath,
            {
              ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS: "1",
              BLUE_GREEN_MIGRATION_OVERRIDE_REASON:
                "cast-NULL-default NOT NULL accepted after out-of-band verification",
            }
          );

          expect(blocked.status, `${castDefault}: ${blocked.stderr}`).not.toBe(0);
          expect(blocked.stderr).toContain("ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS");
          expect(blocked.stderr).not.toContain("Reviewed no-outage NOT NULL");
          expect(allowed.status).toBe(0);
        } finally {
          rmSync(fixture.tempDir, { recursive: true, force: true });
        }
      }
    }
  );

  it(
    "rejects a SET NOT NULL whose last same-column SET DEFAULT resets to NULL (last-wins, #1587 item 7)",
    { timeout: 20000 },
    () => {
      // A non-null SET DEFAULT followed by a SET DEFAULT NULL on the same column
      // leaves the effective default NULL (last-wins). The earlier non-null value
      // must NOT waive the NOT NULL: an old colour's omitted-column INSERT still
      // lands a null once the reset applies. The validator must judge only the
      // final default, so the pairing stays vacuous (override required).
      const fixture = createTempMigration(
        [
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET DEFAULT \'seed-lodge\';',
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET DEFAULT NULL;',
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET NOT NULL;',
          "",
        ].join("\n"),
        [
          LEDGER_HEADER,
          "20990101000000_test_migration\texpand\tn/a\tyes\tLast SET DEFAULT resets to NULL; NOT NULL stays breaking.",
        ].join("\n")
      );

      try {
        const blocked = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath
        );
        const allowed = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath,
          {
            ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS: "1",
            BLUE_GREEN_MIGRATION_OVERRIDE_REASON:
              "last-wins-NULL NOT NULL accepted after out-of-band verification",
          }
        );

        expect(blocked.status).not.toBe(0);
        expect(blocked.stderr).toContain("ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS");
        expect(blocked.stderr).not.toContain("Reviewed no-outage NOT NULL");
        expect(allowed.status).toBe(0);
      } finally {
        rmSync(fixture.tempDir, { recursive: true, force: true });
      }
    }
  );

  it(
    "waives a SET NOT NULL whose last same-column SET DEFAULT is non-NULL (last-wins, #1587 item 7)",
    { timeout: 20000 },
    () => {
      // A SET DEFAULT NULL followed by a non-null SET DEFAULT on the same column
      // leaves the effective default non-null (last-wins): an old colour's
      // omitted-column INSERT gets the real default, so no null is written and the
      // NOT NULL is old-code-safe. The validator must waive it (reviewed no-outage,
      // no override) just like a single non-null default — the earlier NULL reset
      // must not over-correct into a false breaking flag.
      const fixture = createTempMigration(
        [
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET DEFAULT NULL;',
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET DEFAULT \'seed-lodge\';',
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET NOT NULL;',
          "",
        ].join("\n"),
        [
          LEDGER_HEADER,
          "20990101000000_test_migration\texpand\tn/a\tyes\tLast SET DEFAULT is non-null; old-colour inserts stay non-null.",
        ].join("\n")
      );

      try {
        const result = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath
        );

        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toContain("Reviewed no-outage NOT NULL");
      } finally {
        rmSync(fixture.tempDir, { recursive: true, force: true });
      }
    }
  );

  it(
    "rejects a SET NOT NULL whose default is cleared by a trailing DROP DEFAULT (#1602 gap 1)",
    { timeout: 20000 },
    () => {
      // A non-null SET DEFAULT, then SET NOT NULL, then DROP DEFAULT on the same
      // column leaves the column with NO default: an old colour's omitted-column
      // INSERT lands a null and the NOT NULL aborts mid-cutover. The trailing DROP
      // DEFAULT is the effective final default statement (last-wins across SET and
      // DROP), so the pairing is vacuous and must stay breaking (override required).
      // This waived on the pre-#1602 script, which only inspected SET DEFAULT.
      const fixture = createTempMigration(
        [
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET DEFAULT \'seed-lodge\';',
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET NOT NULL;',
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" DROP DEFAULT;',
          "",
        ].join("\n"),
        [
          LEDGER_HEADER,
          "20990101000000_test_migration\texpand\tn/a\tyes\tTrailing DROP DEFAULT clears the default; NOT NULL stays breaking.",
        ].join("\n")
      );

      try {
        const blocked = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath
        );
        const allowed = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath,
          {
            ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS: "1",
            BLUE_GREEN_MIGRATION_OVERRIDE_REASON:
              "dropped-default NOT NULL accepted after out-of-band verification",
          }
        );

        expect(blocked.status, blocked.stderr).not.toBe(0);
        expect(blocked.stderr).toContain("ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS");
        expect(blocked.stderr).not.toContain("Reviewed no-outage NOT NULL");
        expect(allowed.status).toBe(0);
      } finally {
        rmSync(fixture.tempDir, { recursive: true, force: true });
      }
    }
  );

  it(
    "waives a SET NOT NULL whose DROP DEFAULT precedes a later non-NULL SET DEFAULT (#1602 gap 1)",
    { timeout: 20000 },
    () => {
      // A DROP DEFAULT followed by a non-null SET DEFAULT on the same column leaves
      // the effective default non-null (last-wins): an old colour's omitted-column
      // INSERT gets the real default, so no null is written and the NOT NULL is
      // old-code-safe. An earlier DROP DEFAULT must not over-correct into a false
      // breaking flag — the validator waives it (reviewed no-outage, no override).
      const fixture = createTempMigration(
        [
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" DROP DEFAULT;',
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET DEFAULT \'seed-lodge\';',
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET NOT NULL;',
          "",
        ].join("\n"),
        [
          LEDGER_HEADER,
          "20990101000000_test_migration\texpand\tn/a\tyes\tLast SET DEFAULT is non-null despite an earlier DROP DEFAULT.",
        ].join("\n")
      );

      try {
        const result = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath
        );

        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toContain("Reviewed no-outage NOT NULL");
      } finally {
        rmSync(fixture.tempDir, { recursive: true, force: true });
      }
    }
  );

  it(
    "rejects a SET NOT NULL whose SET DEFAULT NULL hides behind a trailing comment (#1602 gap 2)",
    { timeout: 20000 },
    () => {
      // "SET DEFAULT NULL; -- reset" is a vacuous NULL default, but the trailing
      // comment defeats the end-anchored NULL check on the pre-#1602 script, so it
      // waived. The comment must be stripped before classification so the pairing
      // is recognised as vacuous and stays breaking (override required).
      const fixture = createTempMigration(
        [
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET DEFAULT NULL; -- reset',
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET NOT NULL;',
          "",
        ].join("\n"),
        [
          LEDGER_HEADER,
          "20990101000000_test_migration\texpand\tn/a\tyes\tCommented SET DEFAULT NULL is still vacuous; NOT NULL stays breaking.",
        ].join("\n")
      );

      try {
        const blocked = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath
        );
        const allowed = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath,
          {
            ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS: "1",
            BLUE_GREEN_MIGRATION_OVERRIDE_REASON:
              "commented NULL-default NOT NULL accepted after out-of-band verification",
          }
        );

        expect(blocked.status, blocked.stderr).not.toBe(0);
        expect(blocked.stderr).toContain("ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS");
        expect(blocked.stderr).not.toContain("Reviewed no-outage NOT NULL");
        expect(allowed.status).toBe(0);
      } finally {
        rmSync(fixture.tempDir, { recursive: true, force: true });
      }
    }
  );

  it(
    "waives a SET NOT NULL whose non-NULL default carries a trailing comment, with a quoted -- kept intact (#1602 gap 2)",
    { timeout: 20000 },
    () => {
      // Comment stripping must not corrupt classification of a genuine non-null
      // default: "SET DEFAULT 'x'; -- note" still waives. It also must NOT strip a
      // "--" inside a single-quoted string literal ("SET DEFAULT 'a--b'"), which
      // stays a non-null default and waives — proving the common quoted-string case
      // the spec calls out.
      for (const sql of [
        'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET DEFAULT \'seed-lodge\'; -- note',
        "ALTER TABLE \"LodgeRoom\" ALTER COLUMN \"lodgeId\" SET DEFAULT 'a--b';",
      ]) {
        const fixture = createTempMigration(
          [
            sql,
            'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET NOT NULL;',
            "",
          ].join("\n"),
          [
            LEDGER_HEADER,
            "20990101000000_test_migration\texpand\tn/a\tyes\tNon-null default with a comment / quoted dashes stays a real backfill.",
          ].join("\n")
        );

        try {
          const result = runMigrationSafetyValidator(
            fixture.migrationPath,
            fixture.ledgerPath
          );

          expect(result.status, `${sql}: ${result.stderr}`).toBe(0);
          expect(result.stderr).toContain("Reviewed no-outage NOT NULL");
        } finally {
          rmSync(fixture.tempDir, { recursive: true, force: true });
        }
      }
    }
  );

  it(
    "rejects a SET NOT NULL paired with a semantically-NULL default expression (#1602 gap 3)",
    { timeout: 20000 },
    () => {
      // CAST(NULL AS <type>) and a parenthesised (NULL) are semantically NULL: they
      // fill nothing, so an old colour's omitted-column INSERT lands a null and the
      // NOT NULL aborts. The pre-#1602 script only recognised a bare NULL after
      // SET DEFAULT, so these spellings waived. They must now be recognised as NULL
      // and stay breaking (override required). NULLIF(...) is deliberately out of
      // scope and is covered by the non-NULL waiver test below.
      const nullSpellings = [
        "CAST(NULL AS text)",
        "CAST(NULL AS varchar(10))",
        "(NULL)",
        "(NULL)::text",
        "( NULL )",
      ];
      for (const spelling of nullSpellings) {
        const fixture = createTempMigration(
          [
            `ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET DEFAULT ${spelling};`,
            'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET NOT NULL;',
            "",
          ].join("\n"),
          [
            LEDGER_HEADER,
            "20990101000000_test_migration\texpand\tn/a\tyes\tSemantically-NULL default does not backfill; NOT NULL stays breaking.",
          ].join("\n")
        );

        try {
          const blocked = runMigrationSafetyValidator(
            fixture.migrationPath,
            fixture.ledgerPath
          );
          const allowed = runMigrationSafetyValidator(
            fixture.migrationPath,
            fixture.ledgerPath,
            {
              ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS: "1",
              BLUE_GREEN_MIGRATION_OVERRIDE_REASON:
                "semantic-NULL-default NOT NULL accepted after out-of-band verification",
            }
          );

          expect(blocked.status, `${spelling}: ${blocked.stderr}`).not.toBe(0);
          expect(blocked.stderr).toContain("ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS");
          expect(blocked.stderr).not.toContain("Reviewed no-outage NOT NULL");
          expect(allowed.status).toBe(0);
        } finally {
          rmSync(fixture.tempDir, { recursive: true, force: true });
        }
      }
    }
  );

  it(
    "waives a SET NOT NULL whose default is a NULLIF(...) expression, kept non-NULL by design (#1602 gap 3)",
    { timeout: 20000 },
    () => {
      // NULLIF(x, x) is semantically NULL, but SQL expression analysis is out of
      // scope: the validator classifies it as a non-NULL default and waives. This
      // pins the documented choice so a future change that starts recognising it
      // does so deliberately, not by accident.
      const fixture = createTempMigration(
        [
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET DEFAULT NULLIF(\'a\', \'a\');',
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET NOT NULL;',
          "",
        ].join("\n"),
        [
          LEDGER_HEADER,
          "20990101000000_test_migration\texpand\tn/a\tyes\tNULLIF default classifies as non-NULL by documented choice.",
        ].join("\n")
      );

      try {
        const result = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath
        );

        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toContain("Reviewed no-outage NOT NULL");
      } finally {
        rmSync(fixture.tempDir, { recursive: true, force: true });
      }
    }
  );

  it(
    "waives a lowercase SET NOT NULL paired with a lowercase non-NULL SET DEFAULT (#1602 gap 4)",
    { timeout: 20000 },
    () => {
      // The table/column extraction is now case-insensitive on keywords, so a
      // lowercase safe pairing gets the same waiver as its uppercase form. On the
      // pre-#1602 script the case-sensitive sed extraction returned empty, so the
      // waiver branch was skipped and this BLOCKED — this is the intended
      // block->waive flip that proves fix 4.
      const fixture = createTempMigration(
        [
          'alter table "LodgeRoom" alter column "lodgeId" set default \'seed-lodge\';',
          'alter table "LodgeRoom" alter column "lodgeId" set not null;',
          "",
        ].join("\n"),
        [
          LEDGER_HEADER,
          "20990101000000_test_migration\texpand\tn/a\tyes\tLowercase paired default keeps old-colour inserts non-null.",
        ].join("\n")
      );

      try {
        const result = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath
        );

        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toContain("Reviewed no-outage NOT NULL");
      } finally {
        rmSync(fixture.tempDir, { recursive: true, force: true });
      }
    }
  );

  it(
    "requires an override for a lowercase unmatched SET NOT NULL (#1602 gap 4)",
    { timeout: 20000 },
    () => {
      // Case-insensitive extraction must not soften a genuinely breaking lowercase
      // NOT NULL: with no same-column SET DEFAULT it stays breaking (override
      // required), exactly like its uppercase counterpart. This blocks on both the
      // pre- and post-#1602 script, but for different reasons — before because the
      // extraction failed and it fell through, now because the pairing is genuinely
      // unmatched — so it is a guard, not a closed evasion.
      const fixture = createTempMigration(
        'alter table "LodgeRoom" alter column "lodgeId" set not null;\n',
        [
          LEDGER_HEADER,
          "20990101000000_test_migration\texpand\tn/a\tyes\tLowercase SET NOT NULL with no paired default; documented as breaking.",
        ].join("\n")
      );

      try {
        const blocked = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath
        );
        const allowed = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath,
          {
            ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS: "1",
            BLUE_GREEN_MIGRATION_OVERRIDE_REASON:
              "lowercase unmatched NOT NULL verified old-code compatible out of band",
          }
        );

        expect(blocked.status, blocked.stderr).not.toBe(0);
        expect(blocked.stderr).toContain("ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS");
        expect(blocked.stderr).not.toContain("Reviewed no-outage NOT NULL");
        expect(allowed.status).toBe(0);
      } finally {
        rmSync(fixture.tempDir, { recursive: true, force: true });
      }
    }
  );

  it(
    "passes the committed multi-lodge NOT NULL migration override-free against the real ledger (H4)",
    { timeout: 20000 },
    () => {
      // Reviewer reproduction, CI-enforced: run the REAL file on disk (never a
      // copy) through the validator with the REAL ledger and NO override. The
      // paired same-column default_lodge_id() DEFAULT must keep it override-free,
      // so the migration header's "deploy with ALLOW_BREAKING" note stays wrong
      // and can never silently drift back to true.
      const realMigrationPath = path.resolve(
        process.cwd(),
        "prisma/migrations/20260708001100_multi_lodge_entity_lodge_id_not_null/migration.sql"
      );
      const realLedgerPath = path.resolve(
        process.cwd(),
        "docs/BLUE_GREEN_MIGRATION_SAFETY.tsv"
      );

      const result = runMigrationSafetyValidator(
        realMigrationPath,
        realLedgerPath
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("Reviewed no-outage NOT NULL");
    }
  );

  it("flags hot-table trigger operations in the blue/green validator", () => {
    // #1359 (finding F8): 20260704100000 ran DROP TRIGGER / CREATE CONSTRAINT
    // TRIGGER on hot tables Booking/BookingGuest, but the validator's hot-table
    // regex did not cover TRIGGER operations, so it passed the deploy gate with
    // no ledger entry. The regex must now require a ledger entry for them.
    const missing = createTempMigration(
      'DROP TRIGGER "Booking_dates_consistent_with_guests" ON "Booking";\n',
      `${LEDGER_HEADER}\n`
    );
    try {
      const result = runMigrationSafetyValidator(
        missing.migrationPath,
        missing.ledgerPath
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("blue/green migration safety review");
    } finally {
      rmSync(missing.tempDir, { recursive: true, force: true });
    }

    const documented = createTempMigration(
      'DROP TRIGGER "Booking_dates_consistent_with_guests" ON "Booking";\n',
      [
        LEDGER_HEADER,
        "20990101000000_test_migration\texpand\tn/a\tyes\tSwaps a Booking trigger for a deferred constraint trigger; brief lock, no row scan.",
      ].join("\n")
    );
    try {
      const result = runMigrationSafetyValidator(
        documented.migrationPath,
        documented.ledgerPath
      );
      expect(result.status).toBe(0);
    } finally {
      rmSync(documented.tempDir, { recursive: true, force: true });
    }
  });

  it(
    "keeps the committed migration tree covered by the blue/green safety ledger",
    // Shells out over the full committed migration tree; under a loaded
    // parallel suite run this regularly exceeds the default 5s.
    { timeout: 20000 },
    () => {
      // Regression guard for #1359: the real prisma/migrations tree + real ledger
      // must pass the PR-time coverage gate (both backfilled rows present, and no
      // new duplicate timestamp prefix beyond the grandfathered set).
      const result = runMigrationSafetyCoverage();
      expect(result.status, result.stderr).toBe(0);
    },
  );

  it("fails ledger coverage when a hot-table migration at/after baseline is unledgered", () => {
    const fixture = createTempMigrationsTree(
      [
        {
          name: "20990101000000_unledgered_hot",
          sql: 'ALTER TABLE "Payment" ADD COLUMN "processorRef" TEXT;\n',
        },
      ],
      [LEDGER_HEADER, "20260507000000_base\texpand\tn/a\tyes\tbaseline row"].join(
        "\n"
      )
    );
    try {
      const result = runMigrationSafetyCoverage({
        MIGRATIONS_DIR: fixture.migrationsDir,
        MIGRATION_SAFETY_LEDGER: fixture.ledgerPath,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Ledger coverage check FAILED");
    } finally {
      rmSync(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it("fails the timestamp ratchet when a new migration reuses a timestamp prefix", () => {
    const fixture = createTempMigrationsTree(
      [
        { name: "20990101000000_alpha", sql: 'CREATE TABLE "Foo" ("id" TEXT);\n' },
        { name: "20990101000000_beta", sql: 'CREATE TABLE "Bar" ("id" TEXT);\n' },
      ],
      [LEDGER_HEADER, "20260507000000_base\texpand\tn/a\tyes\tbaseline row"].join(
        "\n"
      )
    );
    try {
      const result = runMigrationSafetyCoverage({
        MIGRATIONS_DIR: fixture.migrationsDir,
        MIGRATION_SAFETY_LEDGER: fixture.ledgerPath,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Timestamp hygiene check FAILED");
    } finally {
      rmSync(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it("remaps the darkest neutral text tier so the door code is legible in dark mode (F28)", () => {
    // #1371 F28: the lodge door code renders text-slate-950 on a dark card, but
    // the dark neutral remap only covered the -900/-800..-300 tiers, leaving -950
    // near-black on dark. The -950 tier must map to --foreground.
    const globals = readRepoFile("src/app/globals.css");
    const foregroundRemap = sliceFrom(
      globals,
      ".text-slate-950",
      "color: var(--foreground)",
    );
    expect(foregroundRemap).toContain(".text-gray-950");
    expect(foregroundRemap).toContain(".text-neutral-950");
    expect(foregroundRemap).toContain(".text-stone-950");
  });

  it("gives the promo review-step callout a dark-mode text colour (F28)", () => {
    const reviewStep = readRepoFile(
      "src/app/(authenticated)/book/_components/review-step.tsx",
    );
    expect(reviewStep).toContain("text-brand-charcoal dark:text-brand-gold");
    expect(reviewStep).toContain("text-brand-charcoal/75 dark:text-brand-gold/75");
  });

  it("hard-reloads the waitlist confirm success path so the CTA can't stick on Confirming (F28)", () => {
    const card = readRepoFile("src/components/waitlist-offer-card.tsx");
    // On success a full document reload re-renders the page from the server, so
    // the CTA can never stay stuck on "Confirming…" waiting on a soft refresh
    // that raced the re-render. No useRouter import means no soft router.refresh.
    expect(card).toContain("window.location.reload()");
    expect(card).not.toContain("useRouter");
  });

  it("hard-reloads the internet-banking switch success path so the IB card renders deterministically (F28)", () => {
    const button = readRepoFile(
      "src/components/switch-to-internet-banking-button.tsx",
    );
    // A fresh server render cannot show the pre-switch layout once payment.source
    // is INTERNET_BANKING, so a hard reload is deterministic where the soft
    // refresh raced (#1148). No useRouter import means no soft router.refresh.
    expect(button).toContain("window.location.reload()");
    expect(button).not.toContain("useRouter");
  });

  it("guards the public quote cancel behind a confirmation dialog (F28)", () => {
    const respondPage = readRepoFile(
      "src/app/(public)/booking-requests/respond/[token]/page.tsx",
    );
    expect(respondPage).toContain("useConfirm");
    expect(respondPage).toContain("cancelWithConfirmation");
    // The one-click destructive path must be gone.
    expect(respondPage).not.toContain('onClick={() => respond("CANCEL")}');
  });

  it("surfaces the booking status glossary and cancellation schedule to members (F28)", () => {
    const contextualHelp = readRepoFile("src/lib/contextual-help.ts");
    expect(contextualHelp).toContain("export const BOOKING_STATUS_GLOSSARY");
    // Admin help still renders the same shared glossary (no divergent copy).
    expect(contextualHelp).toContain("details: BOOKING_STATUS_GLOSSARY,");

    const helpDialog = readRepoFile("src/components/booking-help-dialog.tsx");
    expect(helpDialog).toContain("BOOKING_STATUS_GLOSSARY");
    expect(helpDialog).toContain("Cancellation refund schedule");
    // An unpaid-but-cancellable booking must not imply a refund it can't get
    // (owner review of PR #1389): say no payment received / no refund instead.
    expect(helpDialog).toContain(
      "No payment has been received for this booking, so no refund",
    );

    const bookingDetail = readRepoFile(
      "src/app/(authenticated)/bookings/[id]/page.tsx",
    );
    expect(bookingDetail).toContain("<BookingHelpDialog");
    expect(bookingDetail).toContain("describeCancellationSchedule");
    // The refund schedule is gated on a captured payment; unpaid bookings get the
    // no-refund message instead.
    expect(bookingDetail).toContain("originalPaymentCaptured");
    expect(bookingDetail).toContain("cancellationHasNoPayment");
  });

  it("removes the E2E ride-through allowances for the two fixed races (F28)", () => {
    // The components now hard-reload on success, so the specs assert the
    // freshly-rendered server state directly — no reload-retry ride-through loop
    // in the spec masking a soft-refresh race.
    const waitlistSpec = readRepoFile("e2e/waitlist.spec.ts");
    expect(waitlistSpec).not.toContain("assert the durable server state via reload");
    expect(waitlistSpec).not.toContain("await memberPage.reload()");
    expect(waitlistSpec).toContain("await expect(offerCard).toHaveCount(0, { timeout: 30_000 })");

    const ibSpec = readRepoFile("e2e/internet-banking.spec.ts");
    expect(ibSpec).not.toContain(
      "Assert the whole post-switch card atomically per",
    );
    expect(ibSpec).not.toContain("await page.reload()");
  });
});
