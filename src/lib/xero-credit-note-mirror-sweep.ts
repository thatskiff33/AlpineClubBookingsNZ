/**
 * #4270 — the backstop for the inbound credit-note mirror.
 *
 * A webhook is the fast path, but it is not the only one the mirror needs. Xero
 * sends an event the moment a note changes, when the two-minute settle gate has
 * not passed (`xero-credit-note-mirror.ts` defers it and leaves a recheck row);
 * an event can be lost; and a note that was never the subject of an event since
 * the app started mirroring would never be looked at. This sweep looks again:
 * first the deferred rechecks that are due, then, at most every few hours, every
 * note the ledger still treats as credit that can be spent or restored.
 *
 * THE POPULATION is read from the local ledger, never from a Xero "modified since"
 * cursor, which could skip past a note that was deferred: a note funding a lot
 * with credit not yet drawn by a booking or not yet written down (the exposure), or
 * with a net write-down (a spend that could be reversed). Reads are capped per run
 * and walk the notes in id order from a stored cursor, so a large ledger is covered
 * across runs rather than in one burst of Xero calls.
 *
 * READ-ONLY toward Xero. Each note is read outside any transaction with
 * `armTransientBreaker: false` (a decorative read must not take invoicing down) and
 * still respects a breaker armed elsewhere. Three failed reads in a row end the
 * run; the next one starts again where this one stopped.
 */
import { prisma } from "./prisma";
import logger from "@/lib/logger";
import { callXeroApi, getAuthenticatedXeroClient } from "./xero-api-client";
import {
  clearCreditNoteMirrorRecheck,
  CREDIT_NOTE_MIRROR_CURSOR_RESOURCE,
  CREDIT_NOTE_MIRROR_JOB_NAME,
  creditNoteMirrorEvidenceFrom,
  dueCreditNoteMirrorRechecks,
  mirrorCreditNoteOutsideSpend,
  type CreditNoteMirrorEvidence,
  type CreditNoteMirrorResult,
} from "./xero-credit-note-mirror";
import { NOT_A_CONVERGENCE_ROW, writtenDownCentsByCreditNote } from "./xero-credit-note-write-down";

/**
 * A complete pass throttles the next full one; deferred rechecks are not throttled. The
 * webhook is the fast path, so this backstop reads each note at most twice a day.
 */
const DEFAULT_MIN_PASS_INTERVAL_MS = 12 * 60 * 60 * 1000;
/** Notes read per run, rechecks included. */
const DEFAULT_NOTE_LIMIT = 100;
const MAX_CONSECUTIVE_READ_FAILURES = 3;
const PASS_CURSOR_SCOPE = "SWEEP";

export interface CreditNoteMirrorSweepResult {
  skipped: boolean;
  reason?: string;
  /** Notes read from Xero this run. */
  read: number;
  writtenDown: number;
  restored: number;
  /** Notes left alone, by the mirror's reason. */
  refused: Record<string, number>;
  readFailures: number;
  /** Notes whose mirror transaction failed (logged); they keep their place for the next run. */
  mirrorFailures: number;
  /** The full pass reached the end of the population with no failed read. */
  completePass: boolean;
}

export interface CreditNoteMirrorSweepDeps {
  now?: Date;
  db?: typeof prisma;
  minPassIntervalMs?: number;
  noteLimit?: number;
  /** Read one note from Xero; throws on an outage or rate limit. Injected in tests. */
  readCreditNote?: (creditNoteId: string) => Promise<CreditNoteMirrorEvidence | null>;
  mirror?: (evidence: CreditNoteMirrorEvidence) => Promise<CreditNoteMirrorResult>;
}

async function readCreditNoteLive(creditNoteId: string): Promise<CreditNoteMirrorEvidence | null> {
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const response = await callXeroApi(() => xero.accountingApi.getCreditNote(tenantId, creditNoteId), {
    operation: "getCreditNote",
    resourceType: "CREDIT_NOTE",
    workflow: "creditNoteOutsideSpendMirrorSweep",
    context: `creditNoteOutsideSpendMirrorSweep(${creditNoteId})`,
    // A backstop read: it must never arm the breaker that takes invoicing, sync and webhooks down.
    armTransientBreaker: false,
  });
  const note = response.body.creditNotes?.[0];
  return note ? creditNoteMirrorEvidenceFrom(note) : null;
}

