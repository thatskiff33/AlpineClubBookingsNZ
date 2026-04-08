/**
 * Centralised status colour utility.
 * Every status must have a unique colour within its category.
 */

export const bookingStatusClasses: Record<string, string> = {
  DRAFT:     "bg-gray-100 text-gray-700",
  PENDING:   "bg-yellow-100 text-yellow-800",
  CONFIRMED: "bg-green-100 text-green-800",
  PAID:      "bg-blue-100 text-blue-800",
  COMPLETED: "bg-slate-100 text-slate-600",
  CANCELLED: "bg-red-100 text-red-800",
  BUMPED:          "bg-orange-100 text-orange-800",
  WAITLISTED:      "bg-purple-100 text-purple-800",
  WAITLIST_OFFERED: "bg-teal-100 text-teal-800",
};

export const paymentStatusClasses: Record<string, string> = {
  PENDING:            "bg-yellow-100 text-yellow-800",
  PROCESSING:         "bg-indigo-100 text-indigo-800",
  SUCCEEDED:          "bg-blue-100 text-blue-800",
  FAILED:             "bg-red-100 text-red-800",
  REFUNDED:           "bg-purple-100 text-purple-800",
  PARTIALLY_REFUNDED: "bg-orange-100 text-orange-800",
};

export function bookingStatusClass(status: string): string {
  return bookingStatusClasses[status] ?? "bg-gray-100 text-gray-700";
}

export function paymentStatusClass(status: string): string {
  return paymentStatusClasses[status] ?? "bg-gray-100 text-gray-700";
}

export const subscriptionStatusClasses: Record<string, string> = {
  PAID:         "bg-green-100 text-green-800",
  UNPAID:       "bg-yellow-100 text-yellow-800",
  OVERDUE:      "bg-red-100 text-red-800",
  NOT_INVOICED: "bg-slate-100 text-slate-800",
};

export function subscriptionStatusClass(status: string): string {
  return subscriptionStatusClasses[status] ?? "bg-gray-100 text-gray-700";
}
