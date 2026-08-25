import { after, NextRequest, NextResponse } from "next/server";
import { hostingCoverageParticipantRetryResponse } from "@/lib/adult-member-hosting-retry-response";
import { isHostingCoverageParticipantRetry } from "@/lib/adult-member-hosting-queue-participants";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import {
  createXeroContactForMember,
  findPotentialXeroContactsForMember,
  flushMemberSubscriptionHistory,
  syncMemberSubscriptionHistoryForLinkedContact,
  XeroContactCreatePartialSuccessError,
  XeroContactValidationError,
} from "@/lib/xero";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { buildXeroContactUrl } from "@/lib/xero-links";
import { getXeroOrgShortCode } from "@/lib/xero-link-short-code";
import { z } from "zod";
import { getXeroApiErrorInfo } from "@/lib/xero-api-errors";
import { clubTimeZone } from "@/lib/club-time/server";
import { clubSeasonYear } from "@/lib/financial-year";
import {
  enqueueXeroEntranceFeeInvoiceOperation,
  processQueuedXeroOutboxOperations,
} from "@/lib/xero-operation-outbox";
import {
  createdContactRecovery,
  xeroPartialSuccessBody,
} from "@/lib/xero-partial-success";
import {
  assertMemberAvailableForXeroContactChange,
  XERO_CONTACT_CREATE_IN_PROGRESS_CODE,
  XERO_MEMBER_UNAVAILABLE_CODE,
  XeroContactAlreadyLinkedError,
  XeroContactCreateInProgressError,
  XeroMemberUnavailableError,
} from "@/lib/xero-contact-create-recovery";

const pushSchema = z.object({
  createEntranceFeeInvoice: z.boolean().optional().default(false),
  entranceFeeInvoiceDecision: z.enum(["CREATE", "SKIP"]).optional(),
  entranceFeeInvoiceSkipReason: z.string().trim().max(500).optional().nullable(),
  entranceFeeInvoiceAmountCents: z.number().int().positive().max(1_000_000).optional(),
  entranceFeeInvoiceNarration: z.string().trim().max(500).optional().nullable(),
  forceCreate: z.boolean().optional().default(false),
});

function scheduleAfterResponse(task: () => Promise<void>) {
  try {
    after(task);
  } catch {
    queueMicrotask(() => {
      void task();
    });
  }
}

