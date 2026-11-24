/**
 * The `OwedNotice` table (#5433): the record that a committed change owes a
 * notice, written in the change's own transaction and read, claimed and
 * cleared after it. Every statement here is one guarded write or one read by
 * primary key or by the `(kind, stampedAt)` index; none opens a transaction or
 * takes an advisory key.
 */
import type { Prisma } from "@prisma/client";

import type { OwedNoticeKind } from "@/lib/owed-notice/kinds";
import { claimByStamp, deferredStamp } from "@/lib/owed-notice/stamp";
import { prisma } from "@/lib/prisma";

/**
 * Facts the change worked out in its transaction that cannot be rebuilt
 * reliably later. Ids and whole numbers only, never personal data: the row is
 * operational and sits outside the subject-access export. Enforced on write
 * (`assertPayload`): at most `OWED_NOTICE_PAYLOAD_MAX_KEYS` keys, each a short
 * identifier, each value a safe whole number or an id (`OWED_NOTICE_PAYLOAD_ID`).
 */
export type OwedNoticePayload = Readonly<Record<string, string | number>>;

export const OWED_NOTICE_PAYLOAD_MAX_KEYS = 8;
const PAYLOAD_KEY = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
/** The shape a payload string must have: an id, never free text. */
export const OWED_NOTICE_PAYLOAD_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** One owed notice, as the change describes it. Only a kind this release delivers can be written. */
export interface OwedNoticeInput {
  kind: OwedNoticeKind;
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

/**
 * A member notice's event key, `<subjectId>:<eventAtMs>`: the email core turns
 * it into the notice's `EmailLog` id, so one event has one row (#5433). The
 * bump notice keeps the identical format #5407 shipped in its own function
 * (`bumpNoticeIdempotencyKey`), fixed so a legacy marker and a new one for one
 * bump still share a row.
 */
export function owedNoticeEventKey(subjectId: string, eventAt: Date): string {
  return `${subjectId}:${eventAt.getTime()}`;
}

/** The deterministic id: `<kind>:<subjectId>:<eventAtMs>[:variant]`. */
export function owedNoticeId(kind: string, subjectId: string, eventAt: Date, variant?: string | null): string {
  const base = `${kind}:${subjectId}:${eventAt.getTime()}`;
  return variant ? `${base}:${variant}` : base;
}

/**
 * Refuse a payload that is not ids and whole numbers. It throws before any
 * write, so inside the change's transaction it rolls the change back: a
 * programming error a test catches, never a runtime state.
 */
function assertPayload(kind: string, payload: OwedNoticePayload): void {
  const entries = Object.entries(payload);
  if (entries.length > OWED_NOTICE_PAYLOAD_MAX_KEYS) {
    throw new Error(`Owed notice ${kind}: a payload holds at most ${OWED_NOTICE_PAYLOAD_MAX_KEYS} fields`);
  }
  for (const [field, value] of entries) {
    if (!PAYLOAD_KEY.test(field)) throw new Error(`Owed notice ${kind}: payload field name ${JSON.stringify(field)} is not an identifier`);
    if (typeof value === "number" ? !Number.isSafeInteger(value) : typeof value !== "string" || !OWED_NOTICE_PAYLOAD_ID.test(value)) {
      throw new Error(`Owed notice ${kind}: payload field ${field} must be a whole number or an id`);
    }
  }
}

/**
 * Refuse identity parts the id cannot keep apart: each of the kind, the
 * subject and the variant must be an id (`OWED_NOTICE_PAYLOAD_ID`, so no
 * colon). Otherwise subject `s:123` at 456 ms and subject `s` at 123 ms with
 * variant `456` would share an id, and the second marker would be silently
 * skipped as a duplicate. Throws before any write, like `assertPayload`.
 */
function assertIdentity({ kind, subjectId, variant }: OwedNoticeInput): void {
  for (const [part, value] of [["kind", kind], ["subjectId", subjectId], ["variant", variant]] as const) {
    if (value === undefined || value === null) continue;
    if (!OWED_NOTICE_PAYLOAD_ID.test(value)) throw new Error(`Owed notice ${kind}: ${part} ${JSON.stringify(value)} is not an id`);
  }
}

/** The stored marker for an input, as `recordOwedNotices` writes it (`kind` is the stored text, which may be one this release does not know). */
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
    assertIdentity(notice);
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

/** The most unknown-kind markers one report counts; past it the report says "at least". */
export const UNKNOWN_KIND_REPORT_LIMIT = 100;

/**
 * Markers of kinds none of `knownKinds` names, created before
 * `createdBefore`: how many (at most `UNKNOWN_KIND_REPORT_LIMIT`, so the read
 * is bounded however large the table grows) and which kinds. They are never
 * deleted here: a newer release running beside this one may own them. The
 * drain only reports them.
 */
export async function findStaleUnknownOwedNotices({
  knownKinds,
  createdBefore,
  store = prisma,
}: {
  knownKinds: readonly string[];
  createdBefore: Date;
  store?: OwedNoticeStore;
}): Promise<{ count: number; kinds: string[] }> {
  const rows = await store.owedNotice.findMany({
    where: { kind: { notIn: [...knownKinds] }, createdAt: { lt: createdBefore } },
    select: { kind: true },
    take: UNKNOWN_KIND_REPORT_LIMIT,
  });
  return { count: rows.length, kinds: [...new Set(rows.map((row) => row.kind))].sort() };
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
