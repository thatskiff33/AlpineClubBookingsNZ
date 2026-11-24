import { Prisma, type MemberMoneyAccount, type MemberMoneyExportCoverageReleaseReason } from "@prisma/client";
import type { LineItem } from "xero-node";
import { z } from "zod";
import { isPrismaKnownUniqueConstraintError } from "@/lib/prisma-known-errors";
import { prisma } from "../../prisma";
import { decodeRawRows } from "../../raw-sql-rows";
import logger from "../../logger";
import { storedInvoiceRequestLines } from "../../xero-json";
import { committedGroupChildrenWhere, storedGroupInvoiceChildBookingIds } from "../../xero-group-settlement-invoice-children";
import type { GroupSettlementInvoiceLines } from "../../xero-group-settlement-invoice-lines";
import {
  currentGroupSettlementInvoiceAttempt,
  GROUP_SETTLEMENT_INVOICE_VOID_ENDED_FLAGS,
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
 * and swallowed. The payments cycle's sweep (`sweepVoidedCombinedGroupInvoiceCover`)
 * releases whatever a VOID ended and no handler or recorder released.
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
 *
 * Those reads take no lock, so the invoice may be let go and the next attempt
 * queued between them: its unnamed row would then be read as this invoice's.
 * The binding is read again after the rows, and an unnamed row is kept only
 * while the settlement still names `invoiceId`. An abandoned invoice is never
 * bound again, so a binding seen before and after the reads held throughout,
 * and no later attempt existed while they ran.
 */
async function readStoredCombinedInvoice(settlementId: string, invoiceId: string, operationId: string | null) {
  const where = {
    entityType: "INVOICE", operationType: "CREATE", localModel: "GroupBookingSettlement", localId: settlementId,
  } as const;
  const currentAttempt = operationId ? null : await currentGroupSettlementInvoiceAttempt(prisma, settlementId);
  const unnamed = operationId
    ? [{ id: operationId, xeroObjectId: null }]
    : currentAttempt === null ? [] : [{ correlationKey: groupSettlementInvoiceCreateKey(settlementId, currentAttempt), xeroObjectId: null }];
  let rows = await prisma.xeroSyncOperation.findMany({
    where: { ...where, OR: [{ xeroObjectId: invoiceId }, ...unnamed] },
    orderBy: { createdAt: "asc" },
    select: { correlationKey: true, requestPayload: true, xeroObjectId: true },
  });
  if (!operationId && rows.some((row) => row.xeroObjectId !== invoiceId)) {
    const bound = await prisma.groupBookingSettlement.findUnique({ where: { id: settlementId }, select: { xeroInvoiceId: true } });
    if (bound?.xeroInvoiceId !== invoiceId) rows = rows.filter((row) => row.xeroObjectId === invoiceId);
  }
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
 * How each invoice's VOID operation ended it, keyed `settlementId\u0000invoiceId`,
 * for the invoices whose VOID finished void or not in Xero (never one carrying
 * money). One read for any number of invoices, by the VOIDs' own keys.
 */
async function finishedVoidReasons(
  invoices: ReadonlyArray<{ settlementId: string; invoiceId: string }>,
): Promise<Map<string, MemberMoneyExportCoverageReleaseReason>> {
  const invoiceOfKey = new Map<string, string>();
  for (const { settlementId, invoiceId } of invoices) {
    for (const path of ["cancel", "abandon"] as const) {
      invoiceOfKey.set(groupSettlementInvoiceVoidKey(settlementId, invoiceId, path), invoicePairKey(settlementId, invoiceId));
    }
  }
  const reasons = new Map<string, MemberMoneyExportCoverageReleaseReason>();
  if (invoiceOfKey.size === 0) return reasons;
  const voids = await prisma.xeroSyncOperation.findMany({
    where: {
      entityType: "INVOICE", operationType: "UPDATE", localModel: "GroupBookingSettlement", status: "SUCCEEDED",
      localId: { in: [...new Set(invoices.map((invoice) => invoice.settlementId))] },
      correlationKey: { in: [...invoiceOfKey.keys()] },
    },
    orderBy: { createdAt: "asc" },
    select: { correlationKey: true, responsePayload: true },
  });
  for (const row of voids) {
    const invoice = row.correlationKey === null ? undefined : invoiceOfKey.get(row.correlationKey);
    const ended = groupSettlementInvoiceVoidEnded(row.responsePayload);
    if (invoice !== undefined && ended !== null && !reasons.has(invoice)) reasons.set(invoice, ended);
  }
  return reasons;
}

const invoicePairKey = (settlementId: string, invoiceId: string) => `${settlementId}\u0000${invoiceId}`;

/**
 * When the invoice's VOID operation has finished with it void or gone in Xero,
 * release every manifest of it for that reason. The VOID's row is the void's
 * own record, committed by its handler before the handler's last release
 * (`releaseCombinedGroupInvoiceManifest`, called again after the completion):
 * a manifest committed before this read is released by that last pass, and one
 * this read sees finished is released here, whichever commits second.
 */
async function releaseIfVoidFinished(settlementId: string, invoiceId: string): Promise<void> {
  const reason = (await finishedVoidReasons([{ settlementId, invoiceId }])).get(invoicePairKey(settlementId, invoiceId));
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
 * keeps its conflict. Never throws: true once the invoice's manifests are
 * released (the retry's own failure is logged by the recorder), false when
 * the release itself failed and was logged.
 */
export async function releaseCombinedGroupInvoiceManifest(input: {
  settlementId: string;
  invoiceId: string;
  reason: MemberMoneyExportCoverageReleaseReason;
}): Promise<boolean> {
  const { settlementId, invoiceId, reason } = input;
  let released = false;
  try {
    await releaseUnreleased(settlementId, invoiceId, reason);
    // Once more after that commit: a successor this invoice's own record wrote
    // beside the first pass is released here, or its writer sees this release
    // (`releaseLikeAnyReleased`), whichever commits second.
    await releaseUnreleased(settlementId, invoiceId, reason);
    released = true;
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
  return released;
}

/** One page of the cover-release sweep, and how many pages one run reads at most (5,000 VOIDs). */
export const COMBINED_COVER_SWEEP_PAGE_SIZE = 100;
export const COMBINED_COVER_SWEEP_MAX_PAGES = 50;

export interface CombinedCoverSweepResult {
  /** Voided combined invoices with an unreleased manifest the run read. */
  checked: number;
  /** Of those, the invoices whose finished VOID ended them, released now. */
  released: number;
  /** Of those, the invoices whose release failed (logged); the next run tries again. */
  releaseFailures: number;
  /** The run stopped at its cap: later VOIDs still owed a release were not read. */
  truncated: boolean;
  /** The sweep's own read failed; what it had not reached is left for the next run. */
  failed: boolean;
}

const VOIDED_UNRELEASED_ROW = z.object({ id: z.string(), createdAt: z.date(), settlementId: z.string(), invoiceId: z.string() });

/**
 * One page of the sweep's work: each SUCCEEDED group-settlement VOID whose
 * response carries an ended flag, joined to its invoice's unreleased combined
 * manifests, oldest VOID first after `cursor`. Only what still needs releasing:
 * a released invoice, a live one and one carrying money (no ended flag) are
 * never read. The join finds the invoice in the VOID's key
 * (`groupSettlementInvoiceVoidKey` holds the invoice id verbatim); every row is
 * checked again against the exact keys by `finishedVoidReasons`. Exported for
 * its real-PostgreSQL proof (`combined-group-cover-sweep-read.realdb.test.ts`).
 */
export async function readVoidedUnreleasedPage(cursor: { createdAt: Date; id: string } | null) {
  const ended = Prisma.join(GROUP_SETTLEMENT_INVOICE_VOID_ENDED_FLAGS.map((flag) => Prisma.sql`${JSON.stringify({ [flag]: true })}::jsonb`));
  const after = cursor ? Prisma.sql`AND (o."createdAt", o."id") > (${cursor.createdAt}, ${cursor.id})` : Prisma.empty;
  const rows = await prisma.$queryRaw`
    SELECT DISTINCT o."id", o."createdAt", o."localId" AS "settlementId", m."providerInvoiceId" AS "invoiceId"
    FROM "XeroSyncOperation" o
    JOIN "MemberMoneyExportManifest" m
      ON m."settlementId" = o."localId"
     AND m."documentRole" = ${ROLE}::"MemberMoneyExportDocumentRole"
     AND strpos(o."correlationKey", m."providerInvoiceId") > 0
    WHERE o."entityType" = 'INVOICE'
      AND o."operationType" = 'UPDATE'
      AND o."localModel" = 'GroupBookingSettlement'
      AND o."status" = 'SUCCEEDED'
      AND o."responsePayload" @> ANY (ARRAY[${ended}])
      AND NOT EXISTS (SELECT 1 FROM "MemberMoneyExportCoverageRelease" r WHERE r."manifestId" = m."id")
      ${after}
    ORDER BY o."createdAt" ASC, o."id" ASC
    LIMIT ${COMBINED_COVER_SWEEP_PAGE_SIZE}
  `;
  return decodeRawRows(rows, VOIDED_UNRELEASED_ROW, "voided combined group invoices with unreleased cover");
}

/**
 * THE COVER-RELEASE SWEEP (#4525 review; lane decision under the owner's
 * standing instruction of 25 Nov 2026). Every unreleased combined manifest
 * whose invoice has a SUCCEEDED VOID that ended it (`groupSettlementInvoiceVoidEnded`:
 * voided, already void, or not in Xero; never one carrying money) is released
 * for that reason through `releaseCombinedGroupInvoiceManifest`, the one
 * release writer, which then retries the bound invoice's record, so a
 * replacement's ALREADY_COVERED conflict becomes cover. It heals what no
 * handler or recorder pass reaches: an old-colour void handler that writes no
 * release while the old colour drains, and the two crash windows (ledger §7).
 * The payments cron cycle runs it every 15 minutes. It reads from the VOIDs
 * that still owe a release (`readVoidedUnreleasedPage`), so live and
 * money-carrying invoices never fill its pages; oldest VOID first, a page of
 * `COMBINED_COVER_SWEEP_PAGE_SIZE`, at most `COMBINED_COVER_SWEEP_MAX_PAGES`
 * pages a run; a run that stops at the cap, or whose release failed, says so.
 * Idempotent: a released manifest leaves the work set, and release rows are
 * keyed by manifest. Never throws. No advisory lock (`INV-LOCK-001`): it
 * changes no booking status or settlement money; the release's keys are the
 * exclusion.
 */
export async function sweepVoidedCombinedGroupInvoiceCover(): Promise<CombinedCoverSweepResult> {
  const result: CombinedCoverSweepResult = { checked: 0, released: 0, releaseFailures: 0, truncated: false, failed: false };
  try {
    const seen = new Set<string>();
    let cursor: { createdAt: Date; id: string } | null = null;
    for (let page = 0; page < COMBINED_COVER_SWEEP_MAX_PAGES; page += 1) {
      const rows = await readVoidedUnreleasedPage(cursor);
      const invoices: { settlementId: string; invoiceId: string }[] = [];
      for (const row of rows) {
        if (seen.has(invoicePairKey(row.settlementId, row.invoiceId))) continue;
        seen.add(invoicePairKey(row.settlementId, row.invoiceId));
        invoices.push({ settlementId: row.settlementId, invoiceId: row.invoiceId });
      }
      result.checked += invoices.length;
      const reasons = await finishedVoidReasons(invoices);
      for (const invoice of invoices) {
        const reason = reasons.get(invoicePairKey(invoice.settlementId, invoice.invoiceId));
        if (!reason) continue;
        if (await releaseCombinedGroupInvoiceManifest({ ...invoice, reason })) result.released += 1;
        else result.releaseFailures += 1;
      }
      if (rows.length < COMBINED_COVER_SWEEP_PAGE_SIZE) return result;
      const last = rows[rows.length - 1]!;
      cursor = { createdAt: last.createdAt, id: last.id };
    }
    result.truncated = true;
    return result;
  } catch (error) {
    logger.error({ err: error }, "Could not sweep the combined group invoices' cover on void invoices; the next run tries again");
    return { ...result, failed: true };
  }
}
