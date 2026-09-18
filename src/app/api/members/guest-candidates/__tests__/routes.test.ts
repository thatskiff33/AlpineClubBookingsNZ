// MG3 (#2308) — the two find routes, at the route level.
//
// THE ENUMERATION LENS'S MANDATORY SCENARIOS live here (FINAL v2 plan §9.1).
// The three that matter most:
//
//   * MODULE OFF ⇒ BOTH ROUTES 404, and open-search OFF ⇒ the search route
//     404s, because a 403 would confirm the club HAS the feature and merely
//     disabled it for the caller.
//   * THE ENVELOPE IS IDENTICAL for "no such member", "inactive member" and
//     "member found but ineligible". The route never evaluates eligibility at
//     all, which is what makes that guarantee structural rather than careful.
//   * TURNING THE SETTING OFF TAKES EFFECT WITHOUT A REDEPLOY. A privacy switch
//     that needs a deploy is not a switch.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  requireActiveSession: vi.fn(),
  isEffectiveModuleEnabled: vi.fn(),
  loadMemberGuestSettings: vi.fn(),
  memberFindMany: vi.fn(),
  createStructuredAuditLog: vi.fn(),
  applyMemberScopedRateLimit: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({
  requireActiveSession: h.requireActiveSession,
}));
vi.mock("@/lib/admin-modules", () => ({
  isEffectiveModuleEnabled: h.isEffectiveModuleEnabled,
}));
vi.mock("@/lib/member-guest-settings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/member-guest-settings")),
  loadMemberGuestSettings: h.loadMemberGuestSettings,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { member: { findMany: h.memberFindMany } },
}));
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/audit")),
  createStructuredAuditLog: h.createStructuredAuditLog,
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/rate-limit")),
  applyMemberScopedRateLimit: h.applyMemberScopedRateLimit,
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { POST as resolveRoute } from "../resolve/route";
import { GET as searchRoute } from "../search/route";
import { GET as configRoute } from "../route";
import { __setMemberGuestRefusalFloorMs } from "@/lib/member-guest-probe-guard";
import {
  MEMBER_GUEST_RESOLVE_AUDIT_ACTION,
  MEMBER_GUEST_SEARCH_AUDIT_ACTION,
} from "@/lib/member-guest-find-service";

const SETTINGS_OFF = {
  approvalRequired: true,
  pendingHoldExpiryDays: 7,
  openMemberSearchEnabled: false,
  openMemberSearchIncludesMinors: false,
};

