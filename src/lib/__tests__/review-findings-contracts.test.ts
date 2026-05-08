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
    const source = readRepoFile("src/app/api/bookings/route.ts");
    const draftBlock = sliceFrom(
      source,
      "if (draft) {",
      "const allMembers = !hasNonMembers;"
    );

    expect(draftBlock).toContain("prisma.$transaction");
    expect(draftBlock).toContain("pg_advisory_xact_lock(1)");
    expect(draftBlock).toContain("tx.booking.create");
    expect(draftBlock).toMatch(/redeemPromoCode\(\s*tx,/);
    expect(draftBlock).not.toContain("prisma.booking.create");
    expect(draftBlock).not.toMatch(/redeemPromoCode\(\s*prisma,/);
  });

  it("wraps waitlist booking creation in a transaction instead of standalone Prisma writes", () => {
    const source = readRepoFile("src/app/api/bookings/route.ts");
    const createWaitlistedBookingBlock = sliceFrom(
      source,
      "async function createWaitlistedBooking",
      "return NextResponse.json(newBooking, { status: 201 });"
    );

    expect(createWaitlistedBookingBlock).toContain("prisma.$transaction");
    expect(createWaitlistedBookingBlock).toContain("pg_advisory_xact_lock(1)");
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
    const stripeWebhook = readRepoFile("src/app/api/webhooks/stripe/route.ts");

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

    expect(schema).not.toContain(
      'booking      Booking              @relation(fields: [bookingId], references: [id], onDelete: Cascade)'
    );
    expect(schema).not.toContain(
      'member           Member                        @relation(fields: [memberId], references: [id], onDelete: Cascade)'
    );
    expect(schema).not.toContain(
      'member         Member        @relation("AdminCreditAdjustmentTarget", fields: [memberId], references: [id], onDelete: Cascade)'
    );
    expect(schema).not.toContain(
      'booking Booking @relation(fields: [bookingId], references: [id], onDelete: Cascade)'
    );
    expect(schema).not.toContain(
      'member  Member  @relation(fields: [memberId], references: [id], onDelete: Cascade)'
    );
  });

  it("serializes stale waitlist-offer expiry and re-offer selection behind a transaction", () => {
    const source = readRepoFile("src/lib/waitlist.ts");
    const expireStaleOffersBlock = sliceFrom(
      source,
      "export async function expireStaleOffers",
      "/**\n * Recalculate and update waitlistPosition"
    );

    expect(expireStaleOffersBlock).toContain("prisma.$transaction");
    expect(expireStaleOffersBlock).toContain("pg_advisory_xact_lock");
  });

  it("adds rotation-aware metadata for finance Xero token encryption", () => {
    const schema = readRepoFile("prisma/schema.prisma");
    const tokenStore = readRepoFile("src/lib/finance-xero-token-store.ts");

    expect(`${schema}\n${tokenStore}`).toMatch(
      /keyVersion|keyId|encryptionKeyVersion/
    );
    expect(tokenStore).toMatch(
      /previousKey|oldKey|candidateKeys|decryptWith|fallback/i
    );
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
    const source = readRepoFile("scripts/blue-green-deploy.sh");
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
    const source = readRepoFile("scripts/blue-green-deploy.sh");
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
});