/**
 * POST /api/admin/members/[id]/xero-push
 * Create a new Xero contact for this member and link them.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const { id } = await params;

  const member = await prisma.member.findUnique({
    where: { id },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      passwordHash: true,
      xeroContactId: true,
    },
  });
  if (!member) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  try {
    assertMemberAvailableForXeroContactChange(member);
  } catch (err) {
    if (err instanceof XeroMemberUnavailableError) {
      return NextResponse.json(
        { error: err.message, code: XERO_MEMBER_UNAVAILABLE_CODE },
        { status: err.statusCode },
      );
    }
    throw err;
  }

  if (member.xeroContactId) {
    return NextResponse.json({ error: "Member already linked to Xero" }, { status: 409 });
  }

  let createdXeroContactId: string | null = null;
  let subscriptionRefreshPending = false;
  try {
    let body: unknown = {};
    const rawBody = await req.text();
    if (rawBody.trim()) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
      }
    }

    const parsed = pushSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    const entranceFeeDecision = parsed.data.entranceFeeInvoiceDecision;
    const createEntranceFeeInvoice =
      entranceFeeDecision === "CREATE" ||
      (!entranceFeeDecision && parsed.data.createEntranceFeeInvoice);
    const entranceFeeSkipReason =
      parsed.data.entranceFeeInvoiceSkipReason?.trim() || null;
    const entranceFeeNarration =
      parsed.data.entranceFeeInvoiceNarration?.trim() || null;

    if (entranceFeeDecision === "SKIP" && !entranceFeeSkipReason) {
      return NextResponse.json(
        { error: "A reason is required when not raising the joining fee invoice." },
        { status: 422 }
      );
    }

    if (!parsed.data.forceCreate) {
      const suggestedContacts = await findPotentialXeroContactsForMember(id);
      if (suggestedContacts.length > 0) {
        return NextResponse.json(
          {
            error:
              "Potential matching Xero contacts already exist. Link one of those contacts or confirm that you want to create a new contact anyway.",
            suggestedContacts,
          },
          { status: 409 }
        );
      }
    }

    const xeroContactId = await createXeroContactForMember(id, {
      createdByMemberId: session.user.id,
    });
    createdXeroContactId = xeroContactId;
    subscriptionRefreshPending = true;
    const flushedSubscriptionHistory = await flushMemberSubscriptionHistory(id);

    let entranceFeeInvoiceQueued = false;
    let entranceFeeInvoiceMessage: string | undefined;
    let warning: string | undefined;

    try {
      const seasonYearsToRefresh =
        flushedSubscriptionHistory.seasonYears.length > 0
          ? [
              clubSeasonYear(await clubTimeZone()),
              ...flushedSubscriptionHistory.seasonYears,
            ]
          : undefined;
      const subscriptionSync =
        await syncMemberSubscriptionHistoryForLinkedContact(id, {
          seasonYears: seasonYearsToRefresh,
          forceRefreshOnlineInvoiceUrl: true,
        });

      subscriptionRefreshPending = subscriptionSync.errors.length > 0;

      if (subscriptionSync.errors.length > 0) {
        warning =
          "Xero contact created, but subscription history refresh did not complete for every season. Run the Member Status Repair Backfill to retry.";
        logger.warn(
          {
            memberId: id,
            xeroContactId,
            seasonYears: subscriptionSync.seasonYears,
            errors: subscriptionSync.errors,
          },
          "Subscription history refresh completed with errors after creating Xero contact"
        );
      }
    } catch (historyErr) {
      if (isHostingCoverageParticipantRetry(historyErr)) {
        throw historyErr;
      }
      warning =
        "Xero contact created, but subscription history refresh did not complete. Run the Member Status Repair Backfill to retry.";
      subscriptionRefreshPending = true;
      logger.warn(
        {
          err: historyErr,
          memberId: id,
          xeroContactId,
          flushedSubscriptionHistory,
        },
        "Failed to refresh member subscription history after creating Xero contact"
      );
    }

    if (createEntranceFeeInvoice) {
      try {
        const entranceFeeInvoiceOptions: {
          createdByMemberId: string;
          amountCents?: number;
          description?: string;
        } = {
          createdByMemberId: session.user.id,
        };
        if (parsed.data.entranceFeeInvoiceAmountCents) {
          entranceFeeInvoiceOptions.amountCents =
            parsed.data.entranceFeeInvoiceAmountCents;
        }
        if (entranceFeeNarration) {
          entranceFeeInvoiceOptions.description = entranceFeeNarration;
        }

        const queuedEntranceFeeInvoice =
          await enqueueXeroEntranceFeeInvoiceOperation(id, {
            ...entranceFeeInvoiceOptions,
            // No transaction here, so the enqueue would resolve the club's zone
            // itself — but this route already holds it, React-cached for the
            // render pass, so pass the season rather than paying for a second
            // uncached read (#2870, correctness review).
            seasonYear: clubSeasonYear(await clubTimeZone()),
          });

        entranceFeeInvoiceQueued = Boolean(
          queuedEntranceFeeInvoice.queueOperationId
        );
        entranceFeeInvoiceMessage = queuedEntranceFeeInvoice.message;

        if (queuedEntranceFeeInvoice.queueOperationId) {
          scheduleAfterResponse(async () => {
            try {
              await processQueuedXeroOutboxOperations({ limit: 1 });
            } catch (xeroErr) {
              logger.error(
                { err: xeroErr, memberId: id },
                "Failed to kick Xero entrance fee outbox worker after contact creation"
              );
            }
          });
        }
      } catch (xeroErr) {
        logger.error(
          { err: xeroErr, memberId: id },
          "Failed to queue entrance fee invoice after contact creation"
        );
        const entranceFeeWarning =
          "Xero contact created, but joining fee invoice could not be queued. Retry from the member's Xero actions.";
        warning = warning ? `${warning} ${entranceFeeWarning}` : entranceFeeWarning;
      }
    } else if (entranceFeeSkipReason) {
      await logAudit({
        action: "XERO_ENTRANCE_FEE_INVOICE_SKIPPED",
        memberId: session.user.id,
        targetId: id,
        subjectMemberId: id,
        entityType: "Member",
        entityId: id,
        category: "xero",
        outcome: "success",
        summary: "Joining fee invoice skipped",
        details: entranceFeeSkipReason,
        metadata: {
          reason: entranceFeeSkipReason,
          source: "member-xero-push",
        },
      });
    }

    await logAudit({
      action: "XERO_PUSH",
      memberId: session.user.id,
      targetId: id,
      subjectMemberId: id,
      entityType: "Member",
      entityId: id,
      category: "xero",
      outcome: "success",
      summary: "Member pushed to Xero",
      details: `Created Xero contact ${xeroContactId}`,
      metadata: {
        xeroContactId,
        entranceFeeInvoiceQueued,
        entranceFeeInvoiceMessage: entranceFeeInvoiceMessage ?? null,
        entranceFeeInvoiceSkippedReason: entranceFeeSkipReason,
        flushedSubscriptionHistoryCount:
          flushedSubscriptionHistory.deletedCount,
      },
    });

    logger.info({ memberId: id, xeroContactId }, "Pushed member to Xero as new contact");

    return NextResponse.json({
      xeroContactId,
      // #2314: organisation-scoped, so the admin who just pushed lands in this
      // club's Xero rather than whichever organisation their session last used.
      xeroLink: buildXeroContactUrl(xeroContactId, {
        shortCode: await getXeroOrgShortCode(),
      }),
      entranceFeeInvoiceQueued,
      entranceFeeInvoiceMessage,
      ...(warning ? { warning } : {}),
    });
  } catch (err) {
    const helperPartial =
      err instanceof XeroContactCreatePartialSuccessError ? err : null;
    const recovery = helperPartial
      ? createdContactRecovery(
          helperPartial.xeroContactId,
          helperPartial.phase === "LOCAL_MEMBER_LINK_COMMITTED",
          helperPartial.phase === "LOCAL_MEMBER_LINK_COMMITTED",
        )
      : createdXeroContactId
        ? createdContactRecovery(
            createdXeroContactId,
            true,
            subscriptionRefreshPending,
          )
        : null;
    const memberScopedRecovery = recovery
      ? { ...recovery, memberId: id }
      : null;
    const sourceError = helperPartial?.originalError ?? err;
    const hostingRetry = hostingCoverageParticipantRetryResponse(
      sourceError,
      memberScopedRecovery ? { ...memberScopedRecovery } : undefined,
    );
    if (hostingRetry) return hostingRetry;
    if (memberScopedRecovery) {
      logger.error(
        {
          err: sourceError,
          memberId: id,
          recoveryKind: memberScopedRecovery.recoveryKind,
        },
        "Xero contact creation completed only in part",
      );
      return NextResponse.json(xeroPartialSuccessBody(memberScopedRecovery), {
        status: 409,
      });
    }
    if (err instanceof XeroContactValidationError) {
      return NextResponse.json(
        {
          error: `Complete these fields before creating in Xero: ${err.missingFields.join(", ")}`,
          missingFields: err.missingFields,
        },
        { status: 422 }
      );
    }
    if (err instanceof XeroContactAlreadyLinkedError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    if (err instanceof XeroContactCreateInProgressError) {
      return NextResponse.json(
        { error: err.message, code: XERO_CONTACT_CREATE_IN_PROGRESS_CODE },
        { status: err.statusCode },
      );
    }
    if (err instanceof XeroMemberUnavailableError) {
      return NextResponse.json(
        { error: err.message, code: XERO_MEMBER_UNAVAILABLE_CODE },
        { status: err.statusCode },
      );
    }

    const xeroError = getXeroApiErrorInfo(err, "Failed to create Xero contact");
    if (!xeroError.handled) {
      logger.error(
        { err, memberId: id, xeroDiagnosticMessage: xeroError.diagnosticMessage },
        "Error pushing member to Xero"
      );
    }
    return NextResponse.json({ error: xeroError.clientMessage }, { status: xeroError.status });
  }
}
