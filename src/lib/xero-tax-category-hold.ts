import { XERO_TAX_CATEGORY_AWAITING_MAPPING_CODE } from "@/lib/xero-operation-error-codes";
import { scanSpacesWaitCode } from "@/lib/xero-operation-wait-spacing";
import { XeroTaxCategoryUnavailableError } from "@/lib/xero-tax-categories";

/**
 * THE QUEUE HOLD FOR A TAX CATEGORY XERO CANNOT CARRY (#4988, on #5209's
 * `XeroTaxCategoryUnavailableError`; `INV-CONFIG-008`). A sender that meets one
 * has written nothing to Xero, and no fallback code exists, so its outbox row
 * is not a failure: it goes back to PENDING under a code naming the wait, with
 * the error's own sentence telling the officer what to map, and is asked again
 * once a Full Admin has mapped the category on the Xero setup screen.
 *
 * First sender: the applied-credit allocation, whose spent opening credit
 * coded to the mapped Opening Credits account is an Exempt line.
 */

/** Same spacing as a refund note waiting to be resolved: five minutes. */
export const XERO_TAX_CATEGORY_AWAITING_MAPPING_RECHECK_MS = 5 * 60 * 1000;

/**
 * Leave a row held for a tax category out of the oldest-first scan until its
 * recheck is due, so a wait that lasts until someone changes a setting does not
 * take the head of every kick. Every other row, a null code included, is
 * scanned as before.
 */
export function scanSpacesTaxCategoriesAwaitingMapping(now: Date) {
  return scanSpacesWaitCode(
    XERO_TAX_CATEGORY_AWAITING_MAPPING_CODE,
    XERO_TAX_CATEGORY_AWAITING_MAPPING_RECHECK_MS,
    now,
  );
}

/** What the outbox records as it holds the row, or null when the error is no such hold. */
export function xeroTaxCategoryHoldOf(error: unknown): { code: string; message: string } | null {
  if (!(error instanceof XeroTaxCategoryUnavailableError)) return null;
  return { code: XERO_TAX_CATEGORY_AWAITING_MAPPING_CODE, message: error.message };
}
