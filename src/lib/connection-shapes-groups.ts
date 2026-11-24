/**
 * What each group-booking and whole-lodge AI app action returns (ALP-797,
 * `INV-MCP-006`): the one place a catalogue entry's `returns` and its
 * route's projection both read (`INV-SSOT`).
 *
 * Types only from the lib modules the routes answer from: nothing here
 * reaches the database.
 */
import type { GroupBookingStatus } from "@prisma/client";

import { completeConnectionShapeFor, connectionShapeFor } from "@/lib/connection-projection";
import type { GroupBookingCreatedResponse } from "@/lib/group-booking-request-schemas";
import type { GroupBookingSummaryResponse } from "@/lib/group-booking-summary-response";
import type {
  WHOLE_LODGE_REQUEST_ACCEPTED,
  WHOLE_LODGE_REQUEST_WITHDRAWN,
} from "@/lib/member-whole-lodge-request-schema";
import type { MyWholeLodgeRequestItem } from "@/lib/member-whole-lodge-requests";

/**
 * The whole-lodge request routes' fixed acknowledgement. It echoes nothing
 * the member sent and says nothing about the calendar (ADR-001 decision 6).
 */
export const WHOLE_LODGE_REQUEST_SENT_CONNECTION_SHAPE = completeConnectionShapeFor<
  typeof WHOLE_LODGE_REQUEST_ACCEPTED
>({ success: true, message: true });
export const WHOLE_LODGE_REQUEST_WITHDRAWN_CONNECTION_SHAPE = completeConnectionShapeFor<
  typeof WHOLE_LODGE_REQUEST_WITHDRAWN
>({ success: true, message: true });

/** The member's own whole-lodge requests: the four member-visible words, never the pipeline status. */
export const MY_WHOLE_LODGE_REQUESTS_CONNECTION_SHAPE = completeConnectionShapeFor<{
  requests: MyWholeLodgeRequestItem[];
}>({
  requests: {
    id: true,
    checkIn: true,
    checkOut: true,
    headcount: true,
    status: true,
    createdAt: true,
    bookingId: true,
    canWithdraw: true,
  },
});

/** A new group: the join code the organiser hands out, never the group's internal id. */
export const GROUP_BOOKING_CREATED_CONNECTION_SHAPE = connectionShapeFor<GroupBookingCreatedResponse>({
  joinCode: true,
  paymentMode: true,
  status: true,
  joinDeadline: true,
  maxJoiners: true,
});

/** Whether the group now takes new joins. */
export const GROUP_BOOKING_JOIN_STATUS_CONNECTION_SHAPE = completeConnectionShapeFor<{ status: GroupBookingStatus }>({
  status: true,
});

/**
 * The public join-code summary, which carries only what the public join page
 * shows (no contact details, roster or internal ids), so all of it.
 */
export const GROUP_BOOKING_SUMMARY_CONNECTION_SHAPE = completeConnectionShapeFor<GroupBookingSummaryResponse>({
  code: true,
  status: true,
  paymentMode: true,
  joinerPaymentMode: true,
  organiserFirstName: true,
  lodgeName: true,
  checkIn: true,
  checkOut: true,
  joinDeadline: true,
  isJoinable: true,
});
