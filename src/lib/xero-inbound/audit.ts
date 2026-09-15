import { bookingOwner } from "@/lib/booking-owner";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { createAuditLog } from "@/lib/audit";
import { type XeroAuditLocalLink } from "./types";

function dedupeXeroAuditLocalLinks(
  links: XeroAuditLocalLink[]
): XeroAuditLocalLink[] {
  const seen = new Map<string, XeroAuditLocalLink>();

  for (const link of links) {
    seen.set(
      [
        link.localModel,
        link.localId,
        link.xeroObjectType,
        link.xeroObjectId,
        link.role,
      ].join(":"),
      link
    );
  }

  return Array.from(seen.values());
}

function getXeroAuditSummary(xeroObjectType: string) {
  switch (xeroObjectType) {
    case "CONTACT":
      return "Xero contact reconciled";
    case "INVOICE":
    case "SUBSCRIPTION":
      return "Xero invoice reconciled";
    case "PAYMENT":
      return "Xero payment reconciled";
    case "CREDIT_NOTE":
      return "Xero credit note reconciled";
    case "ALLOCATION":
      return "Xero allocation reconciled";
    default:
      return "Xero record reconciled";
  }
}

function getXeroAuditAction(xeroObjectType: string) {
  return `xero.${xeroObjectType.toLowerCase()}.reconciled`;
}

async function resolveXeroAuditSubjects(links: XeroAuditLocalLink[]) {
  const subjects = new Map<
    string,
    // #3369, `INV-PRIV-019`: an audit SUBJECT stays a person, so a booking
    // owned by an `Organisation` carries none and the entity identifies it.
    { subjectMemberId: string | null; bookingId?: string | null }
  >();
  const idsByModel = new Map<string, Set<string>>();

  for (const link of links) {
    if (!idsByModel.has(link.localModel)) {
      idsByModel.set(link.localModel, new Set());
    }
    idsByModel.get(link.localModel)!.add(link.localId);
  }

  for (const memberId of idsByModel.get("Member") ?? []) {
    subjects.set(`Member:${memberId}`, { subjectMemberId: memberId });
  }

  const bookingIds = Array.from(idsByModel.get("Booking") ?? []);
  if (bookingIds.length > 0) {
    const bookings = await prisma.booking.findMany({
      where: { id: { in: bookingIds } },
      select: { id: true, memberId: true },
    });
    for (const booking of bookings) {
      subjects.set(`Booking:${booking.id}`, {
        subjectMemberId: bookingOwner(booking).memberId,
        bookingId: booking.id,
      });
    }
  }

  const modificationIds = Array.from(idsByModel.get("BookingModification") ?? []);
  if (modificationIds.length > 0) {
    const modifications = await prisma.bookingModification.findMany({
      where: { id: { in: modificationIds } },
      select: { id: true, memberId: true, bookingId: true },
    });
    for (const modification of modifications) {
      subjects.set(`BookingModification:${modification.id}`, {
        subjectMemberId: modification.memberId,
        bookingId: modification.bookingId,
      });
    }
  }

  const paymentIds = Array.from(idsByModel.get("Payment") ?? []);
  if (paymentIds.length > 0) {
    const payments = await prisma.payment.findMany({
      where: { id: { in: paymentIds } },
      select: {
        id: true,
        bookingId: true,
        booking: {
          select: {
            memberId: true,
          },
        },
      },
    });
    for (const payment of payments) {
      if (!payment.booking || !bookingOwner(payment.booking).memberId) {
        continue;
      }

      subjects.set(`Payment:${payment.id}`, {
        subjectMemberId: bookingOwner(payment.booking).memberId,
        bookingId: payment.bookingId,
      });
    }
  }

  const subscriptionIds = Array.from(idsByModel.get("MemberSubscription") ?? []);
  if (subscriptionIds.length > 0) {
    const subscriptions = await prisma.memberSubscription.findMany({
      where: { id: { in: subscriptionIds } },
      select: { id: true, memberId: true },
    });
    for (const subscription of subscriptions) {
      subjects.set(`MemberSubscription:${subscription.id}`, {
        subjectMemberId: subscription.memberId,
      });
    }
  }

  return subjects;
}

export async function writeXeroInboundAuditLogs(input: {
  links: XeroAuditLocalLink[];
  source: string;
  metadata?: Record<string, unknown>;
}) {
  const links = dedupeXeroAuditLocalLinks(input.links);
  if (links.length === 0) {
    return;
  }

  const subjects = await resolveXeroAuditSubjects(links);

  for (const link of links) {
    const subject = subjects.get(`${link.localModel}:${link.localId}`);
    if (!subject) {
      continue;
    }

    try {
      await createAuditLog({
        action: getXeroAuditAction(link.xeroObjectType),
        targetId: link.localId,
        subjectMemberId: subject.subjectMemberId,
        entityType: link.localModel,
        entityId: link.localId,
        category: "xero",
        severity: "critical",
        outcome: "success",
        summary: getXeroAuditSummary(link.xeroObjectType),
        details: `${getXeroAuditSummary(link.xeroObjectType)} for ${link.localModel}`,
        metadata: {
          source: input.source,
          localModel: link.localModel,
          localId: link.localId,
          role: link.role,
          xeroObjectType: link.xeroObjectType,
          xeroObjectId: link.xeroObjectId,
          xeroObjectNumber: link.xeroObjectNumber ?? null,
          bookingId: subject.bookingId ?? null,
          ...input.metadata,
        },
      });
    } catch (err) {
      logger.error(
        {
          err,
          localModel: link.localModel,
          localId: link.localId,
          xeroObjectType: link.xeroObjectType,
          xeroObjectId: link.xeroObjectId,
        },
        "Failed to write Xero inbound reconciliation audit log"
      );
    }
  }
}
