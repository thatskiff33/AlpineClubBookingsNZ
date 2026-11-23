import { Prisma } from "@prisma/client";
import { isPrismaKnownUniqueConstraintError } from "@/lib/prisma-known-errors";
import type { LineItem } from "xero-node";
import { prisma } from "../../prisma";
import logger from "../../logger";
import { exactPrefix } from "../../prisma-exact-prefix";
import { describeUniqueConstraintTarget } from "../../prisma-errors";
import { CHARGE_LEG_SELECT, chargeLegsOf, readBookingChargeLegs } from "./booking-journal-read";
import { memberMoneyEventKeys, reviewCloseKeyPrefix } from "./keys";
import { planSupplementaryBookingInvoice, type SliceEvent, type SupplementaryAnchor } from "./supplementary-invoice-plan";
import { writeExportManifest } from "./store";
import type { XeroTaxRendering } from "../../xero-tax-rendering";

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

/** A review task's one live closure: null when none stands, "AMBIGUOUS" when more than one does. */
async function readReviewClosure(
  db: Pick<Prisma.TransactionClient, "memberMoneyJournal">,
  bookingId: string,
  taskId: string,
): Promise<SliceEvent | null | "AMBIGUOUS"> {
  const closures = (await readSliceEvent(db, { eventKey: exactPrefix(reviewCloseKeyPrefix(taskId)) }, bookingId))
    .filter((event) => !event.reversed);
  if (closures.length > 1) return "AMBIGUOUS";
  return closures[0] ?? null;
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
  return readReviewClosure(db, bookingId, anchor.taskId);
}

/**
 * The closures of the settled review shares this invoice itemised, one per
 * task, in the order its lines show them: exactly the tasks the sender
 * rendered (`itemisedShareTaskIds` from `resolveModificationDocumentLineItems`),
 * never every share settled by the time the manifest is written. A share the
 * invoice did not itemise (the single fallback line, or one settled after the
 * lines were built) is not part of this invoice. A second ask bills no shares.
 */
export async function readItemisedShareSliceEvents(
  db: Pick<Prisma.TransactionClient, "memberMoneyJournal">,
  bookingId: string,
  anchor: SupplementaryAnchor,
  itemisedShareTaskIds: readonly string[],
): Promise<Array<SliceEvent | null | "AMBIGUOUS">> {
  if (anchor.kind !== "MODIFICATION") return [];
  const events: Array<SliceEvent | null | "AMBIGUOUS"> = [];
  for (const taskId of itemisedShareTaskIds) events.push(await readReviewClosure(db, bookingId, taskId));
  return events;
}

/** Record the manifest for the supplementary invoice just sent. A key already recorded keeps its first row. Never throws. */
export async function recordSupplementaryInvoiceManifest(input: {
  bookingId: string;
  anchor: SupplementaryAnchor;
  legacyKey: string;
  lines: LineItem[];
  /** The booking's tax rendering the invoice was sent with (#4632), frozen beside its lines. */
  taxRendering: XeroTaxRendering;
  priceLines: unknown;
  /** The tasks whose settled shares the sent lines itemise; empty for the single line. */
  itemisedShareTaskIds: readonly string[];
  providerInvoiceId: string;
}): Promise<void> {
  const { bookingId, providerInvoiceId } = input;
  try {
    const plan = planSupplementaryBookingInvoice({
      ...input,
      sliceEvent: await readSupplementarySliceEvent(prisma, bookingId, input.anchor),
      shareEvents: await readItemisedShareSliceEvents(prisma, bookingId, input.anchor, input.itemisedShareTaskIds),
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
    if (isPrismaKnownUniqueConstraintError(error)) {
      // The coverage key (role, account, charge, slice) is reported as its
      // index, "MemberMoneyExportCoverage_documentRole_account_chargeIdenti_key"
      // (PostgreSQL's 63-character cut), or as its fields; both carry
      // "chargeidenti" and the manifest's own key carries neither. Each slice is
      // keyed by the one event that moved it, so a second cover of a slice
      // should be unreachable: say so.
      if (describeUniqueConstraintTarget(error)?.includes("chargeidenti")) {
        logger.warn({ bookingId, providerInvoiceId }, "A slice this supplementary invoice bills is already covered by another manifest; this manifest was not recorded");
        return;
      }
      logger.info({ bookingId, providerInvoiceId }, "Another run recorded the supplementary invoice's manifest first; the first row stands");
      return;
    }
    logger.error({ err: error, bookingId, providerInvoiceId }, "Could not record the supplementary invoice's export manifest");
  }
}