function resolveRequest(body: unknown) {
  return new NextRequest("https://club.example/api/members/guest-candidates/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function searchRequest(q: string) {
  return new NextRequest(
    `https://club.example/api/members/guest-candidates/search?q=${encodeURIComponent(q)}`,
  );
}

function auditActions() {
  return h.createStructuredAuditLog.mock.calls.map(
    (call) => (call[0] as { action: string }).action,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  __setMemberGuestRefusalFloorMs(0);
  h.requireActiveSession.mockResolvedValue({
    ok: true,
    session: { user: { id: "m-booker" } },
  });
  h.isEffectiveModuleEnabled.mockResolvedValue(true);
  h.loadMemberGuestSettings.mockResolvedValue({ ...SETTINGS_OFF });
  h.memberFindMany.mockResolvedValue([]);
  h.createStructuredAuditLog.mockResolvedValue(undefined);
  h.applyMemberScopedRateLimit.mockResolvedValue(null);
});

describe("the module gate — 404, never 403", () => {
  it("404s the email resolve when the module is off", async () => {
    h.isEffectiveModuleEnabled.mockResolvedValue(false);
    const res = await resolveRoute(resolveRequest({ email: "sam@example.co.nz" }));
    expect(res.status).toBe(404);
    // Nothing was looked up, and nothing about the club leaked in the body.
    expect(h.memberFindMany).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("404s the name search when the module is off", async () => {
    h.isEffectiveModuleEnabled.mockResolvedValue(false);
    expect((await searchRoute(searchRequest("whit"))).status).toBe(404);
  });

  it("404s the name search when the club has NOT turned open search on", async () => {
    // Module on, setting off — the default every club ships in. The route must
    // be as absent as it is on a club without the module at all: the two states
    // are indistinguishable from outside, which is the point.
    const res = await searchRoute(searchRequest("whit"));
    expect(res.status).toBe(404);
    expect(h.memberFindMany).not.toHaveBeenCalled();
  });

  it("stops 404ing the moment a club turns it on, with no redeploy", async () => {
    h.loadMemberGuestSettings.mockResolvedValue({
      ...SETTINGS_OFF,
      openMemberSearchEnabled: true,
    });
    expect((await searchRoute(searchRequest("whit"))).status).toBe(200);
    // ...and starts again the moment they turn it back off.
    h.loadMemberGuestSettings.mockResolvedValue({ ...SETTINGS_OFF });
    expect((await searchRoute(searchRequest("whit"))).status).toBe(404);
  });

  it("tells the wizard the surface is off rather than 404ing the config route", async () => {
    h.isEffectiveModuleEnabled.mockResolvedValue(false);
    const res = await configRoute();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
  });
});

describe("the email resolve — one envelope, whatever the answer", () => {
  it("returns the same 200 and the same shape for a hit and a miss", async () => {
    h.memberFindMany.mockResolvedValue([
      { id: "m-1", firstName: "Sam", lastName: "Whittaker", ageTier: "ADULT" },
    ]);
    const hit = await resolveRoute(resolveRequest({ email: "sam@example.co.nz" }));

    h.memberFindMany.mockResolvedValue([]);
    const miss = await resolveRoute(resolveRequest({ email: "nobody@example.co.nz" }));

    expect(hit.status).toBe(miss.status);
    expect(hit.status).toBe(200);
    const hitBody = await hit.json();
    const missBody = await miss.json();
    expect(Object.keys(hitBody)).toEqual(Object.keys(missBody));
    expect(missBody).toEqual({ candidates: [] });
    // The server sends no reason string, ever. The UI renders one fixed sentence.
    expect(JSON.stringify(missBody)).not.toMatch(/not found|inactive|unpaid|no such/i);
  });

  it("never evaluates eligibility — the query filters on active + age tier and nothing else", async () => {
    await resolveRoute(resolveRequest({ email: "sam@example.co.nz" }));
    const where = h.memberFindMany.mock.calls[0]![0].where;
    expect(Object.keys(where).sort()).toEqual(["active", "ageTier", "email"]);
    expect(where.active).toBe(true);
    // The four eligibility facts D-8 exists to hide must not appear in the query
    // at all: if the finder never asks, it cannot leak the answer.
    const serialised = JSON.stringify(where);
    expect(serialised).not.toMatch(/subscription|profileCompletedAt|guests|booking/i);
  });

  it("returns every active member at a shared household address (D-9 as ticked)", async () => {
    h.memberFindMany.mockResolvedValue([
      { id: "m-1", firstName: "Sam", lastName: "Whittaker", ageTier: "ADULT" },
      { id: "m-2", firstName: "Ella", lastName: "Whittaker", ageTier: "ADULT" },
      { id: "m-3", firstName: "Toby", lastName: "Whittaker", ageTier: "CHILD" },
    ]);
    const body = await (
      await resolveRoute(resolveRequest({ email: "whittakers@example.co.nz" }))
    ).json();
    expect(body.candidates).toHaveLength(3);
    // A minor IS resolvable by household email whatever the sub-setting says
    // (D-20 gates the type-ahead only) — the consequence the owner accepted.
    expect(body.candidates.map((c: { ageTier: string }) => c.ageTier)).toContain("CHILD");
    // And the row carries D-19's four fields and nothing else.
    expect(Object.keys(body.candidates[0]).sort()).toEqual([
      "ageTier",
      "firstName",
      "lastName",
      "memberId",
    ]);
  });

  it("normalises the address the same way the partner-link resolve does", async () => {
    await resolveRoute(resolveRequest({ email: "  SAM@Example.CO.NZ  " }));
    expect(h.memberFindMany.mock.calls[0]![0].where.email).toBe("sam@example.co.nz");
  });

  it("rejects anything that is not a syntactically valid address", async () => {
    const res = await resolveRoute(resolveRequest({ email: "not-an-address" }));
    expect(res.status).toBe(400);
    expect(h.memberFindMany).not.toHaveBeenCalled();
  });

  it("audits every resolve, including the empty one", async () => {
    await resolveRoute(resolveRequest({ email: "nobody@example.co.nz" }));
    expect(auditActions()).toContain(MEMBER_GUEST_RESOLVE_AUDIT_ACTION);
    const event = h.createStructuredAuditLog.mock.calls[0]![0] as Record<string, unknown>;
    expect(event).toMatchObject({
      actor: { memberId: "m-booker" },
      category: "privacy",
      retentionClass: "sensitive_access",
    });
    // The FULL address is stored deliberately — probe detection needs it, and the
    // PR body and admin guide both say so.
    expect(event.metadata).toMatchObject({
      email: "nobody@example.co.nz",
      resultCount: 0,
    });
  });

  it("names the target on an unambiguous resolve, and nobody on a household hit", async () => {
    h.memberFindMany.mockResolvedValue([
      { id: "m-1", firstName: "Sam", lastName: "Whittaker", ageTier: "ADULT" },
    ]);
    await resolveRoute(resolveRequest({ email: "sam@example.co.nz" }));
    expect(
      (h.createStructuredAuditLog.mock.calls[0]![0] as { subject: { memberId: string | null } })
        .subject.memberId,
    ).toBe("m-1");

    vi.clearAllMocks();
    h.createStructuredAuditLog.mockResolvedValue(undefined);
    h.memberFindMany.mockResolvedValue([
      { id: "m-1", firstName: "Sam", lastName: "Whittaker", ageTier: "ADULT" },
      { id: "m-2", firstName: "Ella", lastName: "Whittaker", ageTier: "ADULT" },
    ]);
    await resolveRoute(resolveRequest({ email: "whittakers@example.co.nz" }));
    // One row, naming nobody. Writing one per candidate would turn a single
    // lookup into a permanent record of who lives together.
    expect(h.createStructuredAuditLog).toHaveBeenCalledTimes(1);
    expect(
      (h.createStructuredAuditLog.mock.calls[0]![0] as { subject: { memberId: string | null } })
        .subject.memberId,
    ).toBeNull();
  });

  it("audits a rate-limit rejection as blocked", async () => {
    h.applyMemberScopedRateLimit.mockResolvedValue(
      new Response("{}", { status: 429 }),
    );
    const res = await resolveRoute(resolveRequest({ email: "sam@example.co.nz" }));
    expect(res.status).toBe(429);
    expect(
      (h.createStructuredAuditLog.mock.calls[0]![0] as { outcome: string }).outcome,
    ).toBe("blocked");
  });
});

describe("the name search — prefix-only, capped, no count, minors excluded", () => {
  beforeEach(() => {
    h.loadMemberGuestSettings.mockResolvedValue({
      ...SETTINGS_OFF,
      openMemberSearchEnabled: true,
    });
  });

  it("runs no query at all below the two-character floor, but still audits", async () => {
    const res = await searchRoute(searchRequest("s"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ candidates: [], truncated: false });
    expect(h.memberFindMany).not.toHaveBeenCalled();
    // A run of one-character probes is exactly the shape an admin would want to
    // find later, and would be invisible if only queries that ran a SELECT were
    // recorded.
    expect(auditActions()).toEqual([MEMBER_GUEST_SEARCH_AUDIT_ACTION]);
  });

  it("matches from the START of a name, never mid-string", async () => {
    await searchRoute(searchRequest("whit"));
    const where = h.memberFindMany.mock.calls[0]![0].where;
    expect(JSON.stringify(where)).toContain("startsWith");
    expect(JSON.stringify(where)).not.toContain("contains");
  });

  it("splits a spaced query into first-name AND last-name prefixes", async () => {
    await searchRoute(searchRequest("sam whitt"));
    const where = h.memberFindMany.mock.calls[0]![0].where;
    expect(where.AND).toEqual([
      { firstName: { startsWith: "sam", mode: "insensitive" } },
      { lastName: { startsWith: "whitt", mode: "insensitive" } },
    ]);
  });

  it("excludes minors by default and includes them only when the club opts in", async () => {
    await searchRoute(searchRequest("whit"));
    const defaultTiers = h.memberFindMany.mock.calls[0]![0].where.ageTier.in;
    expect(defaultTiers).not.toContain("CHILD");
    expect(defaultTiers).not.toContain("YOUTH");
    expect(defaultTiers).not.toContain("INFANT");

    h.loadMemberGuestSettings.mockResolvedValue({
      ...SETTINGS_OFF,
      openMemberSearchEnabled: true,
      openMemberSearchIncludesMinors: true,
    });
    await searchRoute(searchRequest("whit"));
    const optedIn = h.memberFindMany.mock.calls[1]![0].where.ageTier.in;
    expect(optedIn).toContain("CHILD");
    expect(optedIn).toContain("YOUTH");
    expect(optedIn).toContain("INFANT");
  });

  it("never returns an inactive member, whatever the settings say", async () => {
    await searchRoute(searchRequest("whit"));
    expect(h.memberFindMany.mock.calls[0]![0].where.active).toBe(true);
  });

  it("caps at ten and reports truncation as a boolean, never a total", async () => {
    h.memberFindMany.mockResolvedValue(
      Array.from({ length: 11 }, (_, i) => ({
        id: `m-${i}`,
        firstName: "Aroha",
        lastName: `Smith${i}`,
        ageTier: "ADULT",
      })),
    );
    const body = await (await searchRoute(searchRequest("sm"))).json();
    expect(body.candidates).toHaveLength(10);
    expect(body.truncated).toBe(true);
    // A count here would be a free membership-size oracle.
    expect(JSON.stringify(body)).not.toContain('"total"');
    expect(h.memberFindMany.mock.calls[0]![0].take).toBe(11);
  });

  it("orders deterministically so the cap cannot be paged past by repeating", async () => {
    await searchRoute(searchRequest("sm"));
    expect(h.memberFindMany.mock.calls[0]![0].orderBy).toEqual([
      { lastName: "asc" },
      { firstName: "asc" },
      { id: "asc" },
    ]);
  });

  it("audits every query with the fragment, the count and the truncation flag", async () => {
    h.memberFindMany.mockResolvedValue([
      { id: "m-1", firstName: "Sam", lastName: "Whittaker", ageTier: "ADULT" },
    ]);
    await searchRoute(searchRequest("whit"));
    const event = h.createStructuredAuditLog.mock.calls[0]![0] as Record<string, unknown>;
    expect(event).toMatchObject({
      action: MEMBER_GUEST_SEARCH_AUDIT_ACTION,
      actor: { memberId: "m-booker" },
      category: "privacy",
      // The short-retention class: this is the high-volume surface.
      retentionClass: "diagnostic_high_volume",
    });
    expect(event.metadata).toMatchObject({ q: "whit", resultCount: 1, truncated: false });
    // A search that returned one person was still a SEARCH; recording it as a
    // lookup of that person would misrepresent it to whoever reads the log.
    expect((event as { subject?: unknown }).subject).toBeUndefined();
  });

  it("audits a rate-limit rejection as blocked, on both windows", async () => {
    h.applyMemberScopedRateLimit.mockResolvedValue(new Response("{}", { status: 429 }));
    const res = await searchRoute(searchRequest("whit"));
    expect(res.status).toBe(429);
    expect(
      (h.createStructuredAuditLog.mock.calls[0]![0] as { outcome: string }).outcome,
    ).toBe("blocked");
  });
});

describe("the wizard config route", () => {
  it("reports the club's real settings when the module is on", async () => {
    h.loadMemberGuestSettings.mockResolvedValue({
      approvalRequired: false,
      pendingHoldExpiryDays: 3,
      openMemberSearchEnabled: true,
      openMemberSearchIncludesMinors: false,
    });
    expect(await (await configRoute()).json()).toEqual({
      enabled: true,
      openSearchEnabled: true,
      approvalRequired: false,
      pendingHoldExpiryDays: 3,
    });
  });
});
