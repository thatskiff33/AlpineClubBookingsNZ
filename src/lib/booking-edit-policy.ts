import { BookingStatus } from "@prisma/client";
import { addDaysDateOnly, getTodayDateOnly, normalizeDateOnlyForTimeZone } from "@/lib/date-only";

const MEMBER_FUTURE_EDIT_STATUSES = new Set<string>([
  BookingStatus.PENDING,
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.PAID,
]);

const ADMIN_FUTURE_EDIT_STATUSES = new Set<string>([
  ...MEMBER_FUTURE_EDIT_STATUSES,
  BookingStatus.DRAFT,
  BookingStatus.WAITLISTED,
  BookingStatus.WAITLIST_OFFERED,
  BookingStatus.BUMPED,
]);

const IN_PROGRESS_EDIT_STATUSES = new Set<string>([
  BookingStatus.PAID,
  BookingStatus.COMPLETED,
]);

type BookingEditMode = "future" | "in-progress";

export interface BookingEditPolicy {
  canModify: boolean;
  mode: BookingEditMode | null;
  today: Date;
  editableFrom: Date | null;
  checkInEditable: boolean;
  reason: string | null;
}

export interface BookingEditPolicyInput {
  status: string;
  role: string;
  checkIn: Date;
  checkOut: Date;
}

function isAdmin(role: string) {
  return role === "ADMIN";
}

export function isFutureEditStatusAllowed(status: string, role: string): boolean {
  return isAdmin(role)
    ? ADMIN_FUTURE_EDIT_STATUSES.has(status)
    : MEMBER_FUTURE_EDIT_STATUSES.has(status);
}

export function isInProgressEditStatusAllowed(status: string): boolean {
  return IN_PROGRESS_EDIT_STATUSES.has(status);
}

export function getBookingEditPolicy(
  input: BookingEditPolicyInput
): BookingEditPolicy {
  const today = getTodayDateOnly();
  const tomorrow = addDaysDateOnly(today, 1);
  const checkIn = normalizeDateOnlyForTimeZone(input.checkIn);
  const checkOut = normalizeDateOnlyForTimeZone(input.checkOut);

  if (checkIn > today) {
    const canModify = isFutureEditStatusAllowed(input.status, input.role);
    return {
      canModify,
      mode: canModify ? "future" : null,
      today,
      editableFrom: checkIn,
      checkInEditable: canModify,
      reason: canModify
        ? null
        : "This booking cannot be modified in its current status",
    };
  }

  if (checkIn <= today && checkOut > today) {
    const canModify = isInProgressEditStatusAllowed(input.status);
    return {
      canModify,
      mode: canModify ? "in-progress" : null,
      today,
      editableFrom: tomorrow,
      checkInEditable: false,
      reason: canModify
        ? null
        : "This in-progress booking cannot be modified in its current status",
    };
  }

  return {
    canModify: false,
    mode: null,
    today,
    editableFrom: null,
    checkInEditable: false,
    reason: "This booking has no future nights available for self-service changes",
  };
}

export function canModifyBookingStatusForRole(status: string, role: string): boolean {
  return isFutureEditStatusAllowed(status, role) || isInProgressEditStatusAllowed(status);
}

export function usesActiveBookingEditLifecycle(status: string): boolean {
  return MEMBER_FUTURE_EDIT_STATUSES.has(status) || status === BookingStatus.COMPLETED;
}
