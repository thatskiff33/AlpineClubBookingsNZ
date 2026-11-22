/**
 * Two approval-time steps the public booking-request pipeline
 * (`booking-request.ts`) and the school pipeline (`school-booking-request.ts`)
 * wrote out identically (#5398): the held booking's lodge read before the
 * approval transaction, and the member-guest notices after its commit. They
 * belong with the other steps both pipelines share in `booking-request-shared.ts`
 * (its in-transaction clones and its post-commit helpers, such as
 * `notifyMemberGuestsHoldReleased` and `sendOwnerSubstitutionAdminAlert`), and
 * sit in this sibling file only because that module is at its 700-line size
 * budget. Each pipeline keeps its own log text, and nothing else between the
 * two pipelines is merged here.
 */
import type { BookingRequest } from "@prisma/client";
import type { MemberGuestAddNotificationRow } from "@/lib/member-guest-add-policy";
import type { MemberGuestAddActor } from "@/lib/member-guest-consent";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/**
 * MG4-D-b (#2309), both approval pipelines (#5398): tell the member guests an
 * approval added, and those it dropped, AFTER the commit and outside both
 * advisory locks. Two directions, because an approval can do both at once: a
 * swap adds one member guest and drops another, and telling only the newcomer
 * would leave the person who was dropped believing they still have a bed.
 * Never fatal; each pipeline keeps its own failure log text.
 */
export async function notifyMemberGuestsAfterApproval(params: {
  conversion: {
    bookingId: string;
    memberGuestNotificationRows: readonly MemberGuestAddNotificationRow[];
    displacedMemberGuestIds: readonly string[];
  };
  actor: MemberGuestAddActor;
  bookingRequestId: string;
  failureLogMessage: string;
}): Promise<void> {
  const { conversion, actor, bookingRequestId, failureLogMessage } = params;
  if (
    conversion.memberGuestNotificationRows.length > 0 ||
    conversion.displacedMemberGuestIds.length > 0
  ) {
    const {
      sendMemberGuestAddNotifications,
      sendMemberGuestWithdrawnNotifications,
    } = await import("@/lib/member-guest-consent-notifications");
    try {
      if (conversion.memberGuestNotificationRows.length > 0) {
        await sendMemberGuestAddNotifications({
          bookingId: conversion.bookingId,
          rows: conversion.memberGuestNotificationRows,
          actor,
        });
      }
      if (conversion.displacedMemberGuestIds.length > 0) {
        await sendMemberGuestWithdrawnNotifications({
          bookingId: conversion.bookingId,
          targetMemberIds: conversion.displacedMemberGuestIds,
          context: "BOOKING_REQUEST_REPLACED",
        });
      }
    } catch (err) {
      logger.error(
        { err, bookingId: conversion.bookingId, bookingRequestId },
        failureLogMessage,
      );
    }
  }
}

/**
 * Both approval pipelines' pre-transaction lodge read (#5398). A held booking
 * has already materialised the request's null/default lodge semantics into an
 * immutable concrete Booking.lodgeId. Read only that lock key before the
 * transaction; the full request and booking are re-read after global -> lodge
 * locks. Fresh approvals need no extra lookup. Returns null when the request
 * names a held booking that no longer exists: the caller refuses with its 409
 * ("Held booking was not found"), raised there because `BookingRequestError`
 * lives in `booking-request.ts`, which imports this module, and the module graph
 * allows no cycle (`INV-SSOT-008`).
 */
export async function findHeldApprovalLodge(
  request: Pick<BookingRequest, "heldBookingId" | "lodgeId">,
): Promise<{
  expectedHeldBookingId: string | null;
  expectedHeldLodgeId: string | null;
  approvalLodgeId: string | null;
} | null> {
  const expectedHeldBookingId = request.heldBookingId ?? null;
  const heldLodgeLocator = expectedHeldBookingId
    ? await prisma.booking.findUnique({
        where: { id: expectedHeldBookingId },
        select: { lodgeId: true },
      })
    : null;
  if (expectedHeldBookingId && !heldLodgeLocator) return null;
  const expectedHeldLodgeId = heldLodgeLocator?.lodgeId ?? null;
  const approvalLodgeId = expectedHeldLodgeId ?? request.lodgeId ?? null;
  return { expectedHeldBookingId, expectedHeldLodgeId, approvalLodgeId };
}
