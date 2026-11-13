import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  approveMemberApplication,
  MembershipApplicationError,
  rejectMemberApplication,
} from "@/lib/nomination";
import { personDecisionsSchema } from "@/lib/member-application-decisions";
import { requireAdmin } from "@/lib/session-guards";
import {
  TRANSACTION_CONTENDED_STATUS_CHECK_MESSAGE,
  transactionContendedResponse,
} from "@/lib/transaction-contended-response";
import logger from "@/lib/logger";

const entranceFeeInvoiceDecisionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("CREATE"),
    amountCents: z.number().int().positive().max(1_000_000).optional().nullable(),
    narration: z.string().trim().max(500).optional().nullable(),
  }),
  z.object({
    action: z.literal("SKIP"),
    reason: z.string().trim().min(3).max(500),
  }),
]);

const reviewSchema = z
  .object({
    decision: z.enum(["APPROVE", "REJECT"]),
    adminNotes: z.string().max(4000).optional().nullable(),
    entranceFeeInvoiceDecision: entranceFeeInvoiceDecisionSchema.optional().nullable(),
    // #1786: admin per-action email choice. Absent/undefined = notify (default);
    // false = suppress the applicant-facing approved/rejected notice. A
    // non-boolean fails this parse and falls out as the route's 422 validation
    // response. This route is requireAdmin-gated, so the flag is admin-only.
    notifyMember: z.boolean().optional(),
    // E10 (#1936): per-person map-to-existing decisions + the preview token that
    // binds this approval to the previewed outcome. Absent = all-CREATE =
    // byte-identical current behavior; the token is required iff any decision is
    // MAP (enforced in approveMemberApplication).
    personDecisions: personDecisionsSchema.optional().nullable(),
    mappingPreviewToken: z.string().min(1).optional().nullable(),
  })
  // Reject unknown keys so a typo'd/mis-nested mapping payload (e.g.
  // `mappingToken`) fails loudly as a 422 instead of silently approving
  // all-CREATE without the intended mapping.
  .strict();

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Explicit membership:edit requirement (matches the approval-preview route)
  // rather than relying on route-map inference: this PUT overwrites member
  // records when mapping, so its permission gate must be self-evident.
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const parsed = reviewSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      },
      { status: 422 }
    );
  }

  try {
    if (parsed.data.decision === "APPROVE") {
      const result = await approveMemberApplication(
        id,
        session.user.id,
        parsed.data.adminNotes,
        parsed.data.entranceFeeInvoiceDecision,
        parsed.data.notifyMember,
        parsed.data.personDecisions,
        parsed.data.mappingPreviewToken
      );

      return NextResponse.json({
        success: true,
        status: result.application.status,
        applicantMemberId: result.applicantMember.id,
        createdMemberIds: result.createdMemberIds,
        mappedMemberIds: result.mappedMemberIds,
        warnings: result.warnings,
      });
    }

    const result = await rejectMemberApplication(
      id,
      session.user.id,
      parsed.data.adminNotes,
      parsed.data.notifyMember
    );

    return NextResponse.json({
      success: true,
      status: result.status,
    });
  } catch (err) {
    if (err instanceof MembershipApplicationError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }

    const contended = transactionContendedResponse(
      err,
      "Membership application review contended for a transaction budget",
      { message: TRANSACTION_CONTENDED_STATUS_CHECK_MESSAGE, context: { applicationId: id } },
    );
    if (contended) return contended;
    logger.error({ err, applicationId: id }, "Unexpected error reviewing membership application");
    return NextResponse.json(
      { error: "Could not review the membership application right now" },
      { status: 500 }
    );
  }
}
