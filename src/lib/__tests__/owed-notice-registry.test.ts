import { afterEach, describe, expect, it, vi } from "vitest";

import { OWED_NOTICE_KINDS } from "@/lib/owed-notice/kinds";
import { owedNoticeRegistry } from "@/lib/owed-notice/registry";

/*
 * #5433 review: the owed-notice registry.
 *
 * - Every kind a marker can be written with (`OWED_NOTICE_KINDS`, the type
 *   `recordOwedNotices` takes) has exactly one registered deliverer, and every
 *   registered deliverer's kind is in that list. A kind written but never
 *   registered would sit in a table no sweep reads; this, with the type, is
 *   what stops it.
 * - Every registered kind has a positive wait, a maximum age longer than it,
 *   and, for a member kind, an event key. Its maximum age cannot hide its
 *   cut-off step: a cut-off depends on the subject (the end of a check-in day
 *   months away), so no static comparison is possible, and the sweep instead
 *   sends an over-age marker of a kind with a past-cut-off step to that step
 *   (owed-notice.test.ts). Only a kind without such a step is cleared by age.
 * - The registry reads its deliverers on first use, never at import, so a
 *   deliverer module that imports the drain (which imports the registry) is
 *   no load-order hazard.
 */

afterEach(() => {
  vi.doUnmock("@/lib/booking-bump-notice-owed");
  vi.resetModules();
});

describe("the registered kinds", () => {
  // Imported statically: a dynamic import here pulled in the email and database
  // modules inside the default timeout and once took 5,010 ms on a loaded host.
  it("delivers exactly the kinds a marker can be written with, each once", () => {
    const registered = owedNoticeRegistry().deliverers.map((deliverer) => deliverer.kind);

    expect([...registered].sort()).toEqual([...OWED_NOTICE_KINDS].sort());
    expect(new Set(registered).size).toBe(registered.length);
  });

  it("gives every member kind an event key and every kind a positive wait and maximum age", () => {
    for (const deliverer of owedNoticeRegistry().deliverers) {
      expect(deliverer.sweepAfterMs, deliverer.kind).toBeGreaterThan(0);
      expect(deliverer.maxAgeMs, deliverer.kind).toBeGreaterThan(deliverer.sweepAfterMs);
      if (deliverer.audience === "member") expect(typeof deliverer.idempotencyKey, deliverer.kind).toBe("function");
    }
  });
});

describe("the registry is built on first use", () => {
  // A fresh module graph is loaded here, so this case has its own budget, as
  // the source censuses that load a graph do (docs/TESTING.md).
  it("reads no deliverer export when the registry module loads, only when a drain asks", { timeout: 30_000 }, async () => {
    let reads = 0;
    vi.doMock("@/lib/booking-bump-notice-owed", () => ({
      get BUMP_NOTICE_DELIVERERS() {
        reads += 1;
        return [];
      },
      get legacyBumpMarkerSource() {
        reads += 1;
        return { name: "legacy", listDue: async () => [] };
      },
    }));
    vi.resetModules();
    const { owedNoticeRegistry } = await import("@/lib/owed-notice/registry");
    expect(reads).toBe(0);

    owedNoticeRegistry();
    expect(reads).toBe(2);
    owedNoticeRegistry();
    expect(reads).toBe(2);
  });
});
