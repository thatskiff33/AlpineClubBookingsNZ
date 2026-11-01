import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
describe("INV-PAY-140 / INV-LOCK-002 composed whole-lodge proofs reach CI", () => {
  it("imports the opt-in suite from the disposable PostgreSQL harness", () => {
    const harness = readFileSync(resolve(ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"), "utf8");
    expect(harness).toContain('import "./whole-lodge-payment-review.realdb.test";');
    const suite = readFileSync(resolve(ROOT, "src/lib/__tests__/whole-lodge-payment-review.realdb.test.ts"), "utf8");
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("a sanctioned placeholder link returns excess credit after actual approval/card attachment");
    expect(suite).toContain("preserves the negotiated-price guard for structural edits after card entry");
    expect(suite).toContain("two pre-read switch requests create one receivable and one receipt posting");
    // #4019 review finding 4: the date and guest-removal doors' confirmation posters.
    expect(suite).toContain('it.each(["dates", "guest-removal"])("the %s door posts the confirmation charge when credit settles an abandoned card attempt at zero cash"');
  });
});
