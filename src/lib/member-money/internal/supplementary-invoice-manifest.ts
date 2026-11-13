import { Prisma } from "@prisma/client";
import type { LineItem } from "xero-node";
import { prisma } from "../../prisma";
import logger from "../../logger";
import { exactPrefix } from "../../prisma-exact-prefix";
import { CHARGE_LEG_SELECT, chargeLegsOf, readBookingChargeLegs } from "./booking-journal-read";
import { memberMoneyEventKeys, reviewCloseKeyPrefix } from "./keys";
import { planSupplementaryBookingInvoice, type SliceEvent, type SupplementaryAnchor } from "./supplementary-invoice-plan";
import { writeExportManifest } from "./store";

/**
 * THE SUPPLEMENTARY INVOICE'S EXPORT MANIFEST, FOR THE SENDER (#4525, Ledger
 * M13; ALP-436). `createXeroSupplementaryInvoice` records it once its sync
 * operation has completed, in a short transaction of its own, the way the
 * primary invoice's is recorded (`primary-invoice-manifest.ts`). Nothing here
 * changes what is sent or how the operation ends: a failure is logged and
 * swallowed. The sender has no replay path, so a manifest that failed to write
 * stays unwritten until the same operation runs again (a stated limit). No
 * advisory lock: the manifest changes no booking status or settlement money,
 * and its unique keys are the exclusion.
 */

/** The live journal a slice is cut from: the event's, with its revenue legs and whether a reversal stands against it. */
async function readSliceEvent(db: Pick<Prisma.TransactionClient, "memberMoneyJournal">, where: Prisma.MemberMoneyEventWhereInput, bookingId: string): Promise<SliceEvent[]> {
  const journals = await db.memberMoneyJournal.findMany({
    where: { event: where, reversesJournalId: null },
    orderBy: { id: "asc" },
    select: {
      event: { select: { eventKey: true } },
      reversedBy: { select: { id: true } },
      lines: {
        where: chargeLegsOf([bookingId]),
        orderBy: { id: "asc" },
        select: CHARGE_LEG_SELECT,
      },
    },
  });
  return journals.map((journal) => ({ eventKey: journal.event.eventKey, reversed: journal.reversedBy !== null, legs: journal.lines }));
}

/** The event an anchor's slice is cut from: the edit's own, or the second ask's one review closure. */
export async function readSupplementarySliceEvent(
  db: Pick<Prisma.TransactionClient, "memberMoneyJournal">,
  bookingId: string,
  anchor: SupplementaryAnchor,
): Promise<SliceEvent | null | "AMBIGUOUS"> {
  if (anchor.kind === "MODIFICATION") {
    const [event] = await readSliceEvent(db, { eventKey: memberMoneyEventKeys.modification(anchor.modificationId) }, bookingId);
    return event ?? null;
  }
  const closures = (await readSliceEvent(db, { eventKey: exactPrefix(reviewCloseKeyPrefix(anchor.taskId)) }, bookingId))
    .filter((event) => !event.reversed);
  if (closures.length > 1) return "AMBIGUOUS";
  return closures[0] ?? null;
}

/** Record the manifest for the supplementary invoice just sent. A key already recorded keeps its first row. Never throws. */
export async function recordSupplementaryInvoiceManifest(input: {
  bookingId: string;
  anchor: SupplementaryAnchor;
  legacyKey: string;
  lines: LineItem[];
  priceLines: unknown;
  providerInvoiceId: string;
}): Promise<void> {
  const { bookingId, providerInvoiceId } = input;
  try {
    const plan = planSupplementaryBookingInvoice({
      ...input,
      sliceEvent: await readSupplementarySliceEvent(prisma, bookingId, input.anchor),
      postedLegs: await readBookingChargeLegs(prisma, bookingId),
    });
    const result = await prisma.$transaction((tx) => writeExportManifest(tx, {
      documentRole: "SUPPLEMENTARY_BOOKING_INVOICE",
      legacyKey: plan.legacyKey,
      bookingId,
      outcome: plan.outcome,
      reason: plan.outcome === "CONFLICT" ? plan.reason : null,
      payloadHash: plan.payloadHash,
      frozenMapping: plan.frozenMapping as Prisma.InputJsonObject,
      lineTotalCents: plan.lineTotalCents,
      providerInvoiceId,
      coverage: plan.outcome === "COVERED" ? plan.coverage : [],
    }));
    if (plan.outcome === "CONFLICT" && result === "WRITTEN") {
      logger.warn({ bookingId, providerInvoiceId, reason: plan.reason, problem: plan.problem }, "The supplementary invoice's lines do not match the journal; its manifest records a conflict");
    }
    if (result === "KEPT_FIRST") {
      logger.info({ bookingId, providerInvoiceId }, "The supplementary invoice's manifest was already recorded differently; the first row stands");
    }
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      logger.info({ bookingId, providerInvoiceId }, "Another run recorded the supplementary invoice's manifest, or billed its slice, first; the first row stands");
      return;
    }
    logger.error({ err: error, bookingId, providerInvoiceId }, "Could not record the supplementary invoice's export manifest");
  }
}
