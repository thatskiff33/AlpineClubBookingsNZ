import { revalidatePath } from "next/cache";
import { ADMIN_MEMBER_DETAIL_ROUTE_PATTERN } from "@/lib/page-route-patterns";
import { NextRequest, NextResponse } from "next/server";
import { hostingCoverageParticipantRetryResponse } from "@/lib/adult-member-hosting-retry-response";
import { z } from "zod";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";
import {
  applyManualSubscriptionPayment,
  ManualSubscriptionPaymentError,
  MANUAL_PAYMENT_NOTE_MAX,
} from "@/lib/manual-subscription-payment";

const bodySchema = z
  .object({
    direction: z.enum(["paid", "unpaid"]),
    note: z.string().max(MANUAL_PAYMENT_NOTE_MAX).optional().nullable(),
    // Explicit confirmation so a manual money-state change is never a
    // single-click accident.
    confirmed: z.literal(true),
    // #2260: the admin's "email the member or not" decision. Shape-checked
    // here, contract-checked below — see the 422 branch.
    notifyMember: z.boolean().optional(),
  })
  .strict();

/**
 * POST /api/admin/subscriptions/[id]/manual-payment
 *
 * Manually mark a member subscription paid (direction: "paid") or reverse a
 * prior manual mark-paid (direction: "unpaid"). Gated finance:edit. Audited.
 * NEVER calls Xero and NEVER creates or voids an invoice.
 *
 * #2260 notifyMember contract (422 either way it is broken):
 *  - direction "paid" REQUIRES notifyMember. It is a real choice with a real
 *    consequence — a member gets a payment receipt or does not — so absent must
 *    not silently mean either. An ambiguous call is refused rather than guessed.
 *  - direction "unpaid" REJECTS notifyMember. A reversal emails nobody, so
 *    accepting the field would let a caller believe it had asked for something.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid manual payment request.", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { direction, notifyMember } = parsed.data;
  if (direction === "paid" && notifyMember === undefined) {
    return NextResponse.json(
      {
        error:
          "Say whether the member should be emailed: notifyMember is required when marking a subscription paid.",
      },
      { status: 422 },
    );
  }
  if (direction === "unpaid" && notifyMember !== undefined) {
    return NextResponse.json(
      {
        error:
          "Reversing a manual payment never emails the member, so notifyMember cannot be sent with direction \"unpaid\".",
      },
      { status: 422 },
    );
  }

  try {
    const result = await applyManualSubscriptionPayment(
      direction === "paid"
        ? {
            subscriptionId: id,
            direction: "paid",
            note: parsed.data.note ?? null,
            actingMemberId: guard.session.user.id,
            notifyMember: notifyMember === true,
          }
        : {
            subscriptionId: id,
            direction: "unpaid",
            note: parsed.data.note ?? null,
            actingMemberId: guard.session.user.id,
          },
    );
    revalidatePath("/admin/subscriptions");
    revalidatePath(ADMIN_MEMBER_DETAIL_ROUTE_PATTERN, "page");
    return NextResponse.json({
      success: true,
      subscription: result,
      // #2260: report what became of the receipt, never a delivery claim the
      // code cannot make. "queued" means the mailer accepted it — a suppressed
      // recipient, a club-internal placeholder address or an outright failure
      // all come back as not_delivered and say so, so an admin is never left
      // believing a member was told when they were not.
      message:
        result.direction === "paid"
          ? result.receipt === "queued"
            ? "Subscription marked paid. A receipt is being emailed to the member."
            : result.receipt === "not_delivered"
              ? "Subscription marked paid, but the receipt could not be sent — check the member's email address."
              : "Subscription marked paid. The member was not emailed."
          : "Manual payment reversed.",
    });
  } catch (error) {
    const hostingRetry = hostingCoverageParticipantRetryResponse(error);
    if (hostingRetry) return hostingRetry;
    if (error instanceof ManualSubscriptionPaymentError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error({ err: error, subscriptionId: id }, "Manual subscription payment failed");
    return NextResponse.json(
      { error: "Manual subscription payment failed." },
      { status: 500 },
    );
  }
}
