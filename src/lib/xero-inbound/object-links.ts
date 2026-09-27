import { prisma } from "@/lib/prisma";
import { type XeroObjectLinkInput } from "@/lib/xero-sync";
import { type ResolvedXeroObjectLink } from "./types";
import { BOOKING_SCOPED_OUTBOUND_MODELS } from "./constants";

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

export function getDerivedInboundPaymentRole(link: Pick<ResolvedXeroObjectLink, "xeroObjectType" | "role">) {
  if (link.xeroObjectType === "PAYMENT") {
    return link.role;
  }

  switch (link.role) {
    case "PRIMARY_INVOICE":
      return "INVOICE_PAYMENT";
    case "SUPPLEMENTARY_INVOICE":
      return "SUPPLEMENTARY_INVOICE_PAYMENT";
    case "SUBSCRIPTION_INVOICE":
      return "SUBSCRIPTION_PAYMENT";
    case "REFUND_CREDIT_NOTE":
      return "REFUND_PAYMENT";
    default:
      return null;
  }
}

/**
 * #3643 (`INV-PAY-107`): the roles `getDerivedInboundPaymentRole` gives a
 * payment against a booking's OWN invoices — primary and supplementary.
 */
export const BOOKING_INVOICE_PAYMENT_ROLES = [
  "INVOICE_PAYMENT",
  "SUPPLEMENTARY_INVOICE_PAYMENT",
] as const;

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
  return String(status ?? "").toUpperCase() !== "DELETED";
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
