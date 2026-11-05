import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BREACHED_PASSWORD_RANGE_URL } from "@/lib/breached-password-endpoint";
import {
  dropBreachedPasswordRangeBreadcrumb,
  scrubBreachedPasswordRange,
  scrubBreachedPasswordRangeDeep,
  scrubBreachedPasswordRangeSpan,
  SENTRY_PRIVACY_INIT_OPTIONS,
} from "@/lib/sentry-privacy-options";

const ROOT = path.resolve(__dirname, "../../..");
const INIT_FILES = [
  "sentry.server.config.ts",
  "sentry.edge.config.ts",
  "src/instrumentation-client.ts",
];

it("ships both automatic Replay rates at zero without a recording integration", () => {
  const source = readFileSync(path.join(ROOT, "src/instrumentation-client.ts"), "utf8");
  expect(source).toMatch(/replaysSessionSampleRate:\s*0,/);
  expect(source).toMatch(/replaysOnErrorSampleRate:\s*0,/);
  expect(source).not.toMatch(/Sentry\.replayIntegration\(/);
});

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
    expect(source).toMatch(
      /import \{[^}]*\bSENTRY_PRIVACY_INIT_OPTIONS,?[^}]*\} from "@\/lib\/sentry-privacy-options";/,
    );
    expect(source).toMatch(/Sentry\.init\(\{\n(?:\s*\/\/[^\n]*\n)*\s*\.\.\.SENTRY_PRIVACY_INIT_OPTIONS,\n/);
    expect(source).not.toMatch(/\bdataCollection\s*:/);
    expect(source).not.toMatch(/\bsendDefaultPii\b/);
    // Nothing later in the init may restore a v11 default the spread turned off.
    expect(source).not.toMatch(/\battachStacktrace\s*:/);
    // An integration-level `include` overrides dataCollection (MIGRATION.md, RequestData).
    expect(source).not.toMatch(/\b(?:requestDataIntegration|httpClientIntegration)\s*\(/);
  });
});

// #4610 (INV-AUTH-005): the breached-password lookup's outgoing fetch would put
// `<range URL><5-character SHA-1 prefix>` on a Sentry span and breadcrumb.
describe("Sentry never carries the breached-password range prefix (#4610)", () => {
  const PREFIX = "21BD1";
  const RANGE = `${BREACHED_PASSWORD_RANGE_URL}${PREFIX}`;
  const host = new URL(BREACHED_PASSWORD_RANGE_URL).hostname;
  const ignoreSpans = SENTRY_PRIVACY_INIT_OPTIONS.ignoreSpans;
  type Span = Parameters<typeof scrubBreachedPasswordRangeSpan>[0];
  const span = (name: string, attributes: Record<string, unknown>): Span =>
    ({
      trace_id: "t",
      span_id: "s",
      name,
      start_timestamp: 0,
      status: "ok",
      is_segment: false,
      attributes,
    }) as Span;

  // Sentry's own matcher semantics (core `shouldIgnoreSpan`): a bare pattern
  // tests the name; an object's attribute patterns must all match.
  const matches = (pattern: unknown, value: string) =>
    pattern instanceof RegExp ? pattern.test(value) : value.includes(String(pattern));
  const ignored = (name: string, attributes: Record<string, string>) =>
    ignoreSpans.some((entry) =>
      entry instanceof RegExp
        ? matches(entry, name)
        : Object.entries(entry.attributes).every(
            ([key, pattern]) => key in attributes && matches(pattern, attributes[key]),
          ),
    );

  it("keys every filter on the exported endpoint constant", () => {
    expect(scrubBreachedPasswordRange(RANGE)).not.toContain(PREFIX);
    expect(scrubBreachedPasswordRange(RANGE)).toContain(new URL(BREACHED_PASSWORD_RANGE_URL).host);
  });

  it("drops the fetch span by name, url.full, http.url or host, and keeps others", () => {
    expect(ignored(`GET ${RANGE}`, {})).toBe(true);
    expect(ignored(`fetch GET ${RANGE}`, {})).toBe(true);
    expect(ignored(`GET ${host}`, { "url.full": RANGE })).toBe(true);
    expect(ignored("fetch", { "http.url": RANGE })).toBe(true);
    expect(ignored(`GET ${host}`, { "server.address": host, "url.path": `/range/${PREFIX}` })).toBe(true);
    expect(ignored("GET api.stripe.com", { "url.full": "https://api.stripe.com/v1/charges", "server.address": "api.stripe.com" })).toBe(false);
    expect(ignored("GET /range/ABCDE", { "url.full": "https://example.test/range/ABCDE" })).toBe(false);
  });

  it("scrubs a span that reaches beforeSendSpan, and leaves other spans untouched", () => {
    const leaky = scrubBreachedPasswordRangeSpan(
      span(`fetch GET ${RANGE}`, {
        "http.url": RANGE,
        "url.domain": host,
        "url.path": `/range/${PREFIX}`,
        "tags": [RANGE, 1],
      }),
    );
    expect(JSON.stringify(leaky)).not.toContain(PREFIX);
    expect(leaky.attributes["url.domain"]).toBe(host);

    const other = span("GET https://api.stripe.com/v1/range/ABCDE", {
      "url.full": "https://api.stripe.com/v1/range/ABCDE",
      "url.path": "/range/ABCDE",
    });
    const before = JSON.stringify(other);
    expect(JSON.stringify(scrubBreachedPasswordRangeSpan(other))).toBe(before);
    expect(SENTRY_PRIVACY_INIT_OPTIONS.beforeSendSpan).toBe(scrubBreachedPasswordRangeSpan);
  });

  it("drops a fetch breadcrumb to the range, and returns others unchanged", () => {
    expect(
      dropBreachedPasswordRangeBreadcrumb({
        category: "http",
        type: "http",
        data: { method: "GET", url: RANGE, status_code: 200 },
      }),
    ).toBeNull();
    expect(dropBreachedPasswordRangeBreadcrumb({ category: "console", message: `fetch failed ${RANGE}` })).toBeNull();
    const other = { category: "http", type: "http", data: { method: "GET", url: "https://api.stripe.com/v1" } };
    expect(dropBreachedPasswordRangeBreadcrumb(other)).toBe(other);
  });

  it("scrubs an event deep, cycles included, and leaves other strings alone", () => {
    const event: Record<string, unknown> = {
      message: "unrelated",
      exception: { values: [{ type: "TypeError", value: `fetch failed for ${RANGE}` }] },
      extra: { nested: { list: [`see ${RANGE}?x=1`] } },
    };
    event.self = event;
    const scrubbed = scrubBreachedPasswordRangeDeep(event);
    expect(JSON.stringify({ ...scrubbed, self: undefined })).not.toContain(PREFIX);
    expect(scrubbed.message).toBe("unrelated");
  });

  it.each(INIT_FILES)("%s runs the breadcrumb and event filters", (file) => {
    const source = readFileSync(path.join(ROOT, file), "utf8");
    expect(source).toMatch(/beforeBreadcrumb\(breadcrumb\) \{\n(?:\s*\/\/[^\n]*\n)*\s*const kept = dropBreachedPasswordRangeBreadcrumb\(breadcrumb\);/);
    expect(source).toMatch(/return scrubBreachedPasswordRangeDeep\(event\);\n\s*\},/);
    // A later key would replace the shared span filters.
    expect(source).not.toMatch(/\b(?:ignoreSpans|beforeSendSpan)\s*:/);
  });
});
