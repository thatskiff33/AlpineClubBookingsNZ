import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4366: the real-PostgreSQL proof that a late central-server version answer
 * records nothing once its connection has changed self-skips without
 * `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it only because the race
 * harness imports it. Lose that import and the proof silently becomes a no-op
 * while every suite stays green - so the edge is pinned here, as
 * `manual-reversal-retrying-cancel-realdb-wiring.test.ts` pins #4320's. Each
 * scenario is matched with its `it("` opening, so one turned into `it.skip(`
 * or `it.todo(` fails here too.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the central-server version recorder's real-database proof stays wired into CI (#4366)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./servernz-version-record-race.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/servernz-version-record-race.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    for (const scenario of [
      "records an answer from the connection still stored",
      "records nothing once the same key has been saved again (A -> B -> A)",
      "records nothing once the address has moved, even with the same key",
      "waits for a key change in flight and then records nothing over its forget",
      "lets a separately committed key write and forget clear a recorder holding the row lock",
    ]) {
      expect(suite).toContain(`it("${scenario}"`);
    }
  });
});


it("runs the address/key sync interleavings in the shared race harness (#4436)", () => {
  const harness = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"), "utf8");
  expect(harness).toContain('import "./servernz-connection-race.realdb.test";');
});

it("keeps the Other lodges download's in-flight replacement proof in that suite (#4262 review)", () => {
  const suite = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/servernz-connection-race.realdb.test.ts"), "utf8");
  for (const scenario of [
    "hides, unlinks, renames and records NOTHING once the key is replaced while the pull is in flight",
    "applies the same answer when the connection stands (the control)",
  ]) {
    expect(suite).toContain(`it("${scenario}"`);
  }
});