/**
 * The notes whose lot the ledger still treats as credit that can change: some of
 * it not drawn by a booking and not written down, or something written down to
 * give back. Sorted by id so a cursor can walk them.
 */
async function candidateCreditNoteIds(db: typeof prisma): Promise<string[]> {
  const lots = await db.memberCredit.findMany({
    where: { xeroCreditNoteId: { not: null }, amountCents: { gt: 0 }, ...NOT_A_CONVERGENCE_ROW },
    select: { id: true, memberId: true, amountCents: true, xeroCreditNoteId: true },
  });
  if (lots.length === 0) return [];
  const sliced = await db.memberCreditNoteAllocation.groupBy({
    by: ["memberCreditId"],
    where: { memberCreditId: { in: lots.map((lot) => lot.id) } },
    _sum: { amountCents: true },
  });
  const slicedByLot = new Map(sliced.map((row) => [row.memberCreditId, row._sum.amountCents ?? 0]));
  const lotsByMember = new Map<string, typeof lots>();
  for (const lot of lots) lotsByMember.set(lot.memberId, [...(lotsByMember.get(lot.memberId) ?? []), lot]);
  const noteIds = new Set<string>();
  for (const [memberId, memberLots] of lotsByMember) {
    const writtenDown = await writtenDownCentsByCreditNote(
      db,
      memberId,
      memberLots.flatMap((lot) => (lot.xeroCreditNoteId ? [lot.xeroCreditNoteId] : [])),
    );
    for (const lot of memberLots) {
      const noteId = lot.xeroCreditNoteId;
      if (!noteId) continue;
      const down = writtenDown.get(noteId) ?? 0;
      if (down > 0 || lot.amountCents - (slicedByLot.get(lot.id) ?? 0) > 0) noteIds.add(noteId);
    }
  }
  return [...noteIds].sort();
}

