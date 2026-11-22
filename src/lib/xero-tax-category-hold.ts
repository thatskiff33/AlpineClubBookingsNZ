import { isXeroAppliedCreditOperationBusyError } from "@/lib/xero-applied-credit-operation-serialization";
import { XERO_TAX_CATEGORY_AWAITING_MAPPING_CODE } from "@/lib/xero-operation-error-codes";
import { scanSpacesWaitCode } from "@/lib/xero-operation-wait-spacing";
import { XeroTaxCategoryUnavailableError } from "@/lib/xero-tax-categories";

/**
 * THE QUEUE HOLD FOR A TAX CATEGORY XERO CANNOT CARRY (#4988, on #5209's
 * `XeroTaxCategoryUnavailableError`; `INV-CONFIG-008`). A sender that meets one
 * has not sent the line, and no fallback code exists, so its outbox row is not
 * a failure: it goes back to PENDING under a code naming the wait, with the
 * error's own sentence telling the officer what to map, and is asked again
 * every five minutes, so it is sent soon after a Full Admin maps the category
 * on the Xero setup screen.
 *
 * WHAT HAS REACHED XERO BY THEN. The sender asks before its first provider
 * write, so normally nothing has. If the answer changes between that ask and
 * the mint's own (a rate read that fails the second time, say), the booking's
 * floating notes may already be allocated. The retry is safe either way: each
 * allocation is skipped by its completion link, and the note is minted once.
 *
 * First sender: the applied-credit allocation, whose spent opening credit
 * coded to the mapped Opening Credits account is an Exempt line.
 *
 * The outbox returns a row only under the claim it took, still RUNNING. The
 * allocation's own operation is left RUNNING by its handler, so it is held.
 * The same error raised inside a card booking's invoice operation, which fails
 * its own row first, ends FAILED with this sentence and is retried by an
 * officer, as every other wait raised there does.
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

/**
 * What the outbox records on a row it returns to PENDING to wait, or null when
 * the error is not a wait. Two kinds: the applied-credit busy error and its
 * subclasses, each naming its own wait code or none (#3954 round 8), and a tax
 * category Xero cannot carry yet (#4988), under the code above. The one test
 * the outbox's catch asks, so a wait is recognised in one place.
 */
export function xeroOutboxWaitOf(error: unknown): { code: string | null; message: string } | null {
  if (isXeroAppliedCreditOperationBusyError(error)) return { code: error.waitCode, message: error.message };
  if (error instanceof XeroTaxCategoryUnavailableError) {
    return { code: XERO_TAX_CATEGORY_AWAITING_MAPPING_CODE, message: error.message };
  }
  return null;
}
