import { isCreditNoteSpentOutsideAppError } from "@/lib/xero-credit-note-spent-outside-app";

/**
 * #3462: THE text of a Xero sync failure, read from whatever was thrown. One
 * home, with one fallback, for the outbox's failure writer and the REQUEUE
 * row's operator message, so the two never describe the same throw
 * differently. Redaction is the writer's job, not this function's.
 */
export function xeroSyncErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown Xero sync failure";
}

/**
 * #4218: the `lastErrorCode` an error names for itself, in place of an HTTP
 * status. Null for every other error. The operation stays replayable: a retry
 * sends the allocation again, so it goes through once the credit is restored.
 */
export function namedXeroErrorCode(error: unknown): string | null {
  return isCreditNoteSpentOutsideAppError(error) ? error.code : null;
}
