import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  emptyWhakapapaCurlData,
  emptyWhakapapaSectionVisibility,
} from "@/lib/whakapapa-report";

// Regression coverage for PATCH /api/admin/mountain-conditions (PR #1581,
// #1657): the admin guard, invalid-body 400s, visibility persistence that
// preserves the cached report / fetchedAt / freeze window, and the
// PATCH-before-first-fetch fix that backdates fetchedAt so the public GET does
// not serve an empty-but-"fresh" row.

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  findUnique: vi.fn(),
  upsert: vi.fn(),
  fetchWhakapapaCurlData: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    whakapapaReportCache: {
      findUnique: mocks.findUnique,
      upsert: mocks.upsert,
    },
  },
}));

// Only the upstream fetch is mocked. `findInvalidSelectorOverrides` is
// deliberately left REAL so the malformed-selector cases below compile their
// selectors against the same engine the scraper uses. A stub returning a
// hand-written key would pass even if the engine disagreed about what is
// invalid — and jsdom's engine is lenient in places (it accepts an unclosed
// `[class*="x`), so that disagreement is a live risk, not a theoretical one.
vi.mock("@/lib/whakapapa-report.server", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/whakapapa-report.server")),
  fetchWhakapapaCurlData: mocks.fetchWhakapapaCurlData,
}));

import { PATCH, POST } from "@/app/api/admin/mountain-conditions/route";

const ADMIN_USER = {
  id: "admin_1",
  role: "ADMIN",
  accessRoles: [{ role: "ADMIN" }],
};

