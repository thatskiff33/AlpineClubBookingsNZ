/**
 * #5433: DELIVERING AN OWED NOTICE, RIGHT AFTER THE COMMIT AND FROM THE SWEEP.
 *
 * A change records the notices it owes inside its own transaction
 * (`recordOwedNotices`, `./store.ts`). After the commit it hands each marker to
 * `deliverOwedNotice`, which claims it, sends, and clears it once the notice is
 * settled. A later run's sweep (`drainOwedNotices`, `./drain.ts`) sends what the
 * first attempt never sent: the job stopped between the commit and the send,
 * or the send threw before its `EmailLog` row existed. Each kind of notice
 * supplies one deliverer (`OwedNoticeDeliverer`), registered in `./registry.ts`.
 *
 * Every send is behind a claim: an update on the marker guarded by its stamp
 * (`claimByStamp`). Of the delivery right after the commit and the sweeps of
 * overlapping runs, exactly one caller holds a marker at a time, and a caller
 * that loses the claim sends nothing. The clear and the defer touch only a
 * marker still carrying the caller's own claim.
 *
 * What it guarantees:
 * - A member's notice: at most one `EmailLog` row per event. The deliverer
 *   sends with the kind's event key (`idempotencyKey`), which becomes the
 *   row's id, so a second send finds the row and sends nothing; a provider
 *   failure leaves that row `FAILED` for the email retry cron.
 * - An officers' alert: at least once. It is one row per officer with no
 *   event key, so a crash after the send and before the clear repeats it on a
 *   later run (the trade-off accepted for the bump alert in #5407).
 *
 * Stated limits:
 * - A crash during the provider call itself leaves the member's row `QUEUED`,
 *   which nothing replays (the window every inline send has).
 * - A claim is a stamp, not a lease: a send still running a kind's whole wait
 *   after its claim, or a large clock difference between two app instances,
 *   lets a sweep claim the marker again. The member is still sent one email
 *   (same event key); officers may get their alert twice.
 * - A recovered notice arrives on a later run, at least the kind's wait after
 *   the event or the interrupted attempt.
 *
 * Locks (`INV-LOCK-001`): nothing here runs inside a transaction or takes an
 * advisory key. The marker write joins the change's transaction under the
 * locks it already holds; everything in this file runs after the commit on the
 * base client.
 */
import logger from "@/lib/logger";
import {
  claimOwedNotice,
  deferOwedNotice,
  listDueOwedNotices,
  settleOwedNotice,
  type OwedNoticeMarker,
} from "@/lib/owed-notice/store";

/**
 * What a send did, and so what the marker does:
 * - `settled` clears it: the notice went, a failed copy's `FAILED` row is the
 *   email retry cron's to replay, or nobody is meant to get it;
 * - `unreached` holds it for `unreachedRetryAfterMs`: nobody got it and
 *   nothing will replay it (an officers' alert whose every copy failed before
 *   its row, `adminAlertNeedsResend`);
 * - `threw` keeps it for the kind's usual wait.
 */
export type OwedNoticeOutcome = "settled" | "unreached" | "threw";

interface OwedNoticeDelivererBase<S> {
  /** The marker's `kind`. A sweep reads only kinds it has a deliverer for. */
  kind: string;
  /** Logged with every line about this kind. */
  job: string;
  /** How long after its stamp (the event, or the last attempt) a sweep may claim a marker. */
  sweepAfterMs: number;
  /** How long a marker is held after an attempt that reached nobody (`unreached`). */
  unreachedRetryAfterMs: number;
  /** A marker older than this, or one that cannot be read, is cleared with an error log and nothing is sent. */
  maxAgeMs: number;
  /** The subject as it stands now, read outside any transaction; null when it is gone. */
  load(marker: OwedNoticeMarker): Promise<S | null>;
  /**
   * True to send; otherwise why the notice is no longer owed (the subject
   * moved on), and the marker is cleared without a send. Reads current state,
   * never narrative events alone.
   */
  stillOwed(subject: S, marker: OwedNoticeMarker): Promise<true | string>;
  /** The cut-off: a sweep past it sends nothing (`pastCutoff` decides what happens instead). */
  sendBy(subject: S, marker: OwedNoticeMarker): Date;
  /**
   * Past the cut-off, in place of the send: for a member's notice, alert the
   * officers once. Answered like `deliver`. Absent, the marker is cleared with
   * an error log.
   */
  pastCutoff?(subject: S, marker: OwedNoticeMarker): Promise<OwedNoticeOutcome>;
}

/** A member's notice carries an event key, so the member can never receive it twice. */
interface MemberAudience<S> {
  audience: "member";
  /** The event key the email core turns into the `EmailLog` row id. */
  idempotencyKey(marker: OwedNoticeMarker): string;
  /** Send the notice with that key. Never throws: a failure is logged and answered `threw`. */
  deliver(subject: S, marker: OwedNoticeMarker, context: { idempotencyKey: string }): Promise<OwedNoticeOutcome>;
}

interface OfficersAudience<S> {
  audience: "officers";
  /** Send the alert. Never throws: a failure is logged and answered `threw`. */
  deliver(subject: S, marker: OwedNoticeMarker): Promise<OwedNoticeOutcome>;
}

export type OwedNoticeDeliverer<S = unknown> = OwedNoticeDelivererBase<S> & (MemberAudience<S> | OfficersAudience<S>);

/**
 * One owed marker as a sweep or a delivery handles it, whichever table holds
 * it. `marker` is null when the stored row cannot be read.
 */
export interface OwedNoticeRef {
  /** The row's own key, for logs. */
  key: string;
  marker: OwedNoticeMarker | null;
  claim(stampedNoLaterThan: Date, now: Date): Promise<Date | null>;
  settle(claimedAt: Date): Promise<void>;
  defer(claimedAt: Date, waitMs: number, retryAfterMs: number): Promise<void>;
}

