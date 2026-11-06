import { prisma } from "@/lib/prisma";
import { type XeroObjectLinkInput } from "@/lib/xero-sync";
import { isRefundCreditNoteLinkCancelledInXero } from "@/lib/xero-refund-note-status";
import { type ResolvedXeroObjectLink } from "./types";
import { BOOKING_SCOPED_OUTBOUND_MODELS } from "./constants";
import { isLiveXeroPaymentStatus } from "@/lib/xero-payment-status";

export function dedupeXeroObjectLinks(links: XeroObjectLinkInput[]): XeroObjectLinkInput[] {
  const seen = new Map<string, XeroObjectLinkInput>();

  for (const link of links) {
    seen.set(
      [
        link.localModel,
        link.localId,
        link.xeroObjectType,
        link.xeroObjectId,
        link.role,
      ].join(":"),
      link
    );
  }

  return Array.from(seen.values());
}

export function dedupeResolvedXeroObjectLinks(
  links: ResolvedXeroObjectLink[]
): ResolvedXeroObjectLink[] {
  const seen = new Map<string, ResolvedXeroObjectLink>();

  for (const link of links) {
    seen.set(
      [
        link.localModel,
        link.localId,
        link.xeroObjectType,
        link.role,
      ].join(":"),
      link
    );
  }

  return Array.from(seen.values());
}

/** #3643: the payment roles on a booking's own invoices, named once. */
export const INVOICE_PAYMENT_ROLE = "INVOICE_PAYMENT";

/**
 * #3979: the primary-invoice link's metadata key recording that the invoice
 * was paid, wholly or partly, by applied overpayments or prepayments - which
 * Xero records as allocations, leaving no payment to link: their count, 0 once
 * there are none (#4095). The inbound invoice sync writes it every sync; the
 * settled-cash audit reads it, and a link without it was last synced before.
 */
export const PRIMARY_INVOICE_CASH_ALLOCATIONS_KEY = "overpaymentOrPrepaymentAllocations";
export const SUPPLEMENTARY_INVOICE_PAYMENT_ROLE = "SUPPLEMENTARY_INVOICE_PAYMENT";
export const SUBSCRIPTION_PAYMENT_ROLE = "SUBSCRIPTION_PAYMENT";
export const REFUND_PAYMENT_ROLE = "REFUND_PAYMENT";

/**
 * #4531 (`INV-SSOT`): an invoice link's role -> the role of a payment on that
 * invoice. The one map `getDerivedInboundPaymentRole` reads and
 * `INVOICE_DERIVED_PAYMENT_ROLES` is built from, so an invoice role added here
 * is both derived and a deleted-payment candidate.
 */
export const INVOICE_LINK_PAYMENT_ROLES = {
  PRIMARY_INVOICE: INVOICE_PAYMENT_ROLE,
  SUPPLEMENTARY_INVOICE: SUPPLEMENTARY_INVOICE_PAYMENT_ROLE,
  SUBSCRIPTION_INVOICE: SUBSCRIPTION_PAYMENT_ROLE,
} as const;

export function getDerivedInboundPaymentRole(link: Pick<ResolvedXeroObjectLink, "xeroObjectType" | "role">) {
  if (link.xeroObjectType === "PAYMENT") {
    return link.role;
  }

  if (Object.hasOwn(INVOICE_LINK_PAYMENT_ROLES, link.role)) {
    return INVOICE_LINK_PAYMENT_ROLES[link.role as keyof typeof INVOICE_LINK_PAYMENT_ROLES];
  }
  return link.role === "REFUND_CREDIT_NOTE" ? REFUND_PAYMENT_ROLE : null;
}

/**
 * #3643 (`INV-PAY-107`): the roles `getDerivedInboundPaymentRole` gives a
 * payment against a booking's OWN invoices — primary and supplementary.
 */
export const BOOKING_INVOICE_PAYMENT_ROLES = [
  INVOICE_PAYMENT_ROLE,
  SUPPLEMENTARY_INVOICE_PAYMENT_ROLE,
] as const;

/**
 * #4531: the roles `getDerivedInboundPaymentRole` gives a payment on an
 * invoice's own links (primary, supplementary, subscription) - every payment
 * link the inbound invoice reconcile writes. Only these are a deleted-payment
 * candidate on an invoice read; a refund payment naming the invoice sits on its
 * credit note, never in the invoice's `Payments`.
 */
export const INVOICE_DERIVED_PAYMENT_ROLES: readonly string[] = Object.values(INVOICE_LINK_PAYMENT_ROLES);

