import { describe, expect, it, vi } from "vitest";

/*
 * #3672: the cross-instance alert claim, its give-back and its one-day hold.
 * The store is the shared in-memory `alertCooldown` table, which answers the
 * where shapes these helpers use, and every write is also pinned by its call,
 * so dropping the own-stamp guard from a release or a hold fails here.
 */

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  ALERT_NOBODY_ELIGIBLE_RETRY_MS,
  ALERT_ONCE_EVER_WINDOW_MS,
  claimAlertCooldown,
  claimOwedAlert,
  deferAlertCooldown,
  listAllOwedAlertKeys,
  listOwedAlertKeys,
  markAlertOwed,
  noteOwedAlertAttempt,
  releaseAlertCooldown,
  settleOwedAlert,
} from "@/lib/alert-cooldown";
import { createAlertCooldownStore } from "./support/alert-cooldown-store";

/** The shared in-memory table (`support/alert-cooldown-store.ts`), as a helper's `store`. */
function memoryStore() {
  const { rows, delegate } = createAlertCooldownStore();
  return { rows, store: { alertCooldown: delegate } as never, alertCooldown: delegate };
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

describe("listAllOwedAlertKeys (#5240 review)", () => {
  const PREFIX = "saved-card-capture-unsettled:";
  /** A store holding `count` due markers and one not yet due, answering the pager's query shape. */
  function pagedStore(count: number) {
    const rows = new Map<string, Date>(Array.from({ length: count }, (_, i) => [`${PREFIX}pi_${String(i).padStart(3, "0")}`, T0]));
    rows.set(`${PREFIX}pi_late`, at(1));
    const findMany = vi.fn(async ({ where, take }: { where: { key: { startsWith: string }; lastAlertedAt: { lte: Date }; AND?: Array<{ key: { gt: string } }> }; take: number }) =>
      [...rows.entries()]
        .filter(([key, stamp]) => key.startsWith(where.key.startsWith) && stamp <= where.lastAlertedAt.lte && (!where.AND || key > where.AND[0].key.gt))
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, take)
        .map(([key]) => ({ key })));
    return { store: { alertCooldown: { findMany } } as never, findMany };
  }

  it.each([[0, 1], [49, 1], [50, 2], [120, 3]])("returns all %i due markers, reading %i page(s) of 50, and none not yet due", async (count, pages) => {
    const { store, findMany } = pagedStore(count);
    const keys = await listAllOwedAlertKeys({ prefix: PREFIX, now: T0, retryAfterMs: 0, store });
    expect(keys).toHaveLength(count);
    expect(new Set(keys).size).toBe(count);
    expect(keys).not.toContain(`${PREFIX}pi_late`);
    expect(findMany).toHaveBeenCalledTimes(pages);
  });
});

describe("owed alert claims (#5407)", () => {
  const OWED = "booking-bump-officers-owed:b1:0:b";
  const WAIT = 60 * 60 * 1000;

  function owedStore() {
    const { rows, store, alertCooldown } = memoryStore();
    rows.set(OWED, T0);
    return { rows, delegate: alertCooldown, store };
  }

  it("lets exactly one of two callers claim a due marker", async () => {
    const { store, rows } = owedStore();
    const now = at(WAIT);
    const claims = await Promise.all([
      claimOwedAlert({ key: OWED, stampedNoLaterThan: at(0), now, store }),
      claimOwedAlert({ key: OWED, stampedNoLaterThan: at(0), now, store }),
    ]);
    expect(claims.filter(Boolean)).toEqual([now]);
    expect(rows.get(OWED)).toEqual(now);
  });

  it("stamps the claim strictly later than its bound, even on a frozen clock", async () => {
    const { store, rows } = owedStore();
    const claimedAt = await claimOwedAlert({ key: OWED, stampedNoLaterThan: T0, now: T0, store });
    expect(claimedAt).toEqual(at(1));
    expect(rows.get(OWED)).toEqual(at(1));
    // A second caller with the same bound now loses.
    await expect(claimOwedAlert({ key: OWED, stampedNoLaterThan: T0, now: T0, store })).resolves.toBeNull();
  });

  it("does not claim a marker stamped after the bound, or one that is gone", async () => {
    const { store } = owedStore();
    await expect(claimOwedAlert({ key: OWED, stampedNoLaterThan: at(-1), now: at(WAIT), store })).resolves.toBeNull();
    await expect(claimOwedAlert({ key: "missing", stampedNoLaterThan: at(WAIT), now: at(WAIT), store })).resolves.toBeNull();
  });

  it("clears only its own claim when given one", async () => {
    const { store, rows, delegate } = owedStore();
    const mine = await claimOwedAlert({ key: OWED, stampedNoLaterThan: T0, now: at(WAIT), store });
    // Someone else claimed after mine (my send outlived the wait).
    rows.set(OWED, at(3 * WAIT));
    await settleOwedAlert({ key: OWED, claimedAt: mine!, store });
    expect(rows.get(OWED)).toEqual(at(3 * WAIT));
    expect(delegate.deleteMany).toHaveBeenLastCalledWith({ where: { key: OWED, lastAlertedAt: mine } });
    // Without a claim it clears whatever stands, as before.
    await settleOwedAlert({ key: OWED, store });
    expect(rows.has(OWED)).toBe(false);
    expect(delegate.deleteMany).toHaveBeenLastCalledWith({ where: { key: OWED } });
  });
});
