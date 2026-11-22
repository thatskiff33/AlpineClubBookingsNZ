import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { stripComments } from "./support/strip-comments";

/**
 * #5399: with a two-address `X-Forwarded-For`, every route records the LAST
 * address, the one the proxy appended, never the first, which the caller wrote.
 *
 * Three layers: the rule at each of its three entry points; one route per
 * family driven to the write that carries the address; and a table over every
 * route file that used to restate the rule, checking each `ipAddress` it
 * records comes from `getClientIp()`. Disk-reading: run by name.
 *
 * Two families are driven in the suite that already builds their route, with a
 * two-address header there: admin booking decisions in
 * `booking-change-requests.test.ts` and saved-card charges in
 * `charge-saved-method-route.test.ts`.
 */
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(async () => null),
  logAudit: vi.fn(),
  issueReportFindMany: vi.fn(async () => []),
  issueReportCount: vi.fn(async () => 0),
  issueReportCreate: vi.fn(async () => ({ id: "issue-1" })),
  memberFindUnique: vi.fn(),
  setLodgeMaintenanceTokenActive: vi.fn(async () => true),
  sendAdminIssueReportAlert: vi.fn(async () => undefined),
  modifyBookingWithLinkedMoveSupport: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock,
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/audit")),
  logAudit: mocks.logAudit,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    issueReport: {
      findMany: mocks.issueReportFindMany,
      count: mocks.issueReportCount,
      create: mocks.issueReportCreate,
    },
    member: { findUnique: mocks.memberFindUnique },
  },
}));
vi.mock("@/lib/maintenance-report-tokens", () => ({
  buildMaintenanceReportSignUrl: vi.fn(),
  getLodgeMaintenanceTokenStatus: vi.fn(),
  mintLodgeMaintenanceToken: vi.fn(),
  setLodgeMaintenanceTokenActive: mocks.setLodgeMaintenanceTokenActive,
}));
vi.mock("@/lib/email", () => ({ sendAdminIssueReportAlert: mocks.sendAdminIssueReportAlert }));
vi.mock("@/lib/booking-linked-date-move-arms", () => ({
  modifyBookingWithLinkedMoveSupport: mocks.modifyBookingWithLinkedMoveSupport,
}));
vi.mock("@/lib/club-time/server", () => ({
  clubTime: async () => ({ today: () => "2026-07-01" }),
}));
vi.mock("@/lib/club-format-server", async () => ({
  clubFormatValues: async () => (await import("./support/club-format-fixture")).CLUB_FORMAT_TEST,
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getAuditRequestContext } from "@/lib/audit";
import { clientIpFromHeaders, getClientIp } from "@/lib/rate-limit-http";
import { GET as listIssueReports } from "@/app/api/admin/issue-reports/route";
import { PATCH as pauseMaintenanceSign } from "@/app/api/admin/maintenance-reports/tokens/route";
import { POST as reportIssue } from "@/app/api/issue-reports/route";
import { PUT as modifyBooking } from "@/app/api/bookings/[id]/modify/route";

const CLAIMED = "203.0.113.250";
const PROXY_SAW = "198.51.100.42";
const TWO_ADDRESSES = { "x-forwarded-for": `${CLAIMED}, ${PROXY_SAW}` };

function request(url: string, init: { method?: string; body?: unknown } = {}) {
  return new NextRequest(url, {
    method: init.method ?? "GET",
    headers: { ...TWO_ADDRESSES, "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

describe("#5399: the one rule, at each entry point", () => {
  const entryPoints: Array<[string, (headers: Record<string, string>) => string | null]> = [
    ["getClientIp", (h) => getClientIp(new Request("http://localhost/", { headers: h }))],
    [
      "getAuditRequestContext",
      (h) => getAuditRequestContext(new Request("http://localhost/", { headers: h }))?.ipAddress ?? null,
    ],
    ["clientIpFromHeaders", (h) => clientIpFromHeaders(new Headers(h))],
  ];

  it.each(entryPoints)("%s takes the last forwarded address, then X-Real-IP", (_name, read) => {
    expect(read(TWO_ADDRESSES)).toBe(PROXY_SAW);
    expect(read({ "x-forwarded-for": PROXY_SAW, "x-real-ip": CLAIMED })).toBe(PROXY_SAW);
    expect(read({ "x-real-ip": PROXY_SAW })).toBe(PROXY_SAW);
  });

  it("falls back to unknown for an address, and null for bare headers", () => {
    expect(getClientIp(new Request("http://localhost/"))).toBe("unknown");
    expect(getAuditRequestContext(new Request("http://localhost/"))?.ipAddress).toBe("unknown");
    expect(clientIpFromHeaders(new Headers())).toBeNull();
    // A header present but holding only commas does not fall back to X-Real-IP.
    expect(clientIpFromHeaders(new Headers({ "x-forwarded-for": ",", "x-real-ip": PROXY_SAW }))).toBeNull();
  });
});

describe("#5399: one route per family records the address the proxy saw", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }], canLogin: true },
    });
    mocks.memberFindUnique.mockResolvedValue({
      id: "admin-1",
      firstName: "Ada",
      lastName: "Admin",
      email: "ada@example.test",
      accessRoles: [{ role: "ADMIN" }],
      canLogin: true,
    });
  });

  const families: Array<[string, () => Promise<Response>]> = [
    ["admin issue reports", () => listIssueReports(request("http://localhost/api/admin/issue-reports"))],
    [
      "admin maintenance reports",
      () =>
        pauseMaintenanceSign(
          request("http://localhost/api/admin/maintenance-reports/tokens", {
            method: "PATCH",
            body: { lodgeId: "lodge-1", active: false },
          }),
        ),
    ],
    [
      "member reports",
      () =>
        reportIssue(
          request("http://localhost/api/issue-reports", {
            method: "POST",
            body: { pageUrl: "http://localhost/book", description: "The calendar did not load." },
          }),
        ),
    ],
  ];

  it.each(families)("%s", async (_family, call) => {
    const response = await call();
    expect(response.status, await response.clone().text()).toBeLessThan(300);
    expect(mocks.logAudit).toHaveBeenCalledTimes(1);
    expect(mocks.logAudit.mock.calls[0]?.[0]).toMatchObject({ ipAddress: PROXY_SAW });
  });

  // The booking-change routes hand the address to the modification service,
  // which writes the audit row, so the hand-over is what is checked.
  it("member booking changes", async () => {
    mocks.auth.mockResolvedValue({
      user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }], canLogin: true },
    });
    const response = await modifyBooking(
      request("http://localhost/api/bookings/bk1/modify", {
        method: "PUT",
        body: { addGuests: [{ firstName: "New", lastName: "Guest", ageTier: "ADULT", isMember: true }] },
      }),
      { params: Promise.resolve({ id: "bk1" }) },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.modifyBookingWithLinkedMoveSupport).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: "bk1", ipAddress: PROXY_SAW }),
    );
  });
});

