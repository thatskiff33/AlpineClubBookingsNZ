/**
 * What an officer sends to search Xero contacts and to link, create or unlink
 * a member's Xero contact (`GET /api/admin/xero/search-contacts`, `POST
 * /api/admin/members/[id]/xero-link` and `xero-push`). The routes and their AI
 * app actions read these (ALP-721, `INV-SSOT`). Pure: no server imports, so
 * the catalogue can import it. Amounts are integer cents.
 */
import { z } from "zod";

/** `q` matches a contact's name or email address; two characters at least. */
export const xeroContactSearchQuerySchema = z.object({
  q: z.string().trim().min(2),
});

/** The Xero contact id a search answered with. */
export const xeroMemberContactLinkBodySchema = z.object({
  xeroContactId: z.string().min(1),
});

/**
 * Creating a member's Xero contact, and whether to raise the joining fee
 * invoice with it. `entranceFeeInvoiceDecision` outranks the older
 * `createEntranceFeeInvoice` flag; `SKIP` needs a reason.
 */
export const xeroMemberContactPushBodySchema = z.object({
  createEntranceFeeInvoice: z.boolean().optional().default(false),
  entranceFeeInvoiceDecision: z.enum(["CREATE", "SKIP"]).optional(),
  entranceFeeInvoiceSkipReason: z.string().trim().max(500).optional().nullable(),
  entranceFeeInvoiceAmountCents: z.number().int().positive().max(1_000_000).optional(),
  entranceFeeInvoiceNarration: z.string().trim().max(500).optional().nullable(),
  forceCreate: z.boolean().optional().default(false),
});
