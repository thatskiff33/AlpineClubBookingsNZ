import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { exactPrefix } from "@/lib/prisma-exact-prefix";
import { isPrismaUniqueConstraintError } from "@/lib/prisma-errors";

/**
 * Cross-instance alert cooldown (#1211, extracted for reuse by #2262).
 *
 * One `AlertCooldown` row per alert key. A caller CLAIMS the window before
 * sending, so N app instances raise at most one alert per window instead of one
 * per instance: the conditional `updateMany` only matches when the last alert is
 * older than the window, so a single caller wins the write; on a miss the row is
 * either fresh-within-window (someone else already alerted) or does not exist
 * yet (first alert ever), and the unique-guarded create decides that race.
 *
 * ALWAYS claim first and send afterwards, with the provider call OUTSIDE any
 * database transaction. The tiny residual double-send window (two instances
 * reading between claim attempts) is bounded and acceptable for noise control;
 * it must never be relied on for money correctness.
 *
 * `awaitingSend` (#5255, once-ever claims only) also stamps the claim as
 * having no email behind it yet: the alert's own email row clears that
 * (`confirmAlertCooldownSend`), and the sweep gives back a claim still marked
 * after its grace (`releaseUnsentAlertCooldown`).
 *
 * @returns true when this caller holds the claim and should send.
 */
export async function claimAlertCooldown({
  key,
  windowMs,
  now = new Date(),
  awaitingSend = false,
  store = prisma,
}: {
  key: string;
  windowMs: number;
  now?: Date;
  awaitingSend?: boolean;
  store?: Pick<typeof prisma, "alertCooldown">;
}): Promise<boolean> {
  const windowStart = new Date(now.getTime() - windowMs);
  const stamp = { lastAlertedAt: now, ...(awaitingSend ? { awaitingSendSince: now } : {}) };

  const claimed = await store.alertCooldown.updateMany({
    where: { key, lastAlertedAt: { lt: windowStart } },
    data: stamp,
  });
  if (claimed.count > 0) return true;

  try {
    await store.alertCooldown.create({ data: { key, ...stamp } });
    return true;
  } catch (error) {
    if (isPrismaUniqueConstraintError(error)) return false;
    throw error;
  }
}

/**
 * A window no stay outlives: claiming with it means "alert once, ever" for its
 * key (#3672). One named constant so every once-only alert shares it.
 */
export const ALERT_ONCE_EVER_WINDOW_MS = 36_500 * 86_400_000;

/**
 * How long a claim whose alert nobody could receive (no admin opted in, the
 * template switched off, every recipient suppressed) is held before the next
 * run may try again (#3672): daily, not every run.
 */
export const ALERT_NOBODY_ELIGIBLE_RETRY_MS = 86_400_000;

/**
 * Give back a claim this caller took at `claimedAt` and could not use — the
 * send threw before reaching anyone, or the claim call threw after its write
 * may have committed (#4679, #4696) — so the next run can claim and send
 * again (#3672). A send that reached nobody is deferred instead
 * (`deferAlertCooldown`), never given back (#3635 F1).
 * Deletes only a row still stamped with this caller's own claim, so a newer
 * claim by another sender is never released.
 */
export async function releaseAlertCooldown({
  key,
  claimedAt,
  store = prisma,
}: {
  key: string;
  claimedAt: Date;
  store?: Pick<typeof prisma, "alertCooldown">;
}): Promise<void> {
  await store.alertCooldown.deleteMany({ where: { key, lastAlertedAt: claimedAt } });
}

/**
 * Hold a claim this caller took at `claimedAt` for `retryAfterMs` only, rather
 * than the whole `windowMs` (#3672): the stamp is moved back so the row falls
 * out of the window, and `claimAlertCooldown` with the same `windowMs` succeeds
 * again, exactly `retryAfterMs` after the claim. Same own-stamp guard as
 * `releaseAlertCooldown`, so a newer claim by another sender is never touched.
 * A deferred claim is settled for the day, so the sweep leaves it (#5255).
 */
export async function deferAlertCooldown({
  key,
  claimedAt,
  windowMs,
  retryAfterMs,
  store = prisma,
}: {
  key: string;
  claimedAt: Date;
  windowMs: number;
  retryAfterMs: number;
  store?: Pick<typeof prisma, "alertCooldown">;
}): Promise<void> {
  await store.alertCooldown.updateMany({
    where: { key, lastAlertedAt: claimedAt },
    data: { lastAlertedAt: new Date(claimedAt.getTime() - windowMs + retryAfterMs), awaitingSendSince: null },
  });
}

/**
 * #5255 (`INV-INT-042`): record that the once-ever claim taken at `claimedAt`
 * has an email behind it, so the sweep never gives it back. Guarded by the
 * claim's own stamp, not the mark: every recipient's row confirms, and only
 * the first finds the mark still set. Run in the email row's own transaction
 * (`recordEmailAttempt`), the row lock orders it against the sweep's release:
 * false means the claim is no longer this caller's (given back, or never
 * landed), and the email must not be written or sent.
 */
