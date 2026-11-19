import "server-only";

import type { auth } from "@/lib/auth";
import type { FeatureFlags } from "@/config/schema";
import { createAuditLog } from "@/lib/audit";
import { readBookingCreditNotes } from "@/lib/booking-credit-notes";
import { BookingInvoiceNotAvailableError } from "@/lib/booking-invoice";
import { bookingOwner } from "@/lib/booking-owner";
import { formatBookingReference } from "@/lib/booking-reference";
import {
  generatedBookingInvoiceOnOffer,
  primaryXeroInvoiceOnOffer,
  type BookingCreditNote,
  type BookingInvoiceOffer,
} from "@/lib/booking-invoice-access";
import { bookingHasAnySupplementaryInvoiceEvidence } from "@/lib/booking-supplementary-invoice-identities";
import { clubDownloadFilename } from "@/lib/club-download-filename";
import { getClubIdentity } from "@/lib/club-identity-settings";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import type { RateLimitResult } from "@/lib/rate-limit";
import { callXeroApi, getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import { isXeroConnected } from "@/lib/xero-token-store";
import { resolveBookingDetailViewer, type BookingDetailViewer } from "./booking-detail-viewer";
import { renderGeneratedBookingInvoice } from "./booking-invoice-generated";
import { loadBookingDetail, type BookingDetailRecord } from "./load-booking-detail";

type BookingInvoiceSession = NonNullable<Awaited<ReturnType<typeof auth>>>;

/**
 * The booking invoice download (#5066), behind the booking page's Download
 * invoice and credit-note buttons, `GET /api/bookings/[id]/invoice` and
 * `GET /api/bookings/[id]/invoice/credit-notes/[creditNoteId]`.
 *
 * XERO OFF (slice 2, owner decision 1). The invoice is the app's own document
 * (`GENERATED`, `generatedBookingInvoiceOnOffer`, rendered by
 * `renderGeneratedBookingInvoice`); there are no credit notes. Everything below
 * about Xero applies only while the Xero module is on.
 *
 * WHICH INVOICE. Only the booking's primary Xero invoice (`Payment.xeroInvoiceId`),
 * and only when nothing says the booking has another invoice the member is
 * billed by. Two checks say so, and either is enough for a "please ask the
 * club" line instead of an incomplete record:
 *
 * - any ADDITIONAL ledger row on the payment (an extra charge, asked or
 *   withdrawn), as loaded by the page's own read; and
 * - any supplementary invoice evidence on the booking's supplementary anchors
 *   (`bookingHasAnySupplementaryInvoiceEvidence`): bank demand, card receipt,
 *   unsent or failed create, inactive link, unclassifiable second ask.
 *
 * Those anchors (Booking, BookingModification, edit-review ManualRefundTask) are
 * where every supplementary invoice writer anchors. The booking's other Xero
 * invoices bill no one on this page: a card-refund reversal invoice bills the
 * Stripe clearing account (`INV-PAY-151`), and a kept late capture's invoice
 * exists only on a cancelled booking, which is never offered.
 *
 * WHICH CREDIT NOTES (owner decision on PR #5201, 17 Nov 2026: the invoice is
 * shown with the credits and payments applied). Every credit note the app holds
 * the Xero id of against the booking (`readBookingCreditNotes`), each its own
 * download. A credit note does not turn the offer into "ask the club": it is
 * listed beside the invoice instead. The invoice route takes no id from the
 * client; the credit-note route serves only an id in the offer's list, so it
 * cannot fetch an arbitrary credit note.
 *
 * Read-only apart from the audit row: the generated document makes no provider
 * call at all; the one Xero call runs outside any transaction, through the
 * metered `callXeroApi` with no retries, and never arms the process-wide outage
 * breaker (#2394's rule for a read behind a person's
 * button). Each successful download writes one audit row AFTER the PDF exists
 * (Xero's, or the generated one with its `source: "GENERATED"`); if that row
 * cannot be written the PDF is not handed over (owner decision 5 on
 * #5066: each download writes an audit row).
 *
 * LIMITS. The route charges the per-member budget before calling this. The
 * per-booking budget is charged here (`chargeBookingLimit`), only once the
 * caller is authorised and the document is on offer, so someone who merely
 * holds another member's booking id cannot spend that booking's allowance.
 */
export type BookingInvoiceDownload =
  | { kind: "PDF"; body: Buffer; fileName: string }
  | { kind: "NOT_FOUND" }
  | { kind: "RATE_LIMITED"; limit: RateLimitResult }
  | { kind: "XERO_NOT_CONNECTED" }
  | { kind: "XERO_UNAVAILABLE" }
  | { kind: "AUDIT_FAILED" };

/** Which of the booking's Xero documents a download asks for. */
export type BookingInvoiceDocument = { kind: "INVOICE" } | { kind: "CREDIT_NOTE"; creditNoteId: string };

const offerDependencies = {
  hasAnySupplementaryInvoice: bookingHasAnySupplementaryInvoiceEvidence,
  creditNotes: readBookingCreditNotes,
};

/**
 * The page's and the routes' one answer to "what invoice does this viewer get"
 * (`BookingInvoiceOffer`). With the Xero module off it is the generated
 * document's pure rule and nothing else. With it on, the supplementary and
 * credit-note reads run only once the cheap gates (audience, module,
 * lifecycle, primary invoice, ledger rows) have said yes.
 */
export async function resolveBookingInvoiceOffer(
  input: {
    booking: BookingDetailRecord;
    viewer: Pick<BookingDetailViewer, "canSeeOwnerCredit" | "nonOwnerAdminViewer">;
    modules: Pick<FeatureFlags, "xeroIntegration">;
  },
  dependencies = offerDependencies,
): Promise<BookingInvoiceOffer> {
  const { booking } = input;
  if (!input.modules.xeroIntegration) {
    return generatedBookingInvoiceOnOffer({ viewer: input.viewer, booking, xeroModuleOn: false }) ?? { kind: "NONE" };
  }
  const primary = primaryXeroInvoiceOnOffer({
    viewer: input.viewer,
    booking,
    xeroModuleOn: input.modules.xeroIntegration,
  });
  if (!primary) return { kind: "NONE" };
  const askClub = { kind: "ASK_CLUB", staffViewer: input.viewer.nonOwnerAdminViewer } as const;
  // The page's read loads the payment's ADDITIONAL rows (any status, withdrawn
  // included); one is enough to say a further invoice may exist.
  if ((booking.payment?.transactions.length ?? 0) > 0) return askClub;
  if (await dependencies.hasAnySupplementaryInvoice(booking.id)) return askClub;
  const creditNotes = await dependencies.creditNotes({
    id: booking.id,
    paymentId: booking.payment?.id ?? null,
    ownerMemberId: bookingOwner(booking).memberId,
    modificationIds: booking.modifications.map((modification) => modification.id),
  });
  return { kind: "XERO_INVOICE", invoiceNumber: primary.invoiceNumber, creditNotes };
}

/** `<club>-invoice-<number>.pdf` / `<club>-credit-note-<number>.pdf`, else the booking reference; header-safe characters only. */
export function bookingInvoiceFileName(
  clubShortName: string,
  bookingId: string,
  document: { kind: "INVOICE" | "CREDIT_NOTE"; number: string | null },
): string {
  const label = (document.number?.trim() || formatBookingReference(bookingId)).replace(/[^A-Za-z0-9._-]/g, "-");
  const stem = document.kind === "INVOICE" ? `invoice-${label}` : `credit-note-${label}`;
  return clubDownloadFilename(clubShortName, stem, "pdf");
}

const XERO_PDF_READ = {
  workflow: "bookingInvoiceDownload",
  maxRetries: 0,
  maxTransientRetries: 0,
  maxWaitSec: 0,
  armTransientBreaker: false,
} as const;

const downloadDependencies = {
  loadBooking: loadBookingDetail,
  modules: loadEffectiveModuleFlags,
  offer: resolveBookingInvoiceOffer,
  xeroConnected: isXeroConnected,
  clubShortName: async () => (await getClubIdentity()).shortName,
  fetchXeroInvoicePdf: async (invoiceId: string): Promise<Buffer> => {
    const { xero, tenantId } = await getAuthenticatedXeroClient();
    const result = await callXeroApi(() => xero.accountingApi.getInvoiceAsPdf(tenantId, invoiceId), {
      ...XERO_PDF_READ,
      operation: "getInvoiceAsPdf",
      resourceType: "INVOICE",
    });
    return Buffer.from(result.body);
  },
  fetchXeroCreditNotePdf: async (creditNoteId: string): Promise<Buffer> => {
    const { xero, tenantId } = await getAuthenticatedXeroClient();
    const result = await callXeroApi(() => xero.accountingApi.getCreditNoteAsPdf(tenantId, creditNoteId), {
      ...XERO_PDF_READ,
      operation: "getCreditNoteAsPdf",
      resourceType: "CREDIT_NOTE",
    });
    return Buffer.from(result.body);
  },
  renderGenerated: renderGeneratedBookingInvoice,
};

/** The one document a download serves, once the offer has said yes to it. */
type ServedDocument =
  | { kind: "GENERATED"; notYetApproved: boolean }
  | { kind: "XERO_INVOICE"; invoiceId: string; invoiceNumber: string | null }
  | { kind: "XERO_CREDIT_NOTE"; creditNote: BookingCreditNote };

/**
 * Which document the offer serves for this request, or null. Every refusal —
 * audience, module, lifecycle, no invoice, a further invoice, a credit note not
 * on this booking (or any credit note with Xero off) — is the same "not found",
 * so the answer reveals nothing about the booking.
 */
function servedDocument(
  offer: BookingInvoiceOffer,
  booking: BookingDetailRecord,
  document: BookingInvoiceDocument,
): ServedDocument | null {
  if (offer.kind === "GENERATED") {
    return document.kind === "INVOICE" ? { kind: "GENERATED", notYetApproved: offer.notYetApproved } : null;
  }
  if (offer.kind !== "XERO_INVOICE") return null;
  const invoiceId = booking.payment?.xeroInvoiceId;
  if (!invoiceId) return null;
  if (document.kind === "INVOICE") return { kind: "XERO_INVOICE", invoiceId, invoiceNumber: offer.invoiceNumber };
  const creditNote = offer.creditNotes.find((note) => note.creditNoteId === document.creditNoteId);
  return creditNote ? { kind: "XERO_CREDIT_NOTE", creditNote } : null;
}

type FetchedDocument =
  | { kind: "BODY"; body: Buffer; metadata: Record<string, unknown> }
  | Extract<BookingInvoiceDownload, { kind: "NOT_FOUND" | "XERO_NOT_CONNECTED" | "XERO_UNAVAILABLE" }>;

/** The PDF itself, with what the audit row records about which document it is. */
async function fetchServedDocument(
  served: ServedDocument,
  booking: BookingDetailRecord,
  dependencies: typeof downloadDependencies,
): Promise<FetchedDocument> {
  if (served.kind === "GENERATED") {
    try {
      const generated = await dependencies.renderGenerated(booking, served);
      return {
        kind: "BODY",
        body: generated.body,
        // What the club issued, so an officer can answer "what did we send?"
        // (review finding 11): the document's date and its figures.
        metadata: {
          source: "GENERATED",
          notYetApproved: served.notYetApproved,
          documentDate: generated.data.documentDate,
          totalCents: generated.data.totalCents,
          balanceCents: generated.balanceCents,
        },
      };
    } catch (error) {
      // Defensive: the offer ran the same line check on this same record, so
      // this means the two have drifted; answer as the button's stale page.
      if (error instanceof BookingInvoiceNotAvailableError) return { kind: "NOT_FOUND" };
      throw error;
    }
  }
  let body: Buffer;
  try {
    if (!(await dependencies.xeroConnected())) return { kind: "XERO_NOT_CONNECTED" };
    body =
      served.kind === "XERO_CREDIT_NOTE"
        ? await dependencies.fetchXeroCreditNotePdf(served.creditNote.creditNoteId)
        : await dependencies.fetchXeroInvoicePdf(served.invoiceId);
  } catch {
    return { kind: "XERO_UNAVAILABLE" };
  }
  if (body.length === 0) return { kind: "XERO_UNAVAILABLE" };
  return {
    kind: "BODY",
    body,
    metadata:
      served.kind === "XERO_CREDIT_NOTE"
        ? { source: "XERO", xeroCreditNoteNumber: served.creditNote.creditNoteNumber, creditNoteKind: served.creditNote.kind }
        : { source: "XERO", xeroInvoiceNumber: served.invoiceNumber },
  };
}

export async function prepareBookingInvoiceDownload(
  bookingId: string,
  session: BookingInvoiceSession,
  document: BookingInvoiceDocument,
  request: { ipAddress: string | null; chargeBookingLimit: () => Promise<RateLimitResult> },
  dependencies = downloadDependencies,
): Promise<BookingInvoiceDownload> {
  const booking = await dependencies.loadBooking(bookingId);
  if (!booking) return { kind: "NOT_FOUND" };
  const viewer = resolveBookingDetailViewer({ session, booking });
  const modules = await dependencies.modules();
  const offer = await dependencies.offer({ booking, viewer, modules });
  const served = servedDocument(offer, booking, document);
  if (!served) return { kind: "NOT_FOUND" };

  const bookingLimit = await request.chargeBookingLimit();
  if (!bookingLimit.success) return { kind: "RATE_LIMITED", limit: bookingLimit };

  const fetched = await fetchServedDocument(served, booking, dependencies);
  if (fetched.kind !== "BODY") return fetched;

  const isCreditNote = served.kind === "XERO_CREDIT_NOTE";
  const owner = bookingOwner(booking);
  try {
    await createAuditLog({
      action: isCreditNote ? "booking.credit_note.downloaded" : "booking.invoice.downloaded",
      memberId: session.user.id,
      actorMemberId: session.user.id,
      targetId: booking.id,
      // INV-PRIV-019: an organisation-owned booking records no subject member.
      subjectMemberId: owner.memberId,
      entityType: "Booking",
      entityId: booking.id,
      category: "booking",
      outcome: "success",
      summary: isCreditNote
        ? "Booking credit note downloaded"
        : served.kind === "GENERATED"
          ? "Booking invoice generated and downloaded"
          : "Booking invoice downloaded",
      metadata: { bookingId: booking.id, ...fetched.metadata, onBehalf: !viewer.isBookingOwner },
      ipAddress: request.ipAddress,
    });
  } catch {
    return { kind: "AUDIT_FAILED" };
  }
  const fileName = bookingInvoiceFileName(await dependencies.clubShortName(), booking.id, {
    kind: isCreditNote ? "CREDIT_NOTE" : "INVOICE",
    number:
      served.kind === "XERO_CREDIT_NOTE"
        ? served.creditNote.creditNoteNumber
        : served.kind === "XERO_INVOICE"
          ? served.invoiceNumber
          : null,
  });
  return { kind: "PDF", body: fetched.body, fileName };
}
