import { describe, expect, it, vi } from "vitest";

/*
 * #3672: the cross-instance alert claim, its give-back and its one-day hold.
 * The store is an in-memory `alertCooldown` table implementing exactly the
 * where shapes these helpers use, and every write is also pinned by its call,
 * so dropping the own-stamp guard from a release or a hold fails here.
 */

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  ALERT_NOBODY_ELIGIBLE_RETRY_MS,
  ALERT_ONCE_EVER_WINDOW_MS,
  claimAlertCooldown,
  confirmAlertCooldownSend,
  deferAlertCooldown,
  listOwedAlertKeys,
  listStaleUnsentAlertCooldowns,
  markAlertOwed,
  noteOwedAlertAttempt,
  releaseAlertCooldown,
  releaseUnsentAlertCooldown,
} from "@/lib/alert-cooldown";
import { createAlertCooldownFake } from "./helpers/alert-cooldown-fake";

type Where = { key: string; lastAlertedAt?: Date | { lt: Date } };

function stampMatches(stored: Date, filter: Where["lastAlertedAt"]): boolean {
  if (filter === undefined) return true;
  if (filter instanceof Date) return stored.getTime() === filter.getTime();
  return stored.getTime() < filter.lt.getTime();
}

function memoryStore() {
  const rows = new Map<string, Date>();
  const matching = (where: Where) =>
    [...rows.entries()].filter(
      ([key, at]) => key === where.key && stampMatches(at, where.lastAlertedAt)
    );
  const alertCooldown = {
    updateMany: vi.fn(async ({ where, data }: { where: Where; data: { lastAlertedAt: Date } }) => {
      const hits = matching(where);
      for (const [key] of hits) rows.set(key, data.lastAlertedAt);
      return { count: hits.length };
    }),
    create: vi.fn(async ({ data }: { data: { key: string; lastAlertedAt: Date } }) => {
      if (rows.has(data.key)) {
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      }
      rows.set(data.key, data.lastAlertedAt);
      return data;
    }),
    // Only the owed-marker listing's shape: a prefix and a "due by" stamp.
    findMany: vi.fn(
      async ({
        where,
      }: {
        where: { key: { startsWith: string }; lastAlertedAt: { lte: Date } };
      }) =>
        [...rows.entries()]
          .filter(
            ([key, at]) =>
              key.startsWith(where.key.startsWith) &&
              at.getTime() <= where.lastAlertedAt.lte.getTime()
          )
          .sort((a, b) => a[1].getTime() - b[1].getTime())
          .map(([key]) => ({ key }))
    ),
    deleteMany: vi.fn(async ({ where }: { where: Where }) => {
      const hits = matching(where);
      for (const [key] of hits) rows.delete(key);
      return { count: hits.length };
    }),
  };
  return { rows, store: { alertCooldown } as never, alertCooldown };
}