describe("#5399: every route that restated the rule now records getClientIp()", () => {
  // Every route file #5399 moved, by family. A new file belongs here only if it
  // records an `ipAddress`; the lint arm stops it reading the header itself.
  const ROUTES: Array<[string, string]> = [
    ["admin booking decisions", "src/app/api/admin/booking-change-requests/[id]/route.ts"],
    ["admin booking decisions", "src/app/api/admin/bookings/[id]/review/route.ts"],
    ["admin booking decisions", "src/app/api/admin/refund-requests/[id]/route.ts"],
    ["admin issue reports", "src/app/api/admin/issue-reports/[id]/route.ts"],
    ["admin issue reports", "src/app/api/admin/issue-reports/route.ts"],
    ["admin maintenance reports", "src/app/api/admin/maintenance-reports/[id]/route.ts"],
    ["admin maintenance reports", "src/app/api/admin/maintenance-reports/questions/route.ts"],
    ["admin maintenance reports", "src/app/api/admin/maintenance-reports/settings/route.ts"],
    ["admin maintenance reports", "src/app/api/admin/maintenance-reports/tokens/route.ts"],
    ["member booking changes", "src/app/api/bookings/[id]/confirm-modification-payment/route.ts"],
    ["member booking changes", "src/app/api/bookings/[id]/confirm-payment/route.ts"],
    ["member booking changes", "src/app/api/bookings/[id]/guests/[guestId]/route.ts"],
    ["member booking changes", "src/app/api/bookings/[id]/guests/route.ts"],
    ["member booking changes", "src/app/api/bookings/[id]/modify-dates/route.ts"],
    ["member booking changes", "src/app/api/bookings/[id]/modify/route.ts"],
    ["member booking changes", "src/app/api/bookings/[id]/refund-request/route.ts"],
    ["member reports", "src/app/api/issue-reports/route.ts"],
    ["member reports", "src/app/api/lodge-maintenance/[token]/route.ts"],
    ["member reports", "src/app/api/maintenance-reports/route.ts"],
    ["saved-card charges", "src/app/api/payments/charge-saved-method/route.ts"],
  ];

  it.each(ROUTES)("%s: %s", (_family, file) => {
    const source = stripComments(readFileSync(path.join(process.cwd(), file), "utf8"));
    expect(source).toMatch(/import \{[^}]*\bgetClientIp\b[^}]*\} from "@\/lib\/rate-limit(-http)?";/);
    // The value runs to the next `,` `;` or `}` across lines, so a fallback on
    // the following line (`getClientIp(request)` then `?? other`) is part of it.
    const recorded = [...source.matchAll(/\bipAddress\b(\s*[:=]\s*([^,;}]+))?/g)];
    expect(recorded.length, "records no ipAddress; drop it from this table").toBeGreaterThan(0);
    const declared = /\bconst ipAddress = getClientIp\((req|request)\);/.test(source);
    for (const [whole, assigned, value] of recorded) {
      if (assigned === undefined) expect(declared, `${whole} has no getClientIp() binding`).toBe(true);
      else expect(value?.trim(), whole).toMatch(/^getClientIp\((req|request)\)$/);
    }
  });
});
