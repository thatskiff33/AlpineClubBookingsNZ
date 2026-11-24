import { Prisma, type MemberMoneyAccount, type MemberMoneyExportCoverageReleaseReason } from "@prisma/client";
import type { LineItem } from "xero-node";
import { isPrismaKnownUniqueConstraintError } from "@/lib/prisma-known-errors";
import { prisma } from "../../prisma";
import logger from "../../logger";
import { storedInvoiceRequestLines } from "../../xero-json";
import { committedGroupChildrenWhere, storedGroupInvoiceChildBookingIds } from "../../xero-group-settlement-invoice-children";
import type { GroupSettlementInvoiceLines } from "../../xero-group-settlement-invoice-lines";
import {
  currentGroupSettlementInvoiceAttempt,
  groupSettlementInvoiceCreateKey,
  groupSettlementInvoiceVoidEnded,
  groupSettlementInvoiceVoidKey,
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
import { coveredAfterReleaseKey, isCoverableConflict, readLiveInvoiceCoverage, releaseExportCoverage, writeExportManifest } from "./store";

type Db = Prisma.TransactionClient;
const ROLE = "COMBINED_GROUP_INVOICE" as const;

/**
 * THE COMBINED GROUP INVOICE'S EXPORT MANIFEST, FOR THE SENDER (#4525, Ledger
 * M13, ALP-437). `createXeroInvoiceForGroupSettlement` records an invoice it
 * kept (bound, not abandoned or cancelled) once the bind commits, in a short
 * transaction of its own; its already-bound returns replay the record from the
 * stored request. The void handlers release a combined invoice's coverage once
 * Xero holds it void or holds no such invoice, so the group's next invoice can
 * cover the same components, a replacement already recorded as an
 * ALREADY_COVERED conflict included (its successor manifest, owner decision
 * 25 Nov 2026). A record that commits after its own invoice's void released
 * nothing reads the VOID's finished row and releases itself; the handler
 * releases once more after that row commits. Nothing here changes what is
 * sent, voided or emailed, or how a sync operation ends: a failure is logged
 * and swallowed.
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
 *
 * A caller with no row of its own (the release's retry of the bound invoice)
 * also reads the current attempt's row by its key while that row names no
 * invoice yet: the CREATE writes `xeroObjectId` only once the invoice's email
 * has been sent, after the bind, so a release committed meanwhile would
 * otherwise find nothing and leave the replacement's ALREADY_COVERED conflict
 * uncovered. A bind only takes the current attempt's invoice, and a later
 * attempt is queued only once the settlement has let that invoice go.
 */
async function readStoredCombinedInvoice(settlementId: string, invoiceId: string, operationId: string | null) {
  const where = {
    entityType: "INVOICE", operationType: "CREATE", localModel: "GroupBookingSettlement", localId: settlementId,
  } as const;
  const currentAttempt = operationId ? null : await currentGroupSettlementInvoiceAttempt(prisma, settlementId);
  const unnamed = operationId
    ? [{ id: operationId, xeroObjectId: null }]
    : currentAttempt === null ? [] : [{ correlationKey: groupSettlementInvoiceCreateKey(settlementId, currentAttempt), xeroObjectId: null }];
  const rows = await prisma.xeroSyncOperation.findMany({
    where: { ...where, OR: [{ xeroObjectId: invoiceId }, ...unnamed] },
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
 * already recorded keeps its first row. An ALREADY_COVERED conflict whose
 * blocking cover has since been released gains its successor's cover. Never
 * throws.
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
    const attemptKey = groupSettlementInvoiceCreateKey(settlementId, source.kind === "BUILT" ? source.attempt : stored!.attempt);

    /** The plan under `legacyKey`, against the children's posted legs and what every invoice covers now. */
    const planUnder = async (tx: Db, legacyKey: string): Promise<CombinedGroupInvoicePlan> => {
      const { children, liveCoverage } = await readChildren(tx, childIds);
      if (source.kind === "BUILT") {
        const legs = new Map(children.map((child) => [child.bookingId, child.postedLegs]));
        return confirmBilledPrimaryInvoice(planCombinedGroupInvoice({
          legacyKey,
          liveCoverage,
          children: source.lines.byChild.map((child) => ({ ...child, postedLegs: legs.get(child.bookingId) ?? [] })),
          taxRendering: source.taxRendering,
          hutFeeMapping: source.lines.hutFeeMapping,
          hutFeeItemCodeMap: source.lines.hutFeeItemCodeMap,
        }), source.billedLines);
      }
      return planReplayedCombinedGroupInvoice({
        legacyKey,
        liveCoverage,
        storedLines: stored!.storedLines,
        storedLineAmountTypes: stored!.storedLineAmountTypes,
        children,
      });
    };
    const write = (tx: Db, planned: CombinedGroupInvoicePlan) => writeExportManifest(tx, {
      documentRole: ROLE,
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

    // 1. The attempt's own row. Any invoice still covering a child's component,
    // an earlier attempt of this same settlement included, makes the plan
    // ALREADY_COVERED: a visible conflict row with no coverage, never nothing
    // (owner decision, 25 Nov 2026, #4525). The earlier invoice may carry money
    // and keep its cover, so waiting for its release could leave this one
    // unrecorded.
    let mayBeBlocked = true;
    try {
      const { plan, result } = await prisma.$transaction(async (tx) => {
        const planned = await planUnder(tx, attemptKey);
        return { plan: planned, result: await write(tx, planned) };
      });
      if (plan.outcome === "CONFLICT" && result === "WRITTEN") {
        logger.warn({ ...context, reason: plan.reason, problem: plan.problem }, "The combined group invoice's lines do not match the journal, or another invoice still covers a component; its manifest records a conflict and the invoice still sent");
      }
      if (result === "KEPT_FIRST") {
        logger.info(context, "The combined group invoice's manifest was already recorded differently; the first row stands");
      }
      // A row this run wrote is the conflict only when it planned one.
      mayBeBlocked = result !== "WRITTEN" || (plan.outcome === "CONFLICT" && plan.reason === "ALREADY_COVERED");
    } catch (error) {
      if (!isPrismaKnownUniqueConstraintError(error)) throw error;
      // Another run wrote the attempt's row first: step 2 reads what it wrote.
      logger.info(context, "Another document covered these components first, or another run recorded this manifest first; the first row stands");
    }
    // A row committed after this invoice's own void released nothing (the
    // void's release ran first) would cover for good: end it now. Before step
    // 2, so a released conflict gains no successor.
    await releaseIfVoidFinished(settlementId, providerInvoiceId);
    if (!mayBeBlocked) return;

    // 2. Cover on release (owner decision, 25 Nov 2026, #4525). The attempt's
    // ALREADY_COVERED conflict, re-planned now: once the cover it met is
    // released the plan is COVERED, and its successor manifest records the
    // coverage at the next generation; the conflict stays as history. While
    // that cover is live (the earlier invoice carries money, or is not void
    // yet) the plan is still ALREADY_COVERED and nothing is written. It runs in
    // a transaction after step 1's commit, as the release's retry runs after
    // the release's: whichever commits second sees the other.
    const covered = await prisma.$transaction(async (tx) => {
      if (!(await isCoverableConflict(tx, ROLE, attemptKey))) return null;
      const planned = await planUnder(tx, coveredAfterReleaseKey(attemptKey));
      return planned.outcome === "COVERED" ? write(tx, planned) : null;
    });
    if (covered === "WRITTEN") {
      logger.info(context, "The cover the combined group invoice's ALREADY_COVERED conflict met was released; its components are covered now");
      // This invoice's own void may have released its conflict while the
      // successor was being written: end the successor's cover too.
      await releaseLikeAnyReleased(settlementId, providerInvoiceId);
    }
  } catch (error) {
    if (isPrismaKnownUniqueConstraintError(error)) {
      logger.info(context, "Another document covered these components first, or another run recorded this manifest first; the first row stands");
      return;
    }
    logger.error({ err: error, ...context }, "Could not record the combined group invoice's export manifest; a replay tries again");
  }
}

/** Release every manifest of one combined invoice not yet released: its attempt's row and any successor. */
async function releaseUnreleased(settlementId: string, invoiceId: string, reason: MemberMoneyExportCoverageReleaseReason): Promise<void> {
  const manifests = await prisma.memberMoneyExportManifest.findMany({
    where: { documentRole: ROLE, settlementId, providerInvoiceId: invoiceId, release: { is: null } },
    select: { id: true },
  });
  if (manifests.length === 0) return;
  await prisma.$transaction(async (tx) => {
    for (const manifest of manifests) await releaseExportCoverage(tx, manifest.id, reason);
  });
}

/** When any manifest of one combined invoice is released, release the rest for the same reason. */
async function releaseLikeAnyReleased(settlementId: string, invoiceId: string): Promise<void> {
  const released = await prisma.memberMoneyExportManifest.findFirst({
    where: { documentRole: ROLE, settlementId, providerInvoiceId: invoiceId, release: { isNot: null } },
    select: { release: { select: { reason: true } } },
  });
  if (released?.release) await releaseUnreleased(settlementId, invoiceId, released.release.reason);
}

/**
 * When the invoice's VOID operation has finished with it void or gone in Xero,
 * release every manifest of it for that reason. The VOID's row is the void's
 * own record, committed by its handler before the handler's last release
 * (`releaseCombinedGroupInvoiceManifest`, called again after the completion):
 * a manifest committed before this read is released by that last pass, and one
 * this read sees finished is released here, whichever commits second.
 */
async function releaseIfVoidFinished(settlementId: string, invoiceId: string): Promise<void> {
  const voids = await prisma.xeroSyncOperation.findMany({
    where: {
      entityType: "INVOICE", operationType: "UPDATE", localModel: "GroupBookingSettlement", localId: settlementId, status: "SUCCEEDED",
      correlationKey: { in: [groupSettlementInvoiceVoidKey(settlementId, invoiceId, "cancel"), groupSettlementInvoiceVoidKey(settlementId, invoiceId, "abandon")] },
    },
    orderBy: { createdAt: "asc" },
    select: { responsePayload: true },
  });
  const reason = voids.map((row) => groupSettlementInvoiceVoidEnded(row.responsePayload)).find((ended) => ended !== null);
  if (reason) await releaseUnreleased(settlementId, invoiceId, reason);
}

/**
 * A combined invoice Xero holds void, or holds no such invoice: end its
 * manifests' coverage with release rows, then, when the settlement is now
 * bound to a different invoice, try that invoice's record again. The retry
 * writes the bound invoice's manifest if it has none yet (its own record
 * failed or has not run), and turns its ALREADY_COVERED conflict behind this
 * invoice's cover into cover at the next generation, under the conflict's
 * successor key (owner decision, 25 Nov 2026, #4525). Never on an invoice
 * carrying money: the caller decides that, and that invoice's replacement
 * keeps its conflict. Never throws.
 */
export async function releaseCombinedGroupInvoiceManifest(input: {
  settlementId: string;
  invoiceId: string;
  reason: MemberMoneyExportCoverageReleaseReason;
}): Promise<void> {
  const { settlementId, invoiceId, reason } = input;
  try {
    await releaseUnreleased(settlementId, invoiceId, reason);
    // Once more after that commit: a successor this invoice's own record wrote
    // beside the first pass is released here, or its writer sees this release
    // (`releaseLikeAnyReleased`), whichever commits second.
    await releaseUnreleased(settlementId, invoiceId, reason);
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
