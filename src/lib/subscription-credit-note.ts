/**
 * A credit note against a membership subscription invoice, and its allocation
 * to that invoice: the Xero half both subscription credits share (#5190 PR 3).
 * The membership cancellation credit (`membership-cancellation-xero.ts`)
 * credits an invoice's whole balance; the age-up credit
 * (`subscription-age-up-credit.ts`) an explicit part of it. Each caller keeps
 * its own operation rows, links and claims; this owns only the document shape
 * and the two provider calls, so the two cannot drift apart.
 */
import { CreditNote, type LineItem, type XeroClient } from "xero-node";
import { callXeroApi } from "@/lib/xero-api-client";
import { getResolvedAccountMapping } from "@/lib/xero-mappings";
import { xeroLineTax, type XeroTaxRendering } from "@/lib/xero-tax-rendering";

/**
 * One line on the `membershipCancellationCredit` mapping (default account 203),
 * for `amountCents`, under the treatment the invoice it credits was charged
 * under (#4632).
 */
export async function subscriptionCreditLineItem(input: {
  description: string;
  amountCents: number;
  taxRendering: XeroTaxRendering;
}): Promise<LineItem> {
  const mapping = await getResolvedAccountMapping("membershipCancellationCredit");
  const line: LineItem = {
    description: input.description,
    quantity: 1,
    unitAmount: input.amountCents / 100,
    ...xeroLineTax(input.taxRendering),
    accountCode: mapping.code ?? "203",
  };
  if (mapping.itemCode) {
    line.itemCode = mapping.itemCode;
  }
  return line;
}

/** An authorised sales credit note for one subscription line. */
export function buildSubscriptionCreditNote(input: {
  contactId: string;
  /** The club's calendar day (`xeroDocumentDateForClubToday`, INV-DATE-019). */
  date: string;
  taxRendering: XeroTaxRendering;
  lineItem: LineItem;
  reference: string;
}): CreditNote {
  return {
    type: CreditNote.TypeEnum.ACCRECCREDIT,
    contact: { contactID: input.contactId },
    date: input.date,
    lineAmountTypes: input.taxRendering.lineAmountTypes,
    lineItems: [input.lineItem],
    reference: input.reference,
    status: CreditNote.StatusEnum.AUTHORISED,
  };
}

/**
 * Allocate `amountCents` of a credit note to the invoice it credits. `date` is
 * read once by the caller, outside `callXeroApi`'s retried callback, so a retry
 * across club midnight sends the same date under the same key.
 */
export async function allocateSubscriptionCreditNote(input: {
  xero: XeroClient;
  tenantId: string;
  creditNoteId: string;
  invoiceId: string;
  amountCents: number;
  date: string;
  idempotencyKey: string;
  workflow: string;
}) {
  return callXeroApi(
    () =>
      input.xero.accountingApi.createCreditNoteAllocation(
        input.tenantId,
        input.creditNoteId,
        {
          allocations: [
            {
              invoice: { invoiceID: input.invoiceId },
              amount: input.amountCents / 100,
              date: input.date,
            },
          ],
        },
        undefined,
        input.idempotencyKey,
      ),
    {
      operation: "createCreditNoteAllocation",
      resourceType: "ALLOCATION",
      workflow: input.workflow,
      context: `createCreditNoteAllocation(${input.creditNoteId} -> ${input.invoiceId})`,
    },
  );
}
