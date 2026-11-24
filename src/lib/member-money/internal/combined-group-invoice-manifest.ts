import { Prisma, type MemberMoneyAccount, type MemberMoneyExportCoverageReleaseReason } from "@prisma/client";
import type { LineItem } from "xero-node";
import { isPrismaKnownUniqueConstraintError } from "@/lib/prisma-known-errors";
import { prisma } from "../../prisma";
import logger from "../../logger";
import { storedInvoiceRequestLines } from "../../xero-json";
import { committedGroupChildrenWhere, storedGroupInvoiceChildBookingIds } from "../../xero-group-settlement-invoice-children";
import type { GroupSettlementInvoiceLines } from "../../xero-group-settlement-invoice-lines";
import {
  groupSettlementInvoiceCreateKey,
  parseGroupSettlementInvoiceAttempt,
} from "../../xero-group-settlement-invoice-outbox";
import type { XeroTaxRendering } from "../../xero-tax-rendering";
import { readBookingChargeLegs } from "./booking-journal-read";
import type { PostedRevenueLeg } from "./components";
import {
  planCombinedGroupInvoice,
  planReplayedCombinedGroupInvoice,
  type CombinedGroupInvoicePlan,
} from "./combined-group-invoice-plan";
import { confirmBilledPrimaryInvoice } from "./primary-invoice-plan";
import { readLiveInvoiceCoverage, releaseExportCoverage, writeExportManifest } from "./store";

type Db = Prisma.TransactionClient;

/**
 * THE COMBINED GROUP INVOICE'S EXPORT MANIFEST, FOR THE SENDER (#4525, Ledger
 * M13, ALP-437). `createXeroInvoiceForGroupSettlement` records an invoice it
 * kept (bound, not abandoned or cancelled) once the bind commits, in a short
 * transaction of its own; its already-bound returns replay the record from the
 * stored request. The void handlers release a combined invoice's coverage once
 * Xero holds it void or holds no such invoice, so the group's next invoice can
 * cover the same components. Nothing here changes what is sent, voided or
 * emailed, or how a sync operation ends: a failure is logged and swallowed.
 * No advisory lock: no booking status or settlement money changes
 * (`INV-LOCK-001`); the unique keys are the exclusion.
 */

export type CombinedGroupInvoiceManifestSource =
  /** A raise: the lines this run built and sent, and the lines Xero says the returned invoice bills. */
  | {
      kind: "BUILT";
      attempt: number;
      lines: Pick<GroupSettlementInvoiceLines, "byChild" | "hutFeeMapping" | "hutFeeItemCodeMap">;
      taxRendering: XeroTaxRendering;
      billedLines: LineItem[];
    }
  /**
   * The replay: the CREATE operation that raised this invoice is read back,
   * never rebuilt. `operationId` is the row the caller holds, tried when no row
   * names the invoice yet.
   */
  | { kind: "REPLAY"; operationId: string | null };

interface CombinedGroupInvoiceManifestTarget {
  settlementId: string;
  /** The organiser's booking: the manifest's booking. */
  organiserBookingId: string;
  providerInvoiceId: string;
}

/** The posted charge legs of each child, and what invoice-family documents still cover of them. */
async function readChildren(db: Db, bookingIds: readonly string[]) {
  const children: { bookingId: string; postedLegs: PostedRevenueLeg[] }[] = [];
  for (const bookingId of bookingIds) children.push({ bookingId, postedLegs: await readBookingChargeLegs(db, bookingId) });
  const components = new Map<string, { account: MemberMoneyAccount; chargeIdentity: string }>();
  for (const leg of children.flatMap((child) => child.postedLegs)) {
    if (leg.chargeIdentity !== null) components.set(`${leg.account}\u0000${leg.chargeIdentity}`, { account: leg.account, chargeIdentity: leg.chargeIdentity });
  }
  const liveCoverage = await readLiveInvoiceCoverage(db, [...components.values()]);
  return { children, liveCoverage };
}

/**
 * The CREATE row that raised `invoiceId`, else the caller's row: its stored
 * lines, basis, attempt and the children it billed (null on a request written
 * before those were recorded).
 */
async function readStoredCombinedInvoice(settlementId: string, invoiceId: string, operationId: string | null) {
  const where = {
    entityType: "INVOICE", operationType: "CREATE", localModel: "GroupBookingSettlement", localId: settlementId,
  } as const;
  const rows = await prisma.xeroSyncOperation.findMany({
    where: { ...where, OR: [{ xeroObjectId: invoiceId }, ...(operationId ? [{ id: operationId, xeroObjectId: null }] : [])] },
    orderBy: { createdAt: "asc" },
    select: { correlationKey: true, requestPayload: true, xeroObjectId: true },
  });
  // A row Xero's answer named first; the caller's own row only when none does.
  rows.sort((a, b) => Number(b.xeroObjectId === invoiceId) - Number(a.xeroObjectId === invoiceId));
  for (const row of rows) {
    const { storedLines, storedLineAmountTypes } = storedInvoiceRequestLines(row.requestPayload);
    const attempt = parseGroupSettlementInvoiceAttempt(settlementId, row.correlationKey);
    if (storedLines && storedLines.length > 0 && attempt !== null) {
      return { storedLines, storedLineAmountTypes, attempt, childBookingIds: storedGroupInvoiceChildBookingIds(row.requestPayload) };
    }
  }
  return null;
}

/**
 * Record the manifest for a combined invoice the sender kept. A plan writes
 * COVERED and each child's coverage, a conflict writes CONFLICT alone; a key
 * already recorded keeps its first row. Never throws.
 */
