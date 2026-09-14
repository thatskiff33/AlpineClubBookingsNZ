import { NextRequest, NextResponse } from "next/server";
import { hostingCoverageParticipantRetryResponse } from "@/lib/adult-member-hosting-retry-response";
import { isHostingCoverageParticipantRetry } from "@/lib/adult-member-hosting-queue-participants";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import {
  callXeroApi,
  flushMemberSubscriptionHistory,
  getAuthenticatedXeroClient,
  refreshXeroContactCachesFromContact,
  syncMemberSubscriptionHistoryForLinkedContact,
} from "@/lib/xero";
import { logAudit } from "@/lib/audit";
import { getXeroApiErrorInfo } from "@/lib/xero-api-errors";
import logger from "@/lib/logger";
import { z } from "zod";
import { buildXeroContactUrl } from "@/lib/xero-links";
import { getXeroOrgShortCode } from "@/lib/xero-link-short-code";
import { clubTimeZone } from "@/lib/club-time/server";
import { clubSeasonYear } from "@/lib/financial-year";
import {
  linkedContactRecovery,
  xeroPartialSuccessBody,
} from "@/lib/xero-partial-success";
import {
  assertMemberAvailableForXeroContactChange,
  XERO_CONTACT_CREATE_IN_PROGRESS_CODE,
  XERO_MEMBER_UNAVAILABLE_CODE,
  XeroContactCreateInProgressError,
  XeroMemberUnavailableError,
} from "@/lib/xero-contact-create-recovery";
import { commitManualXeroContactLink } from "@/lib/xero-manual-contact-link";
import {
  assertXeroContactHasNoOtherHome,
  findXeroContactHomes,
  XeroContactTwoHomesError,
} from "@/lib/xero-contact-home";

const linkSchema = z.object({
  xeroContactId: z.string().min(1),
});

