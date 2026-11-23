/**
 * The `OwedNotice` table (#5433): the record that a committed change owes a
 * notice, written in the change's own transaction and read, claimed and
 * cleared after it. Every statement here is one guarded write or one read by
 * primary key or by the `(kind, stampedAt)` index; none opens a transaction or
 * takes an advisory key.
 */
import type { Prisma } from "@prisma/client";

import { claimByStamp, deferredStamp } from "@/lib/owed-notice/stamp";
import { prisma } from "@/lib/prisma";

/**
 * Facts the change worked out in its transaction that cannot be rebuilt
 * reliably later. Ids and whole numbers only, never personal data: the row is
 * operational and sits outside the subject-access export.
 */
export type OwedNoticePayload = Readonly<Record<string, string | number>>;

/** One owed notice, as the change describes it. */
export interface OwedNoticeInput {
  kind: string;
  subjectId: string;
  /** Taken once inside the transaction: part of the identity, and the first stamp. */
  eventAt: Date;
  /** Tells apart two notices of one kind for one event; part of the identity. */
  variant?: string | null;
  payload?: OwedNoticePayload | null;
}

/** One owed notice, as stored. */
export interface OwedNoticeMarker {
  id: string;
  kind: string;
  subjectId: string;
  eventAt: Date;
  variant: string | null;
  payload: Prisma.JsonValue | null;
}

type OwedNoticeStore = Pick<typeof prisma, "owedNotice">;

/** The deterministic id: `<kind>:<subjectId>:<eventAtMs>[:variant]`. */
export function owedNoticeId(kind: string, subjectId: string, eventAt: Date, variant?: string | null): string {
  const base = `${kind}:${subjectId}:${eventAt.getTime()}`;
  return variant ? `${base}:${variant}` : base;
}

function assertPayload(kind: string, payload: OwedNoticePayload): void {
  for (const [field, value] of Object.entries(payload)) {
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      throw new Error(`Owed notice ${kind}: payload field ${field} must be a whole number`);
    }
  }
}

/** The stored marker for an input, as `recordOwedNotices` writes it. */
export function owedNoticeMarker(input: OwedNoticeInput): OwedNoticeMarker {
  return {
    id: owedNoticeId(input.kind, input.subjectId, input.eventAt, input.variant),
    kind: input.kind,
    subjectId: input.subjectId,
    eventAt: input.eventAt,
    variant: input.variant ?? null,
    payload: input.payload ?? null,
  };
}

/**
 * Inside the change's transaction, under whatever locks it already holds:
 * record each notice as owed, stamped with its event time. One
 * `createMany({ skipDuplicates: true })`, which PostgreSQL runs as
 * `INSERT ... ON CONFLICT DO NOTHING`: a marker already there is left as it
 * is and no unique-key error is raised. A caught unique-key error would still
 * abort the transaction, so nothing here catches one. No read, no provider
 * call, no settings query (`INV-INT-003`). Returns the markers, so the
 * delivery after the commit claims with the stamp written here (`INV-SSOT-002`).
 */
export async function recordOwedNotices(
  tx: Pick<Prisma.TransactionClient, "owedNotice">,
  notices: readonly OwedNoticeInput[],
): Promise<OwedNoticeMarker[]> {
  const markers = notices.map((notice) => {
    if (notice.payload) assertPayload(notice.kind, notice.payload);
    return owedNoticeMarker(notice);
  });
  if (markers.length === 0) return markers;
  await tx.owedNotice.createMany({
    data: markers.map((marker) => ({
      id: marker.id,
      kind: marker.kind,
      subjectId: marker.subjectId,
      eventAt: marker.eventAt,
      variant: marker.variant,
      payload: (marker.payload ?? undefined) as Prisma.InputJsonValue | undefined,
      stampedAt: marker.eventAt,
    })),
    skipDuplicates: true,
  });
  return markers;
}

/**
 * Claim a marker for one delivery attempt: its stamp moves on only while it
 * is no later than `stampedNoLaterThan`, so of two callers racing one marker
 * exactly one wins, and the loser must send nothing. Returns the claim's
 * stamp, for the settle's own-claim guard, or null when the claim was lost.
 */
export async function claimOwedNotice({
  id,
  stampedNoLaterThan,
  now = new Date(),
  store = prisma,
}: {
  id: string;
  stampedNoLaterThan: Date;
  now?: Date;
  store?: OwedNoticeStore;
}): Promise<Date | null> {
  return claimByStamp(stampedNoLaterThan, now, (claimedAt) =>
    store.owedNotice.updateMany({
      where: { id, stampedAt: { lte: stampedNoLaterThan } },
      data: { stampedAt: claimedAt, attempts: { increment: 1 } },
    }),
  );
}

/** Delete a marker, but only while it still carries this caller's own claim. */
export async function settleOwedNotice({
  id,
  claimedAt,
  store = prisma,
}: {
  id: string;
  claimedAt: Date;
  store?: OwedNoticeStore;
}): Promise<void> {
  await store.owedNotice.deleteMany({ where: { id, stampedAt: claimedAt } });
}

/**
 * Hold a claimed marker for `retryAfterMs` instead of the kind's usual wait
 * (an officers' alert that reached nobody). Same own-claim guard as the settle.
 */
export async function deferOwedNotice({
  id,
  claimedAt,
  waitMs,
  retryAfterMs,
  store = prisma,
}: {
  id: string;
  claimedAt: Date;
  waitMs: number;
  retryAfterMs: number;
  store?: OwedNoticeStore;
}): Promise<void> {
  await store.owedNotice.updateMany({
    where: { id, stampedAt: claimedAt },
    data: { stampedAt: deferredStamp(claimedAt, waitMs, retryAfterMs) },
  });
}

/** How many markers of one kind one sweep offers, oldest stamp first. */
export const OWED_NOTICE_SWEEP_BATCH = 50;

/** The markers of one kind whose stamp is no later than `dueBefore`, oldest first. */
export async function listDueOwedNotices({
  kind,
  dueBefore,
  store = prisma,
}: {
  kind: string;
  dueBefore: Date;
  store?: OwedNoticeStore;
}): Promise<OwedNoticeMarker[]> {
  return store.owedNotice.findMany({
    where: { kind, stampedAt: { lte: dueBefore } },
    select: { id: true, kind: true, subjectId: true, eventAt: true, variant: true, payload: true },
    orderBy: { stampedAt: "asc" },
    take: OWED_NOTICE_SWEEP_BATCH,
  });
}
