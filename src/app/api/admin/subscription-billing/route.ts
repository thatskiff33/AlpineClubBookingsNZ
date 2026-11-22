import { revalidateAdminPage } from "@/lib/admin-page-revalidation";
import { NextRequest, NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";
import { createAuditLog } from "@/lib/audit";
import { DEFAULT_FAMILY_BILLING_MODE } from "@/lib/authoritative-fees";
import {
  SUBSCRIPTION_BILLING_ANNUAL_BATCH_CONFIRMED_CONNECTION_SHAPE,
  SUBSCRIPTION_BILLING_CHARGE_CLOSED_CONNECTION_SHAPE,
  SUBSCRIPTION_BILLING_CHARGE_RETRIED_CONNECTION_SHAPE,
  SUBSCRIPTION_BILLING_CONNECTION_SHAPE,
  SUBSCRIPTION_BILLING_FAMILY_MARKER_CONNECTION_SHAPE,
  SUBSCRIPTION_BILLING_REFRESHED_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/finance-money";
import { connectionJson } from "@/lib/mcp-connection-request";
import {
  subscriptionBillingMutationSchema,
  subscriptionBillingQuerySchema,
} from "@/lib/subscription-billing-request-schemas";
import { dateOnlyInstantOf } from "@/lib/club-time";
import { clubTime } from "@/lib/club-time/server";
import { isDateOnlyString, parseDateOnly } from "@/lib/date-only";
import {
  buildSubscriptionBillingPreview,
  confirmSubscriptionBillingPreview,
  reconcileSubscriptionBillingExceptions,
  SubscriptionBillingError,
} from "@/lib/membership-subscription-billing";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { seasonYearOfStoredDate } from "@/lib/financial-year";
import { refreshFinancialYearConfig } from "@/lib/financial-year-server";
import { enqueueMembershipSubscriptionChargeOperation } from "@/lib/xero-subscription-invoices";
import { assertSubscriptionInvoicingEnabled, isXeroInvoicingEnabled } from "@/lib/xero-invoicing-guard";
import { XERO_SWITCHED_OFF_DURING_CONFIRM_MESSAGE, XeroInvoicingOffError } from "@/lib/xero-invoicing-off";
import {
  closeAlreadyPaidSubscriptionCharge,
  CloseAlreadyPaidChargeError,
} from "@/lib/membership-subscription-charge-close";

// Charges whose invoice the Xero outbox still has to raise or email.
const CHARGE_STATUSES_AWAITING_XERO = ["QUEUED", "PROCESSING", "INVOICE_CREATED"] as const;

function invalidate() {
  revalidateAdminPage("subscriptions");
  revalidateAdminPage("stuck-states");
  revalidateAdminPage("member-detail");
}

// Build the panel payload (preview + durable charge queue + persisted-only
// exceptions + settings) for a season/decision date. Shared by the read-only
// GET and the edit-gated REFRESH_PREVIEW action so both return the same shape.
// Pure reads only — any exception reconciliation is done by the caller BEFORE
// this loads, so the GET stays a non-mutating view (#2148 constraint 3).
async function loadBillingData(seasonYear: number, decisionDate: Date) {
  const xeroInvoicingEnabled = await isXeroInvoicingEnabled();
  const [preview, charges, exceptions, settings] = await Promise.all([
    buildSubscriptionBillingPreview({ seasonYear, decisionDate, xeroInvoicingOff: !xeroInvoicingEnabled }),
    prisma.membershipSubscriptionCharge.findMany({
      where: { seasonYear },
      orderBy: { createdAt: "desc" },
      take: 100,
      // #4098: releasedAt and the subscription's status let the panel offer Close
      // only when every ACTIVE covered subscription is settled (PAID or NOT_REQUIRED).
      include: { coverage: { select: { memberId: true, memberName: true, releasedAt: true, subscription: { select: { status: true } } } } },
    }),
    prisma.membershipBillingException.findMany({
      where: { seasonYear, status: "OPEN" },
      orderBy: { lastSeenAt: "desc" },
      take: 100,
    }),
    prisma.membershipSubscriptionBillingSettings.findUnique({ where: { id: "default" } }),
  ]);
  const previewFingerprints = new Set(preview.exceptions.map((item) => item.fingerprint));
  const visiblePersistentExceptions = exceptions.filter(
    (item) => !previewFingerprints.has(item.fingerprint)
  );
  // #4986: with Xero off nothing can be invoiced, so the panel explains that
  // instead of confirming, and counts the season's charges whose invoice is
  // still waiting to be raised or sent: they go out when Xero is switched back
  // on, so the officer sees them first. Only counted while off.
  const awaitingXeroCount = xeroInvoicingEnabled
    ? 0
    : await prisma.membershipSubscriptionCharge.count({
        where: { seasonYear, status: { in: [...CHARGE_STATUSES_AWAITING_XERO] } },
      });
  return {
    preview,
    charges,
    exceptions: visiblePersistentExceptions,
    xeroInvoicing: { enabled: xeroInvoicingEnabled, awaitingXeroCount },
    settings: {
      invoiceDueDays: settings?.invoiceDueDays ?? 30,
      familyBillingMode: settings?.familyBillingMode ?? DEFAULT_FAMILY_BILLING_MODE,
    },
  };
}

export async function GET(request: NextRequest) {
  const guard = await requireAdmin({ permission: { area: "finance", level: "view" } });
  if (!guard.ok) return guard.response;
  const parsed = subscriptionBillingQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: "Invalid billing preview query." }, { status: 400 });
  // No explicit decision date means "today": the club's calendar day from the PERSISTED
  // timezone (CT-4, #2870), as the UTC-midnight value an explicit date parses to.
  const decisionDate = parsed.data.decisionDate
    ? (isDateOnlyString(parsed.data.decisionDate) ? parseDateOnly(parsed.data.decisionDate) : null)
    : dateOnlyInstantOf((await clubTime()).today());
  if (!decisionDate) return NextResponse.json({ error: "Decision date must be YYYY-MM-DD." }, { status: 400 });
  // `decisionDate` is now a UTC-midnight encoding of a calendar day — either the
  // club's own today (minted above) or an explicit `YYYY-MM-DD` — so the season
  // comes from the DAY, with no zone. Reading it with host-local getters, which is
  // what the retired `getSeasonYear` did, put the whole of 1 April in the previous
  // season for any host behind Greenwich (CT-4, #2870).
  const seasonYear =
    parsed.data.seasonYear ?? seasonYearOfStoredDate(decisionDate);
  try {
    return connectionJson(request, await loadBillingData(seasonYear, decisionDate), SUBSCRIPTION_BILLING_CONNECTION_SHAPE);
  } catch (error) {
    if (error instanceof SubscriptionBillingError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    logger.error({ err: error }, "Could not build subscription billing preview");
    return NextResponse.json(
      { error: "Could not build subscription billing preview." },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  const guard = await requireAdmin({ permission: { area: "finance", level: "edit" } });
  if (!guard.ok) return guard.response;
  const jsonBody = await parseJsonRequestBody(request, { error: "Invalid JSON." });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;
  const parsed = subscriptionBillingMutationSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid subscription billing action.", details: parsed.error.flatten() }, { status: 400 });
  try {
    if (parsed.data.action === "UPDATE_SETTINGS") {
      const action = parsed.data;
      // Only write familyBillingMode when the client sent it, so a plain
      // due-days save never disturbs the mode (and vice versa). A create falls
      // back to the schema default when the mode is absent.
      const settingsFields = {
        invoiceDueDays: action.invoiceDueDays,
        ...(action.familyBillingMode ? { familyBillingMode: action.familyBillingMode } : {}),
        updatedByMemberId: guard.session.user.id,
      };
      await prisma.$transaction(async (tx) => {
        await tx.membershipSubscriptionBillingSettings.upsert({
          where: { id: "default" },
          update: settingsFields,
          create: { id: "default", ...settingsFields },
        });
        await createAuditLog({
          action: "membership-subscription-billing.settings.update",
          category: "payment",
          memberId: guard.session.user.id,
          targetId: "default",
          details: JSON.stringify({
            invoiceDueDays: action.invoiceDueDays,
            ...(action.familyBillingMode ? { familyBillingMode: action.familyBillingMode } : {}),
          }),
        }, tx);
      });
      invalidate();
      return NextResponse.json({
        success: true,
        message: action.familyBillingMode ? "Subscription billing settings updated." : "Subscription invoice due days updated.",
      });
    }
    if (parsed.data.action === "RETRY_CHARGE") {
      await assertSubscriptionInvoicingEnabled();
      const result = await enqueueMembershipSubscriptionChargeOperation(parsed.data.chargeId, { createdByMemberId: guard.session.user.id });
      await createAuditLog({
        action: "membership-subscription-billing.retry",
        category: "payment",
        entityType: "MembershipSubscriptionCharge",
        entityId: parsed.data.chargeId,
        memberId: guard.session.user.id,
        targetId: parsed.data.chargeId,
        details: JSON.stringify(result),
      });
      invalidate();
      return connectionJson(request, { success: true, ...result }, SUBSCRIPTION_BILLING_CHARGE_RETRIED_CONNECTION_SHAPE);
    }
    if (parsed.data.action === "CLOSE_ALREADY_PAID") {
      // The service writes its own audit row inside the close's transaction,
      // and none for an idempotent repeat.
      const result = await closeAlreadyPaidSubscriptionCharge({
        chargeId: parsed.data.chargeId,
        reason: parsed.data.reason,
        actorMemberId: guard.session.user.id,
      });
      invalidate();
      return connectionJson(request, { success: true, ...result }, SUBSCRIPTION_BILLING_CHARGE_CLOSED_CONNECTION_SHAPE);
    }
    if (parsed.data.action === "MARK_FAMILY_INVOICED") {
      // #2161 (D2): mark a family as already invoiced for the season, suppressing
      // its PER_FAMILY charge regardless of the D1 auto-detection. Idempotent: a
      // second mark on an already-active family is a no-op success (no audit row),
      // and a concurrent double-mark is caught by the partial unique index.
      const { seasonYear, familyGroupId, note } = parsed.data;
      const family = await prisma.familyGroup.findUnique({ where: { id: familyGroupId }, select: { id: true } });
      if (!family) return NextResponse.json({ error: "Family group not found." }, { status: 404 });
      const trimmedNote = note?.trim() ? note.trim() : null;
      let created = false;
      try {
        await prisma.$transaction(async (tx) => {
          const existing = await tx.familyGroupSeasonInvoiceMarker.findFirst({
            where: { familyGroupId, seasonYear, releasedAt: null },
            select: { id: true },
          });
          if (existing) return;
          await tx.familyGroupSeasonInvoiceMarker.create({
            data: { familyGroupId, seasonYear, note: trimmedNote, markedByMemberId: guard.session.user.id },
          });
          created = true;
        });
      } catch (error) {
        // A concurrent mark lost the race to the partial unique index — the family
        // is now marked either way, so the action is idempotently satisfied.
        if (!(error && typeof error === "object" && "code" in error && error.code === "P2002")) throw error;
      }
      if (created) {
        await createAuditLog({
          action: "membership-subscription-billing.mark-family",
          category: "payment",
          entityType: "FamilyGroup",
          entityId: familyGroupId,
          memberId: guard.session.user.id,
          targetId: familyGroupId,
          details: JSON.stringify({ seasonYear, note: trimmedNote }),
        });
      }
      invalidate();
      return connectionJson(request, {
        success: true,
        message: created ? "Family marked as already invoiced for this season." : "Family is already marked as invoiced.",
      }, SUBSCRIPTION_BILLING_FAMILY_MARKER_CONNECTION_SHAPE);
    }
    if (parsed.data.action === "UNMARK_FAMILY_INVOICED") {
      // #2161 (D2): release the active marker (row retained for audit). Idempotent:
      // releasing a family with no active marker is a no-op success (no audit row).
      const { seasonYear, familyGroupId } = parsed.data;
      const released = await prisma.familyGroupSeasonInvoiceMarker.updateMany({
        where: { familyGroupId, seasonYear, releasedAt: null },
        data: { releasedAt: new Date(), releasedByMemberId: guard.session.user.id },
      });
      if (released.count > 0) {
        await createAuditLog({
          action: "membership-subscription-billing.unmark-family",
          category: "payment",
          entityType: "FamilyGroup",
          entityId: familyGroupId,
          memberId: guard.session.user.id,
          targetId: familyGroupId,
          details: JSON.stringify({ seasonYear, released: released.count }),
        });
      }
      invalidate();
      return connectionJson(request, {
        success: true,
        message: released.count > 0 ? "Family marker removed; it can be billed again." : "Family was not marked as invoiced.",
      }, SUBSCRIPTION_BILLING_FAMILY_MARKER_CONNECTION_SHAPE);
    }
    if (parsed.data.action === "REFRESH_PREVIEW") {
      if (!isDateOnlyString(parsed.data.decisionDate)) {
        return NextResponse.json({ error: "Decision date must be YYYY-MM-DD." }, { status: 400 });
      }
      const decisionDate = parseDateOnly(parsed.data.decisionDate);
      const seasonYear = parsed.data.seasonYear;
      // Reconcile stale persisted exceptions FIRST (the only mutation), then load
      // the refreshed view so the response reflects the auto-resolved rows.
      // Resolved out here, not inside the reconcile transaction: with no admin
      // override this reads the organisation's accounting year from Xero, and a
      // provider call under the season's advisory lock is forbidden (#3116).
      const yearEndMonth = await refreshFinancialYearConfig();
      const reconciled = await reconcileSubscriptionBillingExceptions({ seasonYear, decisionDate, yearEndMonth });
      if (reconciled.resolvedCount > 0) {
        await createAuditLog({
          action: "membership-subscription-billing.reconcile",
          category: "payment",
          memberId: guard.session.user.id,
          targetId: String(seasonYear),
          details: JSON.stringify(reconciled),
        });
      }
      const data = await loadBillingData(seasonYear, decisionDate);
      invalidate();
      return connectionJson(request, {
        success: true,
        message: reconciled.resolvedCount > 0
          ? `Preview refreshed. ${reconciled.resolvedCount} stale exception${reconciled.resolvedCount === 1 ? "" : "s"} auto-resolved.`
          : "Preview refreshed.",
        reconciledCount: reconciled.resolvedCount,
        ...data,
      }, SUBSCRIPTION_BILLING_REFRESHED_CONNECTION_SHAPE);
    }
    // CONFIRM_ANNUAL_BATCH. #4986: refused while Xero is off BEFORE the confirm
    // writes, because its charges are immutable and the enqueue below would be
    // too late to stop them (`INV-INT-040`).
    await assertSubscriptionInvoicingEnabled();
    if (!isDateOnlyString(parsed.data.decisionDate)) {
      return NextResponse.json({ error: "Decision date must be YYYY-MM-DD." }, { status: 400 });
    }
    const preview = await buildSubscriptionBillingPreview({
      seasonYear: parsed.data.seasonYear,
      decisionDate: parseDateOnly(parsed.data.decisionDate),
    });
    if (preview.confirmationToken !== parsed.data.confirmationToken) {
      return NextResponse.json({ error: "Billing configuration changed after preview. Review the refreshed preview before confirming." }, { status: 409 });
    }
    const result = await confirmSubscriptionBillingPreview({
      preview,
      expectedConfirmationToken: parsed.data.confirmationToken,
      source: "ANNUAL_BATCH",
      confirmedByMemberId: guard.session.user.id,
    });
    const createdMessage = `${result.chargeIds.length} immutable charge${result.chargeIds.length === 1 ? "" : "s"} created; ${result.exceptionCount} exception${result.exceptionCount === 1 ? "" : "s"} recorded.`;
    let queued: Awaited<ReturnType<typeof enqueueMembershipSubscriptionChargeOperation>>[];
    try {
      queued = await Promise.all(result.chargeIds.map((chargeId) =>
        enqueueMembershipSubscriptionChargeOperation(chargeId, { createdByMemberId: guard.session.user.id })));
    } catch (error) {
      if (!(error instanceof XeroInvoicingOffError)) throw error;
      // #4986 review: Xero was switched off after the check above but before the
      // enqueue. The charges and their outbox rows are already committed, so
      // say so truthfully rather than answer "refused" (`INV-INT-040`).
      invalidate();
      return connectionJson(request, {
        success: true,
        message: `${createdMessage} ${XERO_SWITCHED_OFF_DURING_CONFIRM_MESSAGE}`,
        ...result,
        queued: [],
        xeroSwitchedOffDuringConfirm: true,
      }, SUBSCRIPTION_BILLING_ANNUAL_BATCH_CONFIRMED_CONNECTION_SHAPE);
    }
    invalidate();
    return connectionJson(request, {
      success: true,
      message: createdMessage,
      ...result,
      queued,
    }, SUBSCRIPTION_BILLING_ANNUAL_BATCH_CONFIRMED_CONNECTION_SHAPE);
  } catch (error) {
    if (error instanceof SubscriptionBillingError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof XeroInvoicingOffError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof CloseAlreadyPaidChargeError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error({ err: error }, "Subscription billing action failed");
    return NextResponse.json(
      { error: "Subscription billing action failed." },
      { status: 500 }
    );
  }
}
