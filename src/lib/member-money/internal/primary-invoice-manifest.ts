import { Prisma } from "@prisma/client";
import type { LineAmountTypes, LineItem } from "xero-node";
import { buildXeroBookingInvoiceCorrelationKey } from "../../xero-booking-invoice-key";
import { prisma } from "../../prisma";
import logger from "../../logger";
import { providerAmountToCents } from "../../money-provider-amount";
import { readBookingChargeLegs } from "./booking-journal-read";
import {
  planPrimaryBookingInvoice,
  planPrimaryInvoiceUpdate,
  planReplayedPrimaryBookingInvoice,
  type PrimaryInvoicePlan,
  type PrimaryInvoicePlanInput,
} from "./primary-invoice-plan";
import { writeExportManifest } from "./store";

/**
 * THE PRIMARY INVOICE'S EXPORT MANIFEST, FOR THE SENDER (#4525, Ledger M13).
 * `createXeroInvoiceForBooking` plans after it builds its lines, sends its own
 * lines, and records the plan once the invoice link is stored, in a short
 * transaction of its own. Nothing here changes what is sent or how the sync
 * operation ends: a failure is logged and swallowed, and the replay path
 * (the invoice id already stored) tries again from the stored request lines.
 * No advisory lock: the manifest changes no booking status or settlement money,
 * and its unique key is the exclusion.
 */

/** Plan the invoice from the booking's posted charge legs, or null (logged) when they cannot be read. */
export async function planPrimaryInvoiceManifest(input: Omit<PrimaryInvoicePlanInput, "postedLegs">): Promise<PrimaryInvoicePlan | null> {
  try {
    return planPrimaryBookingInvoice({ ...input, postedLegs: await readBookingChargeLegs(prisma, input.bookingId) });
  } catch (error) {
    logger.error({ err: error, bookingId: input.bookingId }, "Could not plan the primary invoice's export manifest");
    return null;
  }
}

export type PrimaryInvoiceManifestSource =
  | { kind: "BUILT"; bookingId: string; plan: PrimaryInvoicePlan | null }
  /** The replay: the claimed operation's stored `invoices[0].lineItems`, or null when it holds none. */
  | { kind: "REPLAY"; bookingId: string; storedLines: LineItem[] | null };

/**
 * Record the manifest for the invoice just linked. A plan writes COVERED and its
 * coverage, a conflict writes CONFLICT alone; a key already recorded keeps its
 * first row. Never throws.
 */
export async function recordPrimaryInvoiceManifest(source: PrimaryInvoiceManifestSource, providerInvoiceId: string): Promise<void> {
  const { bookingId } = source;
  try {
    let plan: PrimaryInvoicePlan | null;
    if (source.kind === "BUILT") {
      plan = source.plan;
    } else {
      if (!source.storedLines) return;
      plan = planReplayedPrimaryBookingInvoice({ bookingId, storedLines: source.storedLines, postedLegs: await readBookingChargeLegs(prisma, bookingId) });
    }
    if (!plan) return;
    const settled = plan;
    const result = await prisma.$transaction((tx) => writeExportManifest(tx, {
      documentRole: "PRIMARY_BOOKING_INVOICE",
      legacyKey: settled.legacyKey,
      bookingId,
      outcome: settled.outcome,
      reason: settled.outcome === "CONFLICT" ? settled.reason : null,
      payloadHash: settled.payloadHash,
      frozenMapping: settled.frozenMapping as Prisma.InputJsonObject,
      lineTotalCents: settled.lineTotalCents,
      providerInvoiceId,
      coverage: settled.outcome === "COVERED" ? settled.coverage : [],
    }));
    if (settled.outcome === "CONFLICT" && result === "WRITTEN") {
      logger.warn({ bookingId, providerInvoiceId, reason: settled.reason, problem: settled.problem }, "The primary invoice's lines do not match the journal; its manifest records a conflict");
    }
    if (result === "KEPT_FIRST") {
      logger.info({ bookingId, providerInvoiceId }, "The primary invoice's manifest was already recorded differently; the first row stands");
    }
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      logger.info({ bookingId, providerInvoiceId }, "Another run recorded the primary invoice's manifest first; the first row stands");
      return;
    }
    logger.error({ err: error, bookingId, providerInvoiceId }, "Could not record the primary invoice's export manifest; a replay tries again");
  }
}

/**
 * #4525 (ALP-436): record the manifest for an update just sent to an issued
 * primary invoice (`updateXeroBookingInvoiceForBooking`), beside the primary
 * manifest it stands on. Nothing is recorded when the booking's primary
 * invoice has no manifest (raised before M13). Never throws.
 */
export async function recordPrimaryInvoiceUpdateManifest(input: {
  bookingId: string;
  legacyKey: string;
  providerInvoiceId: string;
  lines: LineItem[];
  lineAmountTypes: LineAmountTypes;
  providerTotal: unknown;
}): Promise<void> {
  const { bookingId, providerInvoiceId } = input;
  try {
    const providerTotalCents = providerAmountToCents(input.providerTotal);
    if (providerTotalCents === null) {
      logger.warn({ bookingId, providerInvoiceId }, "Could not record the primary invoice update's manifest without a provider total");
      return;
    }
    const primary = await prisma.memberMoneyExportManifest.findUnique({
      where: { documentRole_legacyKey: { documentRole: "PRIMARY_BOOKING_INVOICE", legacyKey: buildXeroBookingInvoiceCorrelationKey(bookingId) } },
      select: { id: true, outcome: true, lineTotalCents: true, providerInvoiceId: true },
    });
    const plan = planPrimaryInvoiceUpdate({ ...input, providerTotalCents, primary });
    if (!plan) return;
    const result = await prisma.$transaction((tx) => writeExportManifest(tx, {
      documentRole: "PRIMARY_BOOKING_INVOICE_UPDATE",
      legacyKey: plan.legacyKey,
      bookingId,
      outcome: plan.outcome,
      reason: plan.outcome === "CONFLICT" ? plan.reason : null,
      payloadHash: plan.payloadHash,
      frozenMapping: plan.frozenMapping as Prisma.InputJsonObject,
      lineTotalCents: plan.lineTotalCents,
      providerInvoiceId,
      coverage: [],
    }));
    if (plan.outcome === "CONFLICT" && result === "WRITTEN") {
      logger.warn({ bookingId, providerInvoiceId, problem: plan.problem }, "The primary invoice's update does not match its manifest; the update's manifest records a conflict");
    }
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return;
    logger.error({ err: error, bookingId, providerInvoiceId }, "Could not record the primary invoice update's export manifest");
  }
}
