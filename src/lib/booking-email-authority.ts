import { bookingOwner } from "@/lib/booking-owner";
import { MEMBER_ACCESS_ROLE_SELECT } from "@/lib/access-role-definitions";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import { hasAdminAccess } from "@/lib/access-roles";
import {
  buildBookingDetailUrl,
  type BookingEmailRecipient,
  type BookingEmailRecipientAuthority,
} from "@/lib/booking-email-contract";
import { ALWAYS_BOOKING_SCOPED_TEMPLATE_NAMES } from "@/lib/booking-email-suppression";
import { normalizeEmailAddress } from "@/lib/email-suppression";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

export interface BookingEmailLinkDecision {
  authority: BookingEmailRecipientAuthority;
  bookingUrl: string | null;
}

const NO_LINK_DECISIONS: Record<
  "non-login-public-contact" | "aggregate-operator",
  BookingEmailLinkDecision
> = {
  "non-login-public-contact": {
    authority: "non-login-public-contact",
    bookingUrl: null,
  },
  "aggregate-operator": { authority: "aggregate-operator", bookingUrl: null },
};

/**
 * Resolve whether this exact recipient may use the canonical booking-detail
 * route. The route remains the final authority on click; this is the privacy
 * gate that decides whether the booking id may be placed in outbound mail.
 */
export async function resolveBookingEmailLink(params: {
  bookingId: string;
  templateName: string;
  recipient: BookingEmailRecipient;
  deliveryAddress: string;
}): Promise<BookingEmailLinkDecision> {
  if (!ALWAYS_BOOKING_SCOPED_TEMPLATE_NAMES.has(params.templateName)) {
    return { authority: "unauthorized", bookingUrl: null };
  }
  if (
    params.recipient.kind === "non-login-public-contact" ||
    params.recipient.kind === "aggregate-operator"
  ) {
    return NO_LINK_DECISIONS[params.recipient.kind];
  }

  try {
    const booking = await prisma.booking.findUnique({
      where: { id: params.bookingId },
      select: {
        memberId: true,
        deletedAt: true,
        guests: {
          where: {
            memberId:
              params.recipient.memberId,
          },
          select: { id: true },
          take: 1,
        },
      },
    });
    if (!booking) return { authority: "unauthorized", bookingUrl: null };

    const recipientMemberId = params.recipient.memberId;
    const member = await prisma.member.findUnique({
      where: { id: recipientMemberId },
      select: {
        email: true,
        inheritEmailFromId: true,
        inheritEmailFrom: { select: { email: true } },
        role: true,
        financeAccessLevel: true,
        active: true,
        archivedAt: true,
        canLogin: true,
        accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT },
      },
    });

    if (
      !member ||
      member.active !== true ||
      member.canLogin !== true ||
      member.archivedAt != null ||
      normalizeEmailAddress(params.deliveryAddress) !==
        normalizeEmailAddress(
          member.inheritEmailFromId
            ? (member.inheritEmailFrom?.email ?? "")
            : member.email,
        )
    ) {
      return { authority: "unauthorized", bookingUrl: null };
    }

    const permissionInput = {
      role: member.role,
      financeAccessLevel: member.financeAccessLevel,
      canLogin: member.canLogin,
      accessRoles: member.accessRoles,
    };
    const isFullAdmin = hasAdminAccess(permissionInput);
    // The canonical page hides deleted bookings from non-Full-Admins before it
    // evaluates ownership, linked-guest access, or scoped bookings access.
    if (booking.deletedAt != null && !isFullAdmin) {
      return { authority: "unauthorized", bookingUrl: null };
    }

    const authority: BookingEmailRecipientAuthority =
      bookingOwner(booking).memberId === recipientMemberId
        ? "signed-in-booking-owner"
        : booking.guests.length > 0
          ? "signed-in-linked-member"
          : hasAdminAreaAccess(permissionInput, {
                area: "bookings",
                level: "view",
              })
            ? "bookings-view-admin"
            : "unauthorized";

    return {
      authority,
      bookingUrl:
        authority === "unauthorized"
          ? null
          : buildBookingDetailUrl(params.bookingId),
    };
  } catch (err) {
    // A detail link is optional; fail closed on privacy without withholding the
    // operational email itself. The canonical action/bearer link remains intact.
    logger.error(
      {
        err,
        bookingId: params.bookingId,
        templateName: params.templateName,
        recipientMemberId: params.recipient.memberId,
        deliveryAddress: params.deliveryAddress,
      },
      "Failed to classify a booking-email recipient; omitting the booking detail link",
    );
    return { authority: "unauthorized", bookingUrl: null };
  }
}