/**
 * POST /api/admin/members/[id]/xero-link
 * Link a member to an existing Xero contact.
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

  let body: unknown;
  let memberLinkCommitted = false;
  let subscriptionRefreshPending = false;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = linkSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "xeroContactId is required" }, { status: 400 });
  }

  try {
    /*
      WHO ALREADY HOLDS THIS CONTACT — asked FIRST, and answered by the rules
      that own the question rather than by a reader of my own.

      This used to be a single `member.findFirst` over the member table alone,
      run AFTER the provider round trip below. Two things were wrong with that.
      Since #3366 a Xero contact can be held by an ORGANISATION as well — a
      school's own customer — so an officer linking a member to a school's
      contact sailed past this friendly refusal, spent a `getContact` on a link
      that could never be made, and then met the raw two-homes error from the
      commit. And even for the member case it was a second opinion on which
      columns count as a local home, which is the drift `INV-INT-018` exists to
      stop. The invariant itself never broke — enforcement is downstream and
      symmetric — but the explanation an officer got was wrong.

      The ORGANISATION half runs `assertXeroContactHasNoOtherHome`, which is the
      SAME refusal `commitManualXeroContactLink` raises under the contact-home
      lock, so the early message and the enforced one cannot drift apart and no
      second file reads the organisation record. The MEMBER half asks
      `findXeroContactHomes`, `INV-INT-018`'s one accessor for ownership.
    */
    try {
      await assertXeroContactHasNoOtherHome(prisma, {
        xeroContactId: parsed.data.xeroContactId,
        home: { kind: "MEMBER", id },
      });
    } catch (error) {
      if (error instanceof XeroContactTwoHomesError) {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
      throw error;
    }

    const homes = await findXeroContactHomes(prisma, [parsed.data.xeroContactId]);
    const heldBy = homes.get(parsed.data.xeroContactId);
    if (heldBy && heldBy.kind === "MEMBER" && heldBy.id !== id) {
      const holder = await prisma.member.findUnique({
        where: { id: heldBy.id },
        select: { firstName: true, lastName: true },
      });
      return NextResponse.json(
        {
          error: `This Xero contact is already linked to ${holder ? `${holder.firstName} ${holder.lastName}` : "another member"}`,
        },
        { status: 409 },
      );
    }

    // Verify the Xero contact exists
    const { xero, tenantId } = await getAuthenticatedXeroClient();
    const contactRes = await callXeroApi(
      () => xero.accountingApi.getContact(tenantId, parsed.data.xeroContactId),
      {
        operation: "getContact",
        resourceType: "CONTACT",
        workflow: "adminLinkMemberToXeroContact",
        context: `verifyContact(${parsed.data.xeroContactId})`,
      }
    );
    const contact = contactRes.body.contacts?.[0];
    if (!contact) {
      return NextResponse.json({ error: "Xero contact not found" }, { status: 404 });
    }

    await refreshXeroContactCachesFromContact(contact);

    await commitManualXeroContactLink({
      memberId: id,
      xeroContactId: parsed.data.xeroContactId,
      contactName: contact.name ?? null,
    });
    memberLinkCommitted = true;
    subscriptionRefreshPending = true;

    const flushedSubscriptionHistory = await flushMemberSubscriptionHistory(id);
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
          "Member linked, but subscription history refresh did not complete for every season. Run the Member Status Repair Backfill to retry.";
        logger.warn(
          {
            memberId: id,
            xeroContactId: parsed.data.xeroContactId,
            seasonYears: subscriptionSync.seasonYears,
            errors: subscriptionSync.errors,
          },
          "Subscription history refresh completed with errors after member relink"
        );
      }
    } catch (historyError) {
      if (isHostingCoverageParticipantRetry(historyError)) {
        throw historyError;
      }
      warning =
        "Member linked, but subscription history refresh did not complete. Run the Member Status Repair Backfill to retry.";
      subscriptionRefreshPending = true;
      logger.warn(
        {
          err: historyError,
          memberId: id,
          xeroContactId: parsed.data.xeroContactId,
          flushedSubscriptionHistory,
        },
        "Failed to refresh member subscription history after relink"
      );
    }

    await logAudit({
      action: "XERO_LINK",
      memberId: session.user.id,
      targetId: id,
      subjectMemberId: id,
      entityType: "Member",
      entityId: id,
      category: "xero",
      outcome: "success",
      summary: "Member linked to Xero contact",
      details: `Linked to Xero contact ${parsed.data.xeroContactId} (${contact.name})`,
      metadata: {
        xeroContactId: parsed.data.xeroContactId,
        contactName: contact.name ?? null,
        flushedSubscriptionHistoryCount:
          flushedSubscriptionHistory.deletedCount,
      },
    });

    logger.info({ memberId: id, xeroContactId: parsed.data.xeroContactId }, "Manually linked member to Xero contact");

    return NextResponse.json({
      xeroContactId: parsed.data.xeroContactId,
      contactName: contact.name,
      // #2314: the RETURNED link carries the organisation short code so the
      // admin who just linked lands in this club's Xero. The link PERSISTED on
      // the XeroObjectLink row above deliberately does not — a stored short
      // code would be wrong after a reconnect to a different organisation, so
      // stored URLs stay generic and are scoped at render time.
      xeroLink: buildXeroContactUrl(parsed.data.xeroContactId, {
        shortCode: await getXeroOrgShortCode(),
      }),
      ...(warning ? { warning } : {}),
    });
  } catch (err) {
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
    const recovery = memberLinkCommitted
      ? linkedContactRecovery(
          parsed.data.xeroContactId,
          subscriptionRefreshPending,
        )
      : null;
    const hostingRetry = hostingCoverageParticipantRetryResponse(
      err,
      recovery ? { ...recovery } : undefined,
    );
    if (hostingRetry) return hostingRetry;
    if (recovery) {
      logger.error(
        { err, memberId: id, recoveryKind: recovery.recoveryKind },
        "Xero contact link completed only in part",
      );
      return NextResponse.json(xeroPartialSuccessBody(recovery), {
        status: 409,
      });
    }
    const xeroError = getXeroApiErrorInfo(err, "Failed to link to Xero contact");
    if (!xeroError.handled) {
      logger.error(
        { err, memberId: id, xeroDiagnosticMessage: xeroError.diagnosticMessage },
        "Error linking member to Xero contact"
      );
    }
    return NextResponse.json({ error: xeroError.clientMessage }, { status: xeroError.status });
  }
}
