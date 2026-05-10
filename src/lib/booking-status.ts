import { BookingStatus } from "@prisma/client";

export const CAPACITY_HOLDING_BOOKING_STATUSES = [
  BookingStatus.PAID,
  BookingStatus.PENDING,
] as const;

export const PAYMENT_OWED_BOOKING_STATUSES = [
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
] as const;

export const IMMEDIATE_PAYMENT_BOOKING_STATUSES = [
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.DRAFT,
  BookingStatus.PENDING,
] as const;

export const MEMBER_MODIFIABLE_BOOKING_STATUSES = [
  BookingStatus.PENDING,
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.PAID,
] as const;

export const OPERATIONAL_STAY_BOOKING_STATUSES = [
  BookingStatus.PAID,
  BookingStatus.COMPLETED,
] as const;

export const ACTIVE_BOOKING_STATUSES = [
  BookingStatus.PENDING,
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.PAID,
] as const;

export function isPaymentOwedBookingStatus(status: string) {
  return (PAYMENT_OWED_BOOKING_STATUSES as readonly string[]).includes(status);
}

export function isCapacityHoldingBookingStatus(status: string) {
  return (CAPACITY_HOLDING_BOOKING_STATUSES as readonly string[]).includes(status);
}

export function isOperationalStayBookingStatus(status: string) {
  return (OPERATIONAL_STAY_BOOKING_STATUSES as readonly string[]).includes(status);
}
