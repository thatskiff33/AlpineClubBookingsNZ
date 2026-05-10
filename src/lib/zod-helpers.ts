import { z } from "zod";

/**
 * Schema for a person-name field (first name, last name) destined for the
 * `Member` or `BookingGuest` table. Strips CR/LF before persistence so the
 * value cannot later trip the CRLF guard in `sendEmail()` when interpolated
 * into an email subject. See issue #323.
 */
export function nameField(message?: { required?: string; max?: string }) {
  return z
    .string()
    .min(1, message?.required ?? "Name is required")
    .max(100, message?.max ?? "Name must be 100 characters or fewer")
    .transform((s) => s.replace(/[\r\n]+/g, " ").trim())
    .refine((s) => s.length >= 1, {
      message: "Name cannot be empty",
    });
}
