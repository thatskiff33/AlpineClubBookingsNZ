export type BookingPaymentMode = "payment" | "setup";

export function getBookingPaymentMode(bookingStatus: string): BookingPaymentMode {
  return bookingStatus === "PENDING" ? "setup" : "payment";
}