export async function runCreditNoteMirrorSweep(deps: CreditNoteMirrorSweepDeps = {}): Promise<CreditNoteMirrorSweepResult> {
  const db = deps.db ?? prisma;
  const now = deps.now ?? new Date();
  const minPassIntervalMs = deps.minPassIntervalMs ?? DEFAULT_MIN_PASS_INTERVAL_MS;
  const noteLimit = deps.noteLimit ?? DEFAULT_NOTE_LIMIT;
  const read = deps.readCreditNote ?? readCreditNoteLive;
  const mirror = deps.mirror ?? ((evidence) => mirrorCreditNoteOutsideSpend(evidence, { db, now }));

  const result: CreditNoteMirrorSweepResult = {
    skipped: false,
    read: 0,
    writtenDown: 0,
    restored: 0,
    refused: {},
    readFailures: 0,
    mirrorFailures: 0,
    completePass: false,
  };
  let consecutiveFailures = 0;
  let stopped = false;

  /** "failed" when the note could not be read or mirrored, "retry" when it is still too fresh, "done" otherwise. */
  const visit = async (creditNoteId: string): Promise<"failed" | "retry" | "done"> => {
    let evidence: CreditNoteMirrorEvidence | null;
    try {
      evidence = await read(creditNoteId);
    } catch (err) {
      result.readFailures += 1;
      consecutiveFailures += 1;
      logger.warn({ err, creditNoteId }, "Credit-note mirror sweep could not read a credit note from Xero");
      if (consecutiveFailures >= MAX_CONSECUTIVE_READ_FAILURES) stopped = true;
      return "failed";
    }
    consecutiveFailures = 0;
    result.read += 1;
    if (!evidence) {
      result.refused["not-found"] = (result.refused["not-found"] ?? 0) + 1;
      return "done";
    }
    let outcome: CreditNoteMirrorResult;
    try {
      outcome = await mirror(evidence);
    } catch (err) {
      // One note's failed transaction (a lock wait that timed out, say) must not end the run
      // for the rest; it keeps its place for the next one.
      result.mirrorFailures += 1;
      logger.error({ err, creditNoteId }, "Credit-note mirror sweep could not mirror a credit note");
      return "failed";
    }
    if (outcome.acted) {
      if (outcome.action === "written-down") result.writtenDown += 1;
      else result.restored += 1;
      return "done";
    }
    result.refused[outcome.reason] = (result.refused[outcome.reason] ?? 0) + 1;
    return outcome.reason === "unsettled" ? "retry" : "done";
  };

  // 1) Deferred rechecks that have come due: a few rows at most, never throttled.
  for (const creditNoteId of await dueCreditNoteMirrorRechecks(db, now, noteLimit)) {
    if (stopped || result.read + result.readFailures >= noteLimit) break;
    // A note still too fresh was re-scheduled by the mirror and one that could not be read
    // keeps its row for the next run; any other outcome ends the recheck.
    if ((await visit(creditNoteId)) === "done") await clearCreditNoteMirrorRecheck(db, creditNoteId);
  }

  // 2) The full pass, throttled once a complete one has run.
  if (!stopped && result.read + result.readFailures < noteLimit) {
    const recent =
      minPassIntervalMs > 0
        ? await db.cronJobRun.findFirst({
            where: {
              jobName: CREDIT_NOTE_MIRROR_JOB_NAME,
              status: "SUCCESS",
              startedAt: { gte: new Date(now.getTime() - minPassIntervalMs) },
            },
            orderBy: { startedAt: "desc" },
            select: { resultSummary: true },
          })
        : null;
    const throttled =
      recent !== null &&
      typeof recent.resultSummary === "object" &&
      recent.resultSummary !== null &&
      (recent.resultSummary as { completePass?: unknown }).completePass === true;
    if (throttled) {
      // Not a complete pass of its own: only the pass that finished may throttle the next.
      result.skipped = result.read === 0 && result.readFailures === 0;
      result.reason = "Throttled: a complete pass ran within the interval.";
      return result;
    }

    const cursorRow = await db.xeroSyncCursor.findUnique({
      where: { resourceType_scope: { resourceType: CREDIT_NOTE_MIRROR_CURSOR_RESOURCE, scope: PASS_CURSOR_SCOPE } },
      select: { metadata: true },
    });
    const after =
      cursorRow?.metadata && typeof cursorRow.metadata === "object" && !Array.isArray(cursorRow.metadata)
        ? (cursorRow.metadata as { afterCreditNoteId?: unknown }).afterCreditNoteId
        : undefined;
    const population = await candidateCreditNoteIds(db);
    const remaining = typeof after === "string" ? population.filter((id) => id > after) : population;
    const room = Math.max(0, noteLimit - result.read - result.readFailures);
    const batch = remaining.slice(0, room);
    let lastVisited: string | null = null;
    for (const creditNoteId of batch) {
      if (stopped) break;
      // A note that could not be read or mirrored does not move the cursor past itself.
      if ((await visit(creditNoteId)) !== "failed") lastVisited = creditNoteId;
    }
    const reachedEnd = !stopped && batch.length === remaining.length;
    result.completePass = reachedEnd && result.readFailures === 0 && result.mirrorFailures === 0;
    // Failed reads leave the cursor where it was for the next run to start from; a finished
    // walk clears it so the next full pass starts at the beginning.
    const nextCursor = reachedEnd ? null : lastVisited;
    if (nextCursor !== null || cursorRow) {
      await db.xeroSyncCursor.upsert({
        where: { resourceType_scope: { resourceType: CREDIT_NOTE_MIRROR_CURSOR_RESOURCE, scope: PASS_CURSOR_SCOPE } },
        create: { resourceType: CREDIT_NOTE_MIRROR_CURSOR_RESOURCE, scope: PASS_CURSOR_SCOPE, metadata: { afterCreditNoteId: nextCursor } },
        update: { metadata: { afterCreditNoteId: nextCursor } },
      });
    }
  }

  if (result.read + result.readFailures > 0) {
    logger.info({ ...result }, "Credit-note mirror sweep finished");
  }
  return result;
}