/** Where a sweep finds the due markers of one kind. */
export interface OwedNoticeSource {
  name: string;
  listDue(deliverer: OwedNoticeDeliverer, at: { dueBefore: Date; now: Date }): Promise<OwedNoticeRef[]>;
}

/** A marker in the `OwedNotice` table. */
function tableRef(marker: OwedNoticeMarker): OwedNoticeRef {
  return {
    key: marker.id,
    marker,
    claim: (stampedNoLaterThan, now) => claimOwedNotice({ id: marker.id, stampedNoLaterThan, now }),
    settle: (claimedAt) => settleOwedNotice({ id: marker.id, claimedAt }),
    defer: (claimedAt, waitMs, retryAfterMs) => deferOwedNotice({ id: marker.id, claimedAt, waitMs, retryAfterMs }),
  };
}

/** The `OwedNotice` table, read by kind on its `(kind, stampedAt)` index. */
export const owedNoticeTableSource: OwedNoticeSource = {
  name: "OwedNotice",
  async listDue(deliverer, { dueBefore }) {
    const markers = await listDueOwedNotices({ kind: deliverer.kind, dueBefore });
    return markers.map(tableRef);
  },
};

/** Send through the deliverer; a member's notice always with its event key. */
function send<S>(deliverer: OwedNoticeDeliverer<S>, subject: S, marker: OwedNoticeMarker): Promise<OwedNoticeOutcome> {
  return deliverer.audience === "member"
    ? deliverer.deliver(subject, marker, { idempotencyKey: deliverer.idempotencyKey(marker) })
    : deliverer.deliver(subject, marker);
}

/**
 * Under a won claim: answer one outcome. `settled` clears the marker;
 * `unreached` holds it for the kind's longer retry; `threw` leaves it under
 * this claim's stamp, so the sweep offers it again a full wait later.
 */
async function settleByOutcome(
  deliverer: OwedNoticeDeliverer,
  ref: OwedNoticeRef,
  claimedAt: Date,
  outcome: OwedNoticeOutcome,
): Promise<"delivered" | "kept"> {
  if (outcome === "settled") {
    await ref.settle(claimedAt);
    return "delivered";
  }
  if (outcome === "unreached") await ref.defer(claimedAt, deliverer.sweepAfterMs, deliverer.unreachedRetryAfterMs);
  return "kept";
}

/**
 * After the change commits: deliver one of its notices, from the marker
 * `recordOwedNotices` returned inside the transaction. The claim is taken on
 * the stamp the transaction wrote (`marker.eventAt`), never the clock, so a
 * sweep that already claimed it wins and this sends nothing. Never throws: a
 * failure is logged and the marker, if it still stands, is the sweep's.
 */
export async function deliverOwedNotice<S>(
  deliverer: OwedNoticeDeliverer<S>,
  marker: OwedNoticeMarker,
  subject: S,
): Promise<void> {
  const ref = tableRef(marker);
  try {
    const claimedAt = await ref.claim(marker.eventAt, new Date());
    if (!claimedAt) {
      logger.info({ key: ref.key, job: deliverer.job }, "Another run holds this owed notice; not sending it here");
      return;
    }
    await settleByOutcome(deliverer, ref, claimedAt, await send(deliverer, subject, marker));
  } catch (err) {
    logger.error(
      { err, key: ref.key, job: deliverer.job },
      "Failed to claim or clear an owed notice's marker; a later run sends what is still owed",
    );
  }
}

export type OwedNoticeSweepOutcome = "delivered" | "kept" | "cleared" | "expired" | "claim-lost";

/**
 * One due marker, for the sweep: claim it on the sweep's bound before
 * anything else, then apply the maximum age, the subject's current state and
 * the cut-off, and send what is still owed. Throws only when a database read
 * or write fails, which the drain logs; the marker then stays owed.
 */
export async function sweepOwedNotice(
  deliverer: OwedNoticeDeliverer,
  ref: OwedNoticeRef,
  dueBefore: Date,
  now: Date,
): Promise<OwedNoticeSweepOutcome> {
  const claimedAt = await ref.claim(dueBefore, now);
  if (!claimedAt) return "claim-lost";
  const { marker } = ref;
  if (!marker || now.getTime() - marker.eventAt.getTime() > deliverer.maxAgeMs) {
    logger.error(
      { key: ref.key, kind: deliverer.kind, job: deliverer.job },
      "An owed notice was still owed past its maximum age, or its marker could not be read; cleared without sending it",
    );
    await ref.settle(claimedAt);
    return "expired";
  }
  const subject = await deliverer.load(marker);
  const owed = subject === null ? "gone" : await deliverer.stillOwed(subject, marker);
  if (owed !== true || subject === null) {
    logger.warn(
      { key: ref.key, kind: deliverer.kind, subjectId: marker.subjectId, why: owed, job: deliverer.job },
      "An owed notice's subject is gone or has moved on; cleared without sending it",
    );
    await ref.settle(claimedAt);
    return "cleared";
  }
  if (now > deliverer.sendBy(subject, marker)) {
    if (!deliverer.pastCutoff) {
      logger.error(
        { key: ref.key, kind: deliverer.kind, subjectId: marker.subjectId, job: deliverer.job },
        "An owed notice passed its cut-off unsent; cleared without sending it",
      );
      await ref.settle(claimedAt);
      return "expired";
    }
    const outcome = await deliverer.pastCutoff(subject, marker);
    return (await settleByOutcome(deliverer, ref, claimedAt, outcome)) === "delivered" ? "expired" : "kept";
  }
  return settleByOutcome(deliverer, ref, claimedAt, await send(deliverer, subject, marker));
}
