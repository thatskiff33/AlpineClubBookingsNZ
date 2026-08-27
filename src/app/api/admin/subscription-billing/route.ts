import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAuditLog } from "@/lib/audit";
import { DEFAULT_FAMILY_BILLING_MODE, FAMILY_BILLING_MODES } from "@/lib/authoritative-fees";
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

const querySchema = z.object({
  seasonYear: z.coerce.number().int().min(2020).max(2040).optional(),
  decisionDate: z.string().optional(),
});
const mutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("CONFIRM_ANNUAL_BATCH"),
    seasonYear: z.number().int().min(2020).max(2040),
    decisionDate: z.string(),
    confirmationToken: z.string().length(64),
    confirmed: z.literal(true),
  }).strict(),
  z.object({ action: z.literal("RETRY_CHARGE"), chargeId: z.string().min(1) }).strict(),
  // #2148 (D2): edit-gated preview refresh. Reconciles stale persisted
  // exceptions (auto-resolves any OPEN row the fresh whole-club preview no
  // longer regenerates) and returns the refreshed billing data. The read-only
  // GET never mutates; this action is the documented way stale rows clear.
  z.object({
    action: z.literal("REFRESH_PREVIEW"),
    seasonYear: z.number().int().min(2020).max(2040),
    decisionDate: z.string(),
  }).strict(),
  z.object({
    action: z.literal("UPDATE_SETTINGS"),
    invoiceDueDays: z.number().int().min(1).max(365),
    // Optional so the existing due-days save path stays a single-field write;
    // when present it switches the club-level family billing model.
    familyBillingMode: z.enum(FAMILY_BILLING_MODES).optional(),
  }).strict(),
  // #2161 (D2): operator "already invoiced" family marker. MARK creates an active
  // marker; UNMARK sets releasedAt (row retained for audit). Both finance:edit
  // gated (the POST guard) and idempotent.
  z.object({
    action: z.literal("MARK_FAMILY_INVOICED"),
    seasonYear: z.number().int().min(2020).max(2040),
    familyGroupId: z.string().min(1),
    note: z.string().max(500).optional(),
  }).strict(),
  z.object({
    action: z.literal("UNMARK_FAMILY_INVOICED"),
    seasonYear: z.number().int().min(2020).max(2040),
    familyGroupId: z.string().min(1),
  }).strict(),
]);

function invalidate() {
  revalidatePath("/admin/subscriptions");
  revalidatePath("/admin/stuck-states");
  revalidatePath("/admin/members/[id]", "page");
}

// Build the panel payload (preview + durable charge queue + persisted-only
// exceptions + settings) for a season/decision date. Shared by the read-only
// GET and the edit-gated REFRESH_PREVIEW action so both return the same shape.
// Pure reads only — any exception reconciliation is done by the caller BEFORE
// this loads, so the GET stays a non-mutating view (#2148 constraint 3).
async function loadBillingData(seasonYear: number, decisionDate: Date) {
  const [preview, charges, exceptions, settings] = await Promise.all([
    buildSubscriptionBillingPreview({ seasonYear, decisionDate }),
    prisma.membershipSubscriptionCharge.findMany({
      where: { seasonYear },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { coverage: { select: { memberId: true, memberName: true } } },
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
  return {
    preview,
    charges,
    exceptions: visiblePersistentExceptions,
    settings: {
      invoiceDueDays: settings?.invoiceDueDays ?? 30,
      familyBillingMode: settings?.familyBillingMode ?? DEFAULT_FAMILY_BILLING_MODE,
    },
  };
}

export async function GET(request: NextRequest) {
  const guard = await requireAdmin({ permission: { area: "finance", level: "view" } });
  if (!guard.ok) return guard.response;
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
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
    return NextResponse.json(await loadBillingData(seasonYear, decisionDate));
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
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400 }); }
  const parsed = mutationSchema.safeParse(body);
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
      return NextResponse.json({ success: true, ...result });
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
      return NextResponse.json({
        success: true,
        message: created ? "Family marked as already invoiced for this season." : "Family is already marked as invoiced.",
      });
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
      return NextResponse.json({
        success: true,
        message: released.count > 0 ? "Family marker removed; it can be billed again." : "Family was not marked as invoiced.",
      });
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
      return NextResponse.json({
        success: true,
        message: reconciled.resolvedCount > 0
          ? `Preview refreshed. ${reconciled.resolvedCount} stale exception${reconciled.resolvedCount === 1 ? "" : "s"} auto-resolved.`
          : "Preview refreshed.",
        reconciledCount: reconciled.resolvedCount,
        ...data,
      });
    }
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
    const queued = await Promise.all(result.chargeIds.map((chargeId) =>
      enqueueMembershipSubscriptionChargeOperation(chargeId, { createdByMemberId: guard.session.user.id })));
    invalidate();
    return NextResponse.json({
      success: true,
      message: `${result.chargeIds.length} immutable charge${result.chargeIds.length === 1 ? "" : "s"} created; ${result.exceptionCount} exception${result.exceptionCount === 1 ? "" : "s"} recorded.`,
      ...result,
      queued,
    });
  } catch (error) {
    if (error instanceof SubscriptionBillingError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    logger.error({ err: error }, "Subscription billing action failed");
    return NextResponse.json(
      { error: "Subscription billing action failed." },
      { status: 500 }
    );
  }
}