function patchRequest(body: unknown, { raw = false } = {}) {
  return new NextRequest("http://localhost/api/admin/mountain-conditions", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

/** A fully-populated cached report to prove PATCH preserves the payload. */
function cachedReport() {
  const payload = emptyWhakapapaCurlData();
  payload.updated = "2026-07-08T00:00:00.000Z";
  payload.roadStatus = {
    name: "Bruce Road",
    status: "Open",
    wheelRequirements: "Chains carried",
    roadContent: "Sealed.",
  };
  payload.lifts = [{ name: "Sky Waka", status: "Open" }];
  payload.conditions = [
    {
      name: "Top",
      temperature: "-3",
      wind: "25 km/h",
      snowBase: "120 cm",
      snowfall24h: "5 cm",
      snowfall7d: "30 cm",
    },
  ];
  return payload;
}

describe("PATCH /api/admin/mountain-conditions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: ADMIN_USER });
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    // Echo a complete row back so toResponseRecord can serialize it. Real
    // Prisma upsert returns every column, not only the fields written, so fall
    // back to the create branch (and safe defaults) for anything a partial
    // update omits — e.g. a config-only save leaves payload/fetchedAt untouched.
    mocks.upsert.mockImplementation(async (args) => ({
      source: args.where.source,
      payload:
        args.update.payload ?? args.create?.payload ?? emptyWhakapapaCurlData(),
      config: args.update.config ?? args.create?.config ?? null,
      fetchedAt:
        args.update.fetchedAt ??
        args.create?.fetchedAt ??
        new Date("2026-07-08T09:00:00.000Z"),
      frozenUntil: args.update.frozenUntil ?? args.create?.frozenUntil ?? null,
      updatedAt: new Date("2026-07-08T12:00:00.000Z"),
    }));
  });

  it("returns 403 for a non-admin and never touches the cache", async () => {
    mocks.auth.mockResolvedValue({
      user: { id: "member_1", role: "MEMBER", accessRoles: [] },
    });

    const response = await PATCH(patchRequest({ visibility: { lifts: false } }));

    expect(response.status).toBe(403);
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("returns 401 when there is no session", async () => {
    mocks.auth.mockResolvedValue(null);

    const response = await PATCH(patchRequest({ visibility: { lifts: false } }));

    expect(response.status).toBe(401);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("returns 400 for a body that is not valid JSON", async () => {
    const response = await PATCH(patchRequest("{not json", { raw: true }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid JSON" });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("returns 400 when the visibility object is missing or not an object", async () => {
    const missing = await PATCH(patchRequest({}));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      error: "visibility or config object is required",
    });

    const notObject = await PATCH(patchRequest({ visibility: "all" }));
    expect(notObject.status).toBe(400);

    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("persists visibility while preserving report data, fetchedAt, and frozenUntil", async () => {
    const fetchedAt = new Date("2026-07-08T09:00:00.000Z");
    const frozenUntil = new Date("2026-07-08T21:00:00.000Z");
    const payload = cachedReport();
    mocks.findUnique.mockResolvedValue({
      source: "whakapapa-report",
      payload,
      fetchedAt,
      frozenUntil,
      updatedAt: fetchedAt,
    });

    const response = await PATCH(
      patchRequest({ visibility: { conditions: false } }),
    );

    expect(response.status).toBe(200);
    const [args] = mocks.upsert.mock.calls[0];

    // The freeze window and fetch timestamp survive a visibility toggle...
    expect(args.update.fetchedAt).toBe(fetchedAt);
    expect(args.update.frozenUntil).toBe(frozenUntil);
    // ...as does the cached report data (only visibility changes).
    expect(args.update.payload.roadStatus).toEqual(payload.roadStatus);
    expect(args.update.payload.lifts).toEqual(payload.lifts);
    expect(args.update.payload.conditions).toEqual(payload.conditions);
    // Partial input is coerced: only `conditions` flips, the rest stay visible.
    expect(args.update.payload.visibility).toEqual({
      ...emptyWhakapapaSectionVisibility(),
      conditions: false,
    });

    const bodyRecord = (await response.json()).record;
    expect(bodyRecord.fetchedAt).toBe(fetchedAt.toISOString());
    expect(bodyRecord.frozenUntil).toBe(frozenUntil.toISOString());
  });

  it("backdates fetchedAt to the epoch when creating a visibility-only row (no prior fetch)", async () => {
    // #1657 fix: with no cache row, a naive PATCH would create one stamped
    // `now` with an empty payload, and the public GET would serve those empty
    // sections as "fresh" for the whole TTL window. Backdating fetchedAt marks
    // the row stale so the next public read fetches upstream.
    mocks.findUnique.mockResolvedValue(null);

    const response = await PATCH(
      patchRequest({ visibility: { lifts: false } }),
    );

    expect(response.status).toBe(200);
    const [args] = mocks.upsert.mock.calls[0];

    expect(args.create.fetchedAt.getTime()).toBe(0);
    expect(args.create.frozenUntil).toBeNull();
    // The payload is empty report data carrying only the new visibility.
    expect(args.create.payload.visibility).toEqual({
      ...emptyWhakapapaSectionVisibility(),
      lifts: false,
    });
    expect(args.create.payload.conditions).toEqual([]);

    // The serialized response advertises the stale (epoch) timestamp.
    const bodyRecord = (await response.json()).record;
    expect(bodyRecord.fetchedAt).toBe(new Date(0).toISOString());
  });
});

describe("PATCH config (source URL + selectors)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: ADMIN_USER });
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.findUnique.mockResolvedValue(null);
    mocks.upsert.mockImplementation(async (args) => ({
      source: args.where.source,
      payload:
        args.update.payload ?? args.create?.payload ?? emptyWhakapapaCurlData(),
      config: args.update.config ?? args.create?.config ?? null,
      fetchedAt: args.create?.fetchedAt ?? new Date(0),
      frozenUntil: args.create?.frozenUntil ?? null,
      updatedAt: new Date("2026-07-08T12:00:00.000Z"),
    }));
  });

  it("saves a valid config and only writes the config column on update", async () => {
    const response = await PATCH(
      patchRequest({
        config: {
          sourceUrl: "https://www.whakapapa.com/report",
          selectorOverrides: { item: '[class*="row_"]', ignored: "x" },
        },
      }),
    );

    expect(response.status).toBe(200);
    const [args] = mocks.upsert.mock.calls[0];
    // Config-only save never rewrites the cached report or its timestamps.
    expect(args.update).toEqual({
      config: {
        sourceUrl: "https://www.whakapapa.com/report",
        selectorOverrides: { item: '[class*="row_"]' },
      },
    });

    const bodyRecord = (await response.json()).record;
    expect(bodyRecord.config.sourceUrl).toBe(
      "https://www.whakapapa.com/report",
    );
  });

  it("rejects an off-allowlist source URL (SSRF guard) and never writes", async () => {
    const response = await PATCH(
      patchRequest({ config: { sourceUrl: "https://evil.example.com/report" } }),
    );

    expect(response.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("rejects a non-https source URL", async () => {
    const response = await PATCH(
      patchRequest({
        config: { sourceUrl: "http://www.whakapapa.com/report" },
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("rejects a malformed selector override, naming the field, and never writes", async () => {
    // Compiled for real by the scraper's own engine: this string throws, so
    // the route must refuse the save rather than store a selector that would
    // throw on every later scrape.
    const response = await PATCH(
      patchRequest({
        config: {
          sourceUrl: "https://www.whakapapa.com/report",
          selectorOverrides: { item: "[[not-a-selector" },
        },
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    // The error names the human-readable field label.
    expect(body.error).toContain("Item: row");
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});

describe("POST preview (test config without saving)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: ADMIN_USER });
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.findUnique.mockResolvedValue(null);
  });

  function postRequest(body: unknown) {
    return new NextRequest("http://localhost/api/admin/mountain-conditions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("fetches with the supplied config and returns the parsed preview without persisting", async () => {
    const preview = cachedReport();
    mocks.fetchWhakapapaCurlData.mockResolvedValue(preview);

    const response = await POST(
      postRequest({
        preview: true,
        config: { sourceUrl: "https://www.whakapapa.com/report" },
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.preview.roadStatus).toEqual(preview.roadStatus);
    // Preview must not write to the cache.
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.fetchWhakapapaCurlData).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceUrl: "https://www.whakapapa.com/report",
      }),
    );
  });

  it("rejects a preview whose URL is off-allowlist before fetching", async () => {
    const response = await POST(
      postRequest({
        preview: true,
        config: { sourceUrl: "https://internal.local/report" },
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.fetchWhakapapaCurlData).not.toHaveBeenCalled();
  });

  it("names the bad selector on preview instead of the generic upstream 502", async () => {
    const response = await POST(
      postRequest({
        preview: true,
        config: {
          sourceUrl: "https://www.whakapapa.com/report",
          // Trailing empty attribute clause — the scraper's own engine throws.
          selectorOverrides: { conditionRow: '[class*="locationRow_"][' },
        },
      }),
    );

    expect(response.status).toBe(400);
    // The admin is told WHICH field to fix, by its human-readable label.
    expect((await response.json()).error).toContain("Conditions: location row");
    expect(mocks.fetchWhakapapaCurlData).not.toHaveBeenCalled();
  });
});
