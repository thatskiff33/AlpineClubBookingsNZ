import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SENTRY_PRIVACY_INIT_OPTIONS } from "@/lib/sentry-privacy-options";

const ROOT = path.resolve(__dirname, "../../..");
const INIT_FILES = [
  "sentry.server.config.ts",
  "sentry.edge.config.ts",
  "src/instrumentation-client.ts",
];

describe("Sentry 11 collects no more than v10 did (#3892, INV-INT-005, INV-PRIV-011)", () => {
  it("keeps the v10 data-collection baseline", () => {
    const { dataCollection, attachStacktrace } = SENTRY_PRIVACY_INIT_OPTIONS;
    expect(dataCollection.userInfo).toBe(false);
    expect(dataCollection.cookies).toBe(false);
    expect(dataCollection.httpBodies).toEqual([]);
    expect(dataCollection.databaseQueryData).toBe(false);
    expect(dataCollection.queues).toBe(false);
    expect(dataCollection.genAI).toEqual({ inputs: false, outputs: false });
    expect(dataCollection.graphQL).toEqual({ document: false, variables: false });
    for (const list of [
      dataCollection.httpHeaders.request.deny,
      dataCollection.httpHeaders.response.deny,
      dataCollection.urlQueryParams.deny,
    ]) {
      expect(list).toEqual(expect.arrayContaining(["forwarded", "-ip", "remote-", "via", "-user"]));
    }
    expect(attachStacktrace).toBe(false);
  });

  it.each(INIT_FILES)("%s spreads the options as the first thing its Sentry.init sets", (file) => {
    const source = readFileSync(path.join(ROOT, file), "utf8");
    expect(source).toContain('import { SENTRY_PRIVACY_INIT_OPTIONS } from "@/lib/sentry-privacy-options";');
    expect(source).toMatch(/Sentry\.init\(\{\n(?:\s*\/\/[^\n]*\n)*\s*\.\.\.SENTRY_PRIVACY_INIT_OPTIONS,\n/);
    expect(source).not.toMatch(/\bdataCollection\s*:/);
    expect(source).not.toMatch(/\bsendDefaultPii\b/);
    // Nothing later in the init may restore a v11 default the spread turned off.
    expect(source).not.toMatch(/\battachStacktrace\s*:/);
    // An integration-level `include` overrides dataCollection (MIGRATION.md, RequestData).
    expect(source).not.toMatch(/\b(?:requestDataIntegration|httpClientIntegration)\s*\(/);
  });
});