export async function confirmAlertCooldownSend({
  key,
  claimedAt,
  store = prisma,
}: {
  key: string;
  claimedAt: Date;
  store?: Pick<typeof prisma, "alertCooldown">;
}): Promise<boolean> {
  const confirmed = await store.alertCooldown.updateMany({
    where: { key, lastAlertedAt: claimedAt },
    data: { awaitingSendSince: null },
  });
  return confirmed.count > 0;
}

/**
 * #5255: the sweep's give-back of a once-ever claim still marked as having no
 * email behind it. Deletes only while both the stamp and the mark stand, so a
 * claim confirmed meanwhile (its email row committed first) is kept, and a
 * newer claim is never touched. Returns whether it gave the claim back.
 */
export async function releaseUnsentAlertCooldown({
  key,
  claimedAt,
  store = prisma,
}: {
  key: string;
  claimedAt: Date;
  store?: Pick<typeof prisma, "alertCooldown">;
}): Promise<boolean> {
  const released = await store.alertCooldown.deleteMany({
    where: { key, lastAlertedAt: claimedAt, awaitingSendSince: { not: null } },
  });
  return released.count > 0;
}

/** #5255: once-ever claims marked unsent since before `markedBefore`, oldest first, 50 a run. */
export async function listStaleUnsentAlertCooldowns({
  markedBefore,
  store = prisma,
}: {
  markedBefore: Date;
  store?: Pick<typeof prisma, "alertCooldown">;
}): Promise<{ key: string; lastAlertedAt: Date }[]> {
  return store.alertCooldown.findMany({
    where: { awaitingSendSince: { lt: markedBefore } },
    select: { key: true, lastAlertedAt: true },
    orderBy: { awaitingSendSince: "asc" },
    take: 50,
  });
}

/**
 * An alert that could not be delivered and whose subject no run will select
 * again (#3643: a hold already released). The marker is the durable "owed";
 * `listOwedAlertKeys` offers it once it is due and the drain settles it once
 * delivered. `due` says when (#3635 N1): a send that THREW is due on the very
 * next run (the stamp is back-dated by `retryAfterMs`), while one that ran and
 * reached nobody waits `retryAfterMs`. The key is its own namespace, beside
 * the window key the send claimed. `replayAlert` stores what to send again,
 * for a drain that has nothing else to rebuild it from (#5255).
 */
export async function markAlertOwed({
  key,
  due,
  retryAfterMs,
  replayAlert,
  now = new Date(),
  store = prisma,
}: {
  key: string;
  due: "next-run" | "after-retry";
  retryAfterMs: number;
  replayAlert?: Prisma.InputJsonValue;
  now?: Date;
  store?: Pick<typeof prisma, "alertCooldown">;
}): Promise<void> {
  const lastAlertedAt = due === "next-run" ? new Date(now.getTime() - retryAfterMs) : now;
  try {
    await store.alertCooldown.create({ data: { key, lastAlertedAt, ...(replayAlert === undefined ? {} : { replayAlert }) } });
  } catch (error) {
    if (!isPrismaUniqueConstraintError(error)) throw error;
  }
}

/**
 * The owed markers under `prefix` that are due: last marked or attempted at
 * least `retryAfterMs` before `now` (#3635 F1), so an alert nobody can
 * receive is tried at most once per `retryAfterMs`, never every run.
 */
export async function listOwedAlertKeys({
  prefix,
  now = new Date(),
  retryAfterMs,
  store = prisma,
}: {
  prefix: string;
  now?: Date;
  retryAfterMs: number;
  store?: Pick<typeof prisma, "alertCooldown">;
}): Promise<string[]> {
  const rows = await store.alertCooldown.findMany({
    where: {
      key: exactPrefix(prefix),
      lastAlertedAt: { lte: new Date(now.getTime() - retryAfterMs) },
    },
    select: { key: true },
    orderBy: { lastAlertedAt: "asc" },
    take: 50,
  });
  return rows.map((row) => row.key);
}

/**
 * Stamp an owed marker as attempted at `now` without settling it (#3635 F1):
 * the drain tried and nobody received it, so it waits `retryAfterMs` again.
 * A drain send that threw does not call this (#3635 N1), so it stays due.
 */
export async function noteOwedAlertAttempt({
  key,
  now = new Date(),
  store = prisma,
}: {
  key: string;
  now?: Date;
  store?: Pick<typeof prisma, "alertCooldown">;
}): Promise<void> {
  await store.alertCooldown.updateMany({ where: { key }, data: { lastAlertedAt: now } });
}

export async function settleOwedAlert({
  key,
  store = prisma,
}: {
  key: string;
  store?: Pick<typeof prisma, "alertCooldown">;
}): Promise<void> {
  await store.alertCooldown.deleteMany({ where: { key } });
}
