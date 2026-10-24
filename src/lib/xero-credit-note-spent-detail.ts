/**
 * #4218: the read half of "the credit note was spent outside the app" (the pure
 * half is `xero-credit-note-spent-outside-app.ts`).
 */
import logger from "@/lib/logger";
import { getClubFormat } from "@/lib/club-format-settings";
import { exactProviderAmountToCents } from "@/lib/money-provider-amount";
import { formatCents } from "@/lib/utils";
import { failXeroSyncOperation } from "@/lib/xero-sync";
import {
  callXeroApi,
  getAuthenticatedXeroClient,
  getXeroErrorSearchText,
} from "@/lib/xero-api-client";
import {
  CreditNoteSpentOutsideAppError,
  isCreditNoteOverAllocationText,
  isCreditNoteSpentOutsideAppError,
  noteAllocationCentsForInvoice,
  refusalMeansSpentOutsideApp,
  type XeroNoteAllocation,
  type XeroNotePayment,
} from "@/lib/xero-credit-note-spent-outside-app";

/** The note's allocations with an exact-cent amount and an invoice (anything else is skipped). */
function xeroAllocationsOf(
  allocations: ReadonlyArray<{ invoice?: { invoiceID?: string } | null; amount?: unknown; isDeleted?: boolean }> | null | undefined,
): XeroNoteAllocation[] {
  return (allocations ?? []).flatMap((allocation) => {
    if (allocation.isDeleted === true) return [];
    const invoiceId = allocation.invoice?.invoiceID;
    const cents = exactProviderAmountToCents(allocation.amount);
    return invoiceId && cents !== null ? [{ invoiceId, cents }] : [];
  });
}

/** The payments made against the note (refunds of its credit) with an exact-cent amount. */
function xeroPaymentsOf(
  payments: ReadonlyArray<{ paymentID?: string; amount?: unknown; status?: unknown }> | null | undefined,
): XeroNotePayment[] {
  return (payments ?? []).flatMap((payment) => {
    if (String(payment.status ?? "") === "DELETED") return [];
    const cents = exactProviderAmountToCents(payment.amount);
    return payment.paymentID && cents !== null ? [{ paymentId: payment.paymentID, cents }] : [];
  });
}

/**
 * #4218: Xero refused the allocation as larger than the note's remaining credit.
 * The refusal alone is not enough to say the note was spent outside the app: the
 * app's own earlier allocation, whose completion was never recorded, is refused
 * the same way. So the note is read back and the refusal is named only when the
 * read CONFIRMS it (`refusalMeansSpentOutsideApp`); a read that cannot be
 * completed leaves the original error as it is, exactly as before this change,
 * so the named error never rests on a guess (the ledger convergence in #4219
 * acts on it). Read-only, outside any transaction, with no rate-limit retries
 * and a short wait so recording the failure is never held up. Null means "not
 * confirmed"; the caller keeps the original error.
 */
export async function describeCreditNoteSpentOutsideApp(
  creditNoteId: string,
  invoiceId: string,
  amountCents: number,
  cause: unknown,
): Promise<CreditNoteSpentOutsideAppError | null> {
  let remainingCents: number | null;
  let allocatedToInvoiceCents: number[];
  let totalCents: number | null;
  let xeroAllocations: XeroNoteAllocation[];
  let xeroPayments: XeroNotePayment[];
  try {
    const { xero, tenantId } = await getAuthenticatedXeroClient();
    const response = await callXeroApi(
      () => xero.accountingApi.getCreditNote(tenantId, creditNoteId),
      {
        operation: "getCreditNote",
        resourceType: "CREDIT_NOTE",
        workflow: "allocateCreditNoteToInvoice",
        context: `getCreditNote(${creditNoteId}) after an over-allocation refusal`,
        armTransientBreaker: false,
        maxRetries: 0,
        maxWaitSec: 5,
      },
    );
    const note = response.body.creditNotes?.[0];
    remainingCents = exactProviderAmountToCents(note?.remainingCredit);
    allocatedToInvoiceCents = noteAllocationCentsForInvoice(
      note?.allocations,
      invoiceId,
      exactProviderAmountToCents,
    );
    totalCents = exactProviderAmountToCents(note?.total);
    xeroAllocations = xeroAllocationsOf(note?.allocations);
    xeroPayments = xeroPaymentsOf(note?.payments);
  } catch (readError) {
    logger.warn(
      { err: readError, creditNoteId },
      "Could not read the credit note after an over-allocation refusal; leaving the original error",
    );
    return null;
  }
  if (
    remainingCents === null ||
    !refusalMeansSpentOutsideApp({ remainingCents, allocatedToInvoiceCents }, amountCents)
  ) {
    return null;
  }
  let left = "less than this allocation needs";
  try {
    left = `only ${formatCents(remainingCents, await getClubFormat())}`;
  } catch (formatError) {
    logger.warn({ err: formatError }, "Could not format the credit-note amount left; using generic wording");
  }
  return new CreditNoteSpentOutsideAppError(
    `The credit note this allocation needs has ${left} left in Xero; it was used outside the app. Retrying will not help until that credit is restored in Xero.`,
    creditNoteId,
    remainingCents,
    amountCents,
    { cause, xeroAllocations, xeroPayments, totalCents },
  );
}

/**
 * Record an allocation's failure on its operation and return the error to throw:
 * the named error when Xero refused the allocation as more than the note has
 * left and the note was really spent outside the app, else the error untouched.
 */
export async function failAllocation(
  operationId: string,
  error: unknown,
  creditNoteId: string,
  invoiceId: string,
  amountCents: number,
): Promise<unknown> {
  const named =
    !isCreditNoteSpentOutsideAppError(error) &&
    isCreditNoteOverAllocationText(getXeroErrorSearchText(error))
      ? await describeCreditNoteSpentOutsideApp(creditNoteId, invoiceId, amountCents, error)
      : null;
  const failure = named ?? error;
  await failXeroSyncOperation(operationId, failure);
  return failure;
}