const KEY = "group-joiner-started-stay:g1";
const T0 = new Date("2026-07-01T00:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

function claim(store: never, now: Date) {
  return claimAlertCooldown({ key: KEY, windowMs: ALERT_ONCE_EVER_WINDOW_MS, now, store });
}

describe("alert-cooldown (#3672)", () => {
  it("claims once, ever, for the once-ever window", async () => {
    const { store } = memoryStore();
    await expect(claim(store, T0)).resolves.toBe(true);
    await expect(claim(store, at(1))).resolves.toBe(false);
    await expect(claim(store, at(365 * 86_400_000))).resolves.toBe(false);
  });

  it("gives back only its own claim, never a newer one", async () => {
    const { store, rows, alertCooldown } = memoryStore();
    await claim(store, T0);

    // A stale caller holding an older stamp cannot release the live claim.
    await releaseAlertCooldown({ key: KEY, claimedAt: at(-1), store });
    expect(alertCooldown.deleteMany).toHaveBeenLastCalledWith({
      where: { key: KEY, lastAlertedAt: at(-1) },
    });
    expect(rows.get(KEY)).toEqual(T0);
    await expect(claim(store, at(2))).resolves.toBe(false);

    // Its owner can, and the next run claims again.
    await releaseAlertCooldown({ key: KEY, claimedAt: T0, store });
    expect(rows.has(KEY)).toBe(false);
    await expect(claim(store, at(3))).resolves.toBe(true);
  });

  it("holds a claim for the retry delay only, then lets the next run claim", async () => {
    const { store, rows, alertCooldown } = memoryStore();
    await claim(store, T0);

    await deferAlertCooldown({
      key: KEY,
      claimedAt: T0,
      windowMs: ALERT_ONCE_EVER_WINDOW_MS,
      retryAfterMs: ALERT_NOBODY_ELIGIBLE_RETRY_MS,
      store,
    });
    expect(alertCooldown.updateMany).toHaveBeenLastCalledWith({
      where: { key: KEY, lastAlertedAt: T0 },
      data: {
        lastAlertedAt: new Date(
          T0.getTime() - ALERT_ONCE_EVER_WINDOW_MS + ALERT_NOBODY_ELIGIBLE_RETRY_MS
        ),
        awaitingSendSince: null,
      },
    });

    await expect(claim(store, at(ALERT_NOBODY_ELIGIBLE_RETRY_MS))).resolves.toBe(false);
    await expect(claim(store, at(ALERT_NOBODY_ELIGIBLE_RETRY_MS + 1))).resolves.toBe(true);
    // That new claim is a once-ever one again.
    expect(rows.get(KEY)).toEqual(at(ALERT_NOBODY_ELIGIBLE_RETRY_MS + 1));
  });

  it("never shortens a newer claim it does not own", async () => {
    const { store, rows } = memoryStore();
    await claim(store, T0);

    await deferAlertCooldown({
      key: KEY,
      claimedAt: at(-1),
      windowMs: ALERT_ONCE_EVER_WINDOW_MS,
      retryAfterMs: ALERT_NOBODY_ELIGIBLE_RETRY_MS,
      store,
    });
    expect(rows.get(KEY)).toEqual(T0);
    await expect(claim(store, at(ALERT_NOBODY_ELIGIBLE_RETRY_MS + 1))).resolves.toBe(false);
  });
});

describe("owed alert markers (#3635 F1)", () => {
  const PREFIX = "internet-banking-hold-alert-owed:";
  const OWED = `${PREFIX}released-unreadable:pay_1`;
  const list = (store: never, now: Date) =>
    listOwedAlertKeys({ prefix: PREFIX, now, retryAfterMs: ALERT_NOBODY_ELIGIBLE_RETRY_MS, store });

  it("offers an owed alert at most once a day, counted from its last attempt", async () => {
    const { store } = memoryStore();
    await markAlertOwed({
      key: OWED,
      due: "after-retry",
      retryAfterMs: ALERT_NOBODY_ELIGIBLE_RETRY_MS,
      now: T0,
      store,
    });

    // Not due until a day after it was marked.
    await expect(list(store, at(ALERT_NOBODY_ELIGIBLE_RETRY_MS - 1))).resolves.toEqual([]);
    await expect(list(store, at(ALERT_NOBODY_ELIGIBLE_RETRY_MS))).resolves.toEqual([OWED]);

    // Tried and still undelivered: the next try is a day after that attempt.
    const attempt = at(ALERT_NOBODY_ELIGIBLE_RETRY_MS);
    await noteOwedAlertAttempt({ key: OWED, now: attempt, store });
    await expect(list(store, at(2 * ALERT_NOBODY_ELIGIBLE_RETRY_MS - 1))).resolves.toEqual([]);
    await expect(list(store, at(2 * ALERT_NOBODY_ELIGIBLE_RETRY_MS))).resolves.toEqual([OWED]);
  });

  it("offers an owed alert whose send threw on the very next run (#3635 N1)", async () => {
    const { store } = memoryStore();
    await markAlertOwed({
      key: OWED,
      due: "next-run",
      retryAfterMs: ALERT_NOBODY_ELIGIBLE_RETRY_MS,
      now: T0,
      store,
    });
    // Fifteen minutes later is the next run, and the marker is already due.
    await expect(list(store, at(15 * 60 * 1000))).resolves.toEqual([OWED]);
    await expect(list(store, T0)).resolves.toEqual([OWED]);
  });
});

/*
 * #5255 (`INV-INT-041`): a once-ever claim marked as having no email behind it.
 * The alert's email row confirms it; the sweep gives back only a claim still
 * marked, under its own stamp, so a confirmed or newer claim is never released.
 */
describe("the once-ever claim's unsent mark (#5255)", () => {
  const claimAwaiting = (fake: ReturnType<typeof createAlertCooldownFake>, now: Date) =>
    claimAlertCooldown({ key: KEY, windowMs: ALERT_ONCE_EVER_WINDOW_MS, now, awaitingSend: true, store: fake.store });

  it("marks a claim taken with awaitingSend on both the create and the re-claim path", async () => {
    const fake = createAlertCooldownFake();
    await claimAwaiting(fake, T0);
    expect(fake.rows.get(KEY)?.awaitingSendSince).toEqual(T0);

    await deferAlertCooldown({ key: KEY, claimedAt: T0, windowMs: ALERT_ONCE_EVER_WINDOW_MS, retryAfterMs: 1, store: fake.store });
    expect(fake.rows.get(KEY)?.awaitingSendSince, "a deferred claim is settled for the day").toBeNull();
    await expect(claimAwaiting(fake, at(2))).resolves.toBe(true);
    expect(fake.rows.get(KEY)?.awaitingSendSince).toEqual(at(2));
  });

  it("leaves a claim taken without awaitingSend unmarked", async () => {
    const fake = createAlertCooldownFake();
    await claimAlertCooldown({ key: KEY, windowMs: ALERT_ONCE_EVER_WINDOW_MS, now: T0, store: fake.store });
    expect(fake.rows.get(KEY)?.awaitingSendSince).toBeNull();
    await expect(listStaleUnsentAlertCooldowns({ markedBefore: at(86_400_000), store: fake.store })).resolves.toEqual([]);
  });

  it("confirms under the claim's own stamp, for every recipient, and refuses once the claim is gone", async () => {
    const fake = createAlertCooldownFake();
    const store = fake.store;
    await claimAwaiting(fake, T0);

    await expect(confirmAlertCooldownSend({ key: KEY, claimedAt: at(-1), store }), "another caller's stamp").resolves.toBe(false);
    expect(fake.rows.get(KEY)?.awaitingSendSince).toEqual(T0);
    await expect(confirmAlertCooldownSend({ key: KEY, claimedAt: T0, store })).resolves.toBe(true);
    await expect(confirmAlertCooldownSend({ key: KEY, claimedAt: T0, store }), "the second recipient").resolves.toBe(true);
    expect(fake.rows.get(KEY)?.awaitingSendSince).toBeNull();

    await releaseAlertCooldown({ key: KEY, claimedAt: T0, store });
    await expect(confirmAlertCooldownSend({ key: KEY, claimedAt: T0, store })).resolves.toBe(false);
  });

  it("gives back a claim only while it is still marked, under its own stamp", async () => {
    const fake = createAlertCooldownFake();
    const store = fake.store;
    await claimAwaiting(fake, T0);

    await expect(releaseUnsentAlertCooldown({ key: KEY, claimedAt: at(-1), store })).resolves.toBe(false);
    await confirmAlertCooldownSend({ key: KEY, claimedAt: T0, store });
    await expect(releaseUnsentAlertCooldown({ key: KEY, claimedAt: T0, store }), "confirmed: kept").resolves.toBe(false);
    expect(fake.rows.has(KEY)).toBe(true);

    fake.reset();
    await claimAwaiting(fake, T0);
    await expect(releaseUnsentAlertCooldown({ key: KEY, claimedAt: T0, store })).resolves.toBe(true);
    expect(fake.rows.has(KEY)).toBe(false);
  });

  it("lists claims marked before the cut-off only, oldest first", async () => {
    const fake = createAlertCooldownFake();
    const store = fake.store;
    await claimAlertCooldown({ key: "b", windowMs: ALERT_ONCE_EVER_WINDOW_MS, now: at(2), awaitingSend: true, store });
    await claimAlertCooldown({ key: "a", windowMs: ALERT_ONCE_EVER_WINDOW_MS, now: at(1), awaitingSend: true, store });
    await claimAlertCooldown({ key: "c", windowMs: ALERT_ONCE_EVER_WINDOW_MS, now: at(3), awaitingSend: true, store });

    await expect(listStaleUnsentAlertCooldowns({ markedBefore: at(3), store })).resolves.toEqual([
      { key: "a", lastAlertedAt: at(1) },
      { key: "b", lastAlertedAt: at(2) },
    ]);
  });

  it("stores an owed marker's replayable alert", async () => {
    const fake = createAlertCooldownFake();
    const replayAlert = { kind: "xero-sync-error", errorType: "X" };
    await markAlertOwed({ key: "owed:1", due: "after-retry", retryAfterMs: 1, replayAlert, now: T0, store: fake.store });
    expect(fake.rows.get("owed:1")).toMatchObject({ lastAlertedAt: T0, replayAlert });
  });
});
