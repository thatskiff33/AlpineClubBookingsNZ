import { after, NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import {
  createXeroContactForMember,
  findPotentialXeroContactsForMember,
  flushMemberSubscriptionHistory,
  syncMemberSubscriptionHistoryForLinkedContact,
  XeroContactValidationError,
} from "@/lib/xero";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { buildXeroContactUrl } from "@/lib/xero-links";
import { z } from "zod";
import { getXeroApiErrorInfo } from "@/lib/xero-api-errors";
import { getSeasonYear } from "@/lib/utils";
import {
  enqueueXeroEntranceFeeInvoiceOperation,
  processQueuedXeroOutboxOperations,
} from "@/lib/xero-operation-outbox";

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
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id } = await params;

  const member = await prisma.member.findUnique({
    where: { id },
    select: { id: true, firstName: true, lastName: true, email: true, xeroContactId: true },
  });
  if (!member) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  if (member.xeroContactId) {
    return NextResponse.json({ error: "Member already linked to Xero" }, { status: 409 });
  }

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
        { error: "A reason is required when not raising the entrance fee invoice." },
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

    const flushedSubscriptionHistory = await flushMemberSubscriptionHistory(id);
    const xeroContactId = await createXeroContactForMember(id, {
      createdByMemberId: session.user.id,
    });

    let entranceFeeInvoiceQueued = false;
    let entranceFeeInvoiceMessage: string | undefined;
    let warning: string | undefined;

    try {
      const seasonYearsToRefresh =
        flushedSubscriptionHistory.seasonYears.length > 0
          ? [
              getSeasonYear(new Date()),
              ...flushedSubscriptionHistory.seasonYears,
            ]
          : undefined;
      const subscriptionSync =
        await syncMemberSubscriptionHistoryForLinkedContact(id, {
          seasonYears: seasonYearsToRefresh,
          forceRefreshOnlineInvoiceUrl: true,
        });

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
      warning =
        "Xero contact created, but subscription history refresh did not complete. Run the Member Status Repair Backfill to retry.";
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
          await enqueueXeroEntranceFeeInvoiceOperation(
            id,
            entranceFeeInvoiceOptions
          );

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
        const entranceFeeWarning = `Xero contact created, but entrance fee invoice could not be queued: ${
          xeroErr instanceof Error ? xeroErr.message : String(xeroErr)
        }`;
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
        summary: "Entrance fee invoice skipped",
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
      xeroLink: buildXeroContactUrl(xeroContactId),
      entranceFeeInvoiceQueued,
      entranceFeeInvoiceMessage,
      ...(warning ? { warning } : {}),
    });
  } catch (err) {
    if (err instanceof XeroContactValidationError) {
      return NextResponse.json(
        {
          error: `Complete these fields before creating in Xero: ${err.missingFields.join(", ")}`,
          missingFields: err.missingFields,
        },
        { status: 422 }
      );
    }

    const xeroError = getXeroApiErrorInfo(err, "Failed to create Xero contact");
    if (!xeroError.handled) {
      logger.error({ err, memberId: id }, "Error pushing member to Xero");
    }
    return NextResponse.json({ error: xeroError.message }, { status: xeroError.status });
  }
}
