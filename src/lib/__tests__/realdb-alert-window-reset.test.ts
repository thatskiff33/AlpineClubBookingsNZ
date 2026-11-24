/**
 * #5407: the real-database set-up clears the global alert windows before every
 * realdb test. Pinned with fakes; no PostgreSQL here.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { XERO_SYNC_ERROR_ALERT_COOLDOWN_KEY } from "@/lib/xero-sync-error-alert-key";

import {
  REALDB_GLOBAL_ALERT_KEYS,
  resetRealdbGlobalAlertWindows,
  type RealdbAlertWindowResetDeps,
} from "./support/realdb-alert-window-reset";
import type { RealdbLockClient } from "./support/realdb-file-serialisation";

const RACE_URL = "postgresql://postgres:postgres@127.0.0.1:55767/concurrency_race_1881";
const REALDB_FILE = "/repo/src/lib/__tests__/xero-refund-note-void-pointer.realdb.test.ts";

function harness(options: { testPath?: string; url?: string; failWith?: { code: string } } = {}) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  let connects = 0;
  let ends = 0;
  const hooks: { beforeEach?: () => Promise<void>; afterAll?: () => Promise<void> } = {};
  const client: RealdbLockClient = {
    on: () => undefined,
    connect: async () => {
      connects += 1;
    },
    query: async <R extends Record<string, unknown>>(text: string, values: unknown[]) => {
      queries.push({ text, values });
      if (options.failWith) throw Object.assign(new Error("db"), options.failWith);
      return { rows: [] as R[] };
    },
    end: async () => {
      ends += 1;
    },
  };
  const deps: RealdbAlertWindowResetDeps = {
    beforeEach: (fn) => {
      hooks.beforeEach = fn;
    },
    afterAll: (fn) => {
      hooks.afterAll = fn;
    },
    testPath: () => options.testPath ?? REALDB_FILE,
    raceDatabaseUrl: () => options.url ?? RACE_URL,
    connect: () => client,
  };
  resetRealdbGlobalAlertWindows(deps);
  return { hooks, queries, counts: () => ({ connects, ends }) };
}

describe("resetRealdbGlobalAlertWindows (#5407)", () => {
  it("clears the sync error alert's key", () => {
    expect(REALDB_GLOBAL_ALERT_KEYS).toContain(XERO_SYNC_ERROR_ALERT_COOLDOWN_KEY);
  });

  it("deletes the global keys before every test on one connection per file", async () => {
    const { hooks, queries, counts } = harness();

    await hooks.beforeEach!();
    await hooks.beforeEach!();
    await hooks.afterAll!();

    expect(queries).toEqual([
      { text: 'DELETE FROM "AlertCooldown" WHERE "key" = ANY($1)', values: [[XERO_SYNC_ERROR_ALERT_COOLDOWN_KEY]] },
      { text: 'DELETE FROM "AlertCooldown" WHERE "key" = ANY($1)', values: [[XERO_SYNC_ERROR_ALERT_COOLDOWN_KEY]] },
    ]);
    expect(counts()).toEqual({ connects: 1, ends: 1 });
  });

  it.each([
    ["a file that is not a realdb file", { testPath: "/repo/src/lib/__tests__/x.test.ts" }],
    ["no race database configured", { url: "" }],
  ])("does nothing for %s", async (_label, options) => {
    const { hooks, queries, counts } = harness(options);

    await hooks.beforeEach!();
    await hooks.afterAll!();

    expect(queries).toEqual([]);
    expect(counts()).toEqual({ connects: 0, ends: 0 });
  });

  it("refuses a database that is not a throwaway race database", async () => {
    const { hooks } = harness({ url: "postgresql://postgres:postgres@127.0.0.1:5432/tacbookings" });

    await expect(hooks.beforeEach!()).rejects.toThrow();
  });

  it("leaves a database without the table alone, and fails on any other error", async () => {
    await expect(harness({ failWith: { code: "42P01" } }).hooks.beforeEach!()).resolves.toBeUndefined();
    await expect(harness({ failWith: { code: "57P01" } }).hooks.beforeEach!()).rejects.toThrow("db");
  });

  it("is registered by vitest.setup.ts under the realdb switch, after the file lock", () => {
    const setup = readFileSync(path.join(process.cwd(), "vitest.setup.ts"), "utf8");
    expect(setup).toMatch(
      /serialiseRealdbFile\(\);\s*\}[\s\S]*?if \(process\.env\.RUN_CONCURRENCY_RACE_TESTS === "1"\) \{[\s\S]*?resetRealdbGlobalAlertWindows\(\);\s*\}/,
    );
  });
});