export async function recordCombinedGroupInvoiceManifest(
  source: CombinedGroupInvoiceManifestSource,
  target: CombinedGroupInvoiceManifestTarget,
): Promise<void> {
  const { settlementId, organiserBookingId, providerInvoiceId } = target;
  const context = { settlementId, providerInvoiceId };
  try {
    const stored = source.kind === "REPLAY" ? await readStoredCombinedInvoice(settlementId, providerInvoiceId, source.operationId) : null;
    if (source.kind === "REPLAY" && !stored) return;
    // A replay matches the children the stored request billed. A request
    // written before those were recorded falls back to the children committed
    // now, matched on totals (ledger §7 states that limit).
    const childIds = source.kind === "BUILT"
      ? source.lines.byChild.map((child) => child.bookingId)
      : stored!.childBookingIds
        ?? (await prisma.booking.findMany({ where: committedGroupChildrenWhere(organiserBookingId), orderBy: { id: "asc" }, select: { id: true } }))
          .map((child) => child.id);
    const { plan, result } = await prisma.$transaction(async (tx) => {
      // Any invoice still covering a child's component, an earlier attempt of
      // this same settlement included, makes the plan ALREADY_COVERED: a
      // visible conflict row with no coverage, never nothing (owner decision,
      // 25 Nov 2026, #4525). The earlier invoice may carry money and keep its
      // cover, so waiting for its release could leave this one unrecorded.
      const { children, liveCoverage } = await readChildren(tx, childIds);
      let planned: CombinedGroupInvoicePlan;
      if (source.kind === "BUILT") {
        const legs = new Map(children.map((child) => [child.bookingId, child.postedLegs]));
        planned = confirmBilledPrimaryInvoice(planCombinedGroupInvoice({
          legacyKey: groupSettlementInvoiceCreateKey(settlementId, source.attempt),
          liveCoverage,
          children: source.lines.byChild.map((child) => ({ ...child, postedLegs: legs.get(child.bookingId) ?? [] })),
          taxRendering: source.taxRendering,
          hutFeeMapping: source.lines.hutFeeMapping,
          hutFeeItemCodeMap: source.lines.hutFeeItemCodeMap,
        }), source.billedLines);
      } else {
        planned = planReplayedCombinedGroupInvoice({
          legacyKey: groupSettlementInvoiceCreateKey(settlementId, stored!.attempt),
          liveCoverage,
          storedLines: stored!.storedLines,
          storedLineAmountTypes: stored!.storedLineAmountTypes,
          children,
        });
      }
      const written = await writeExportManifest(tx, {
        documentRole: "COMBINED_GROUP_INVOICE",
        legacyKey: planned.legacyKey,
        bookingId: organiserBookingId,
        settlementId,
        outcome: planned.outcome,
        reason: planned.outcome === "CONFLICT" ? planned.reason : null,
        payloadHash: planned.payloadHash,
        frozenMapping: planned.frozenMapping as Prisma.InputJsonObject,
        lineTotalCents: planned.lineTotalCents,
        providerInvoiceId,
        coverage: planned.outcome === "COVERED" ? planned.coverage : [],
      });
      return { plan: planned, result: written };
    });
    if (plan.outcome === "CONFLICT" && result === "WRITTEN") {
      logger.warn({ ...context, reason: plan.reason, problem: plan.problem }, "The combined group invoice's lines do not match the journal, or another invoice still covers a component; its manifest records a conflict and the invoice still sent");
    }
    if (result === "KEPT_FIRST") {
      logger.info(context, "The combined group invoice's manifest was already recorded differently; the first row stands");
    }
  } catch (error) {
    if (isPrismaKnownUniqueConstraintError(error)) {
      logger.info(context, "Another document covered these components first, or another run recorded this manifest first; the first row stands");
      return;
    }
    logger.error({ err: error, ...context }, "Could not record the combined group invoice's export manifest; a replay tries again");
  }
}

/**
 * A combined invoice Xero holds void, or holds no such invoice: end its
 * manifest's coverage with a release row, then, when the settlement is now bound
 * to a different invoice, try that invoice's record again. That only writes a
 * manifest the bound invoice does not have yet (its own record failed or has
 * not run): one already recorded, an ALREADY_COVERED conflict behind this
 * invoice's cover included, keeps its first row, so a release never adds
 * coverage beside it. Never on an invoice carrying money: the caller decides
 * that. Never throws.
 */
export async function releaseCombinedGroupInvoiceManifest(input: {
  settlementId: string;
  invoiceId: string;
  reason: MemberMoneyExportCoverageReleaseReason;
}): Promise<void> {
  const { settlementId, invoiceId, reason } = input;
  try {
    const manifests = await prisma.memberMoneyExportManifest.findMany({
      where: { documentRole: "COMBINED_GROUP_INVOICE", settlementId, providerInvoiceId: invoiceId, release: { is: null } },
      select: { id: true },
    });
    if (manifests.length > 0) {
      await prisma.$transaction(async (tx) => {
        for (const manifest of manifests) await releaseExportCoverage(tx, manifest.id, reason);
      });
    }
    const settlement = await prisma.groupBookingSettlement.findUnique({
      where: { id: settlementId },
      select: { xeroInvoiceId: true, groupBooking: { select: { organiserBookingId: true } } },
    });
    if (settlement?.xeroInvoiceId && settlement.xeroInvoiceId !== invoiceId) {
      await recordCombinedGroupInvoiceManifest({ kind: "REPLAY", operationId: null }, {
        settlementId,
        organiserBookingId: settlement.groupBooking.organiserBookingId,
        providerInvoiceId: settlement.xeroInvoiceId,
      });
    }
  } catch (error) {
    logger.error({ err: error, settlementId, invoiceId }, "Could not release the combined group invoice's export coverage; the void is unchanged");
  }
}