// The payment-status rule lives in one pure module (#4576); re-exported here for
// the inbound reconcile's existing callers.
export { DELETED_XERO_PAYMENT_STATUS, isDeletedXeroPaymentStatus } from "@/lib/xero-payment-status";

/**
 * #3643: whether a stored link records money paid against a booking's invoice.
 * A part payment leaves nothing else locally (the booking settles only when the
 * invoice is fully paid), so this is what the hold-expiry job and the repair
 * tool read. A payment Xero reported as DELETED (reversed) is not money held.
 */
export function isRecordedBookingInvoicePayment(link: {
  xeroObjectType: string;
  role: string | null;
  metadata: unknown;
}): boolean {
  if (link.xeroObjectType !== "PAYMENT") return false;
  if (!(BOOKING_INVOICE_PAYMENT_ROLES as readonly string[]).includes(link.role ?? "")) {
    return false;
  }
  const status =
    link.metadata && typeof link.metadata === "object"
      ? (link.metadata as { status?: unknown }).status
      : null;
  // Neither DELETED nor VOIDED: the one live-payment rule (#4576).
  return isLiveXeroPaymentStatus(status);
}

export function getDerivedInboundAllocationRole(creditNoteRole: string) {
  return creditNoteRole === "MODIFICATION_CREDIT_NOTE"
    ? "MODIFICATION_CREDIT_NOTE_ALLOCATION"
    : "CREDIT_NOTE_ALLOCATION";
}

function getRecoveredBookingScopedRole(
  xeroObjectType: "INVOICE" | "CREDIT_NOTE"
) {
  return xeroObjectType === "INVOICE"
    ? "SUPPLEMENTARY_INVOICE"
    : "MODIFICATION_CREDIT_NOTE";
}

export async function findActiveXeroObjectLinks(
  xeroObjectType: string | string[],
  xeroObjectId: string
): Promise<ResolvedXeroObjectLink[]> {
  return prisma.xeroObjectLink.findMany({
    where: {
      xeroObjectId,
      xeroObjectType: Array.isArray(xeroObjectType)
        ? {
            in: xeroObjectType,
          }
        : xeroObjectType,
      active: true,
    },
    select: {
      localModel: true,
      localId: true,
      xeroObjectType: true,
      role: true,
    },
  });
}

/**
 * #4291 (`INV-ADDPAY-041`): the payments whose refund-note mirror of
 * `creditNoteId` a void turned off - inactive, its recorded status VOIDED or
 * DELETED (#2901, #4091, #4161's heal). That write also released the payment's
 * pointer, so neither an active link nor the pointer names the payment any
 * more. The inbound reconcile of a cancelled note still recounts these
 * payments, so a redelivery, the retry of an event that failed after its link
 * write, or an operator's replay finishes the recount. Read-only: the mirror
 * stays off and the note is never re-adopted. A mirror retired while its note
 * was live (no recorded void) is not one of these.
 */
export async function findPaymentIdsWithCancelledRefundNoteMirror(creditNoteId: string): Promise<string[]> {
  const links = await prisma.xeroObjectLink.findMany({
    where: {
      localModel: "Payment",
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: creditNoteId,
      role: "REFUND_CREDIT_NOTE",
      active: false,
    },
    select: { localId: true, metadata: true },
  });
  return [
    ...new Set(
      links.filter((link) => isRefundCreditNoteLinkCancelledInXero(link.metadata)).map((link) => link.localId),
    ),
  ];
}

export async function recoverBookingScopedLinksFromOutboundOperations(
  xeroObjectType: "INVOICE" | "CREDIT_NOTE",
  xeroObjectId: string
): Promise<ResolvedXeroObjectLink[]> {
  const operations = await prisma.xeroSyncOperation.findMany({
    where: {
      direction: "OUTBOUND",
      entityType: xeroObjectType,
      operationType: "CREATE",
      xeroObjectId,
      localModel: {
        in: [...BOOKING_SCOPED_OUTBOUND_MODELS],
      },
      localId: {
        not: null,
      },
      status: {
        in: ["SUCCEEDED", "PARTIAL"],
      },
    },
    orderBy: {
      createdAt: "desc",
    },
    select: {
      localModel: true,
      localId: true,
    },
  });

  const role = getRecoveredBookingScopedRole(xeroObjectType);

  return dedupeResolvedXeroObjectLinks(
    operations.flatMap((operation) =>
      operation.localModel && operation.localId
        ? [
            {
              localModel: operation.localModel,
              localId: operation.localId,
              xeroObjectType,
              role,
            },
          ]
        : []
    )
  );
}
