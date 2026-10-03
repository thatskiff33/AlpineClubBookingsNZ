import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Guard-focused tests for the finance / support / communications action routes
// brought under explicit per-area permissions in #1997. Each previously used a
// bare `requireAdmin()` (or one carrying only response overrides) and relied on
// path-inference; the explicit permission must match the area the route-area
// matrix already infers, so no matrix pin moves. We mock `requireAdmin` to a
// denial and assert the exact permission each verb requests and that the denial
// short-circuits before any handler work.
const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { PUT as refundPut } from "@/app/api/admin/refund-requests/[id]/route";
import { POST as retryAllPost } from "@/app/api/admin/xero/operations/retry-all/route";
import { POST as resetStalePost } from "@/app/api/admin/xero/operations/reset-stale-running/route";
import { POST as markNonReplayablePost } from "@/app/api/admin/xero/operations/[id]/mark-non-replayable/route";
import { POST as markFailedPost } from "@/app/api/admin/xero/operations/[id]/mark-failed/route";
import { POST as resolvePost } from "@/app/api/admin/xero/operations/[id]/resolve/route";
import { POST as generateInvoicePost } from "@/app/api/admin/payments/[id]/generate-invoice/route";
import {
  GET as issueReportGet,
  PATCH as issueReportPatch,
} from "@/app/api/admin/issue-reports/[id]/route";
import { POST as reissuePost } from "@/app/api/admin/email-failures/[id]/reissue-token/route";
import { POST as reviewPost } from "@/app/api/admin/email-failures/[id]/review/route";
import { POST as clearSuppressionPost } from "@/app/api/admin/email-suppressions/[id]/clear/route";
import {
  GET as commsGet,
  POST as commsPost,
} from "@/app/api/admin/communications/send/route";
import { POST as xeroLinkPost } from "@/app/api/admin/members/[id]/xero-link/route";
import { POST as xeroPushPost } from "@/app/api/admin/members/[id]/xero-push/route";
import { POST as xeroUnlinkPost } from "@/app/api/admin/members/[id]/xero-unlink/route";

const FINANCE_EDIT = { area: "finance", level: "edit" } as const;
const SUPPORT_VIEW = { area: "support", level: "view" } as const;
const SUPPORT_EDIT = { area: "support", level: "edit" } as const;
const MEMBERSHIP_VIEW = { area: "membership", level: "view" } as const;
const MEMBERSHIP_EDIT = { area: "membership", level: "edit" } as const;

function forbidden() {
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

function req(method: string) {
  return new NextRequest("http://localhost/api/admin/x", {
    method,
    headers: { "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify({}),
  });
}

const idParams = { params: Promise.resolve({ id: "x1" }) };

describe("finance/support/comms action route guards (#1997)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ ok: false, response: forbidden() });
  });

  it("refund-request PUT requires finance:edit", async () => {
    const res = await refundPut(req("PUT"), idParams);
    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: FINANCE_EDIT,
    });
  });

  it("xero retry-all POST requires finance:edit", async () => {
    const res = await retryAllPost();
    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: FINANCE_EDIT,
    });
  });

  it("xero reset-stale-running POST requires finance:edit", async () => {
    const res = await resetStalePost();
    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: FINANCE_EDIT,
    });
  });

  it("xero mark-non-replayable POST requires finance:edit", async () => {
    const res = await markNonReplayablePost(req("POST"), idParams);
    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: FINANCE_EDIT,
    });
  });

  it("xero mark-failed POST requires finance:edit (#3462)", async () => {
    const res = await markFailedPost(req("POST"), idParams);
    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: FINANCE_EDIT,
    });
  });

  it("xero resolve POST requires finance:edit", async () => {
    const res = await resolvePost(req("POST"), idParams);
    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: FINANCE_EDIT,
    });
  });

  it("generate-invoice POST requires finance:edit", async () => {
    const res = await generateInvoicePost(req("POST"), idParams);
    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ permission: FINANCE_EDIT }),
    );
  });

  it("issue-report GET requires support:view", async () => {
    const res = await issueReportGet(req("GET"), idParams);
    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: SUPPORT_VIEW,
    });
  });

  it("issue-report PATCH requires support:edit", async () => {
    const res = await issueReportPatch(req("PATCH"), idParams);
    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: SUPPORT_EDIT,
    });
  });

  it("email reissue-token POST requires support:edit", async () => {
    const res = await reissuePost(req("POST"), idParams);
    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: SUPPORT_EDIT,
    });
  });

  it("email failure review POST requires support:edit", async () => {
    const res = await reviewPost(req("POST"), idParams);
    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: SUPPORT_EDIT,
    });
  });

  it("email-suppression clear POST requires support:edit", async () => {
    const res = await clearSuppressionPost(req("POST"), idParams);
    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: SUPPORT_EDIT,
    });
  });

  it("communications send GET requires membership:view", async () => {
    const res = await commsGet();
    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: MEMBERSHIP_VIEW,
    });
  });

  it("communications send POST requires membership:edit", async () => {
    const res = await commsPost(req("POST"));
    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: MEMBERSHIP_EDIT,
    });
  });

  // The members/[id]/xero-(link|push|unlink) routes are mapped to the finance
  // area by SPECIAL_ROUTE_AREA_PATTERNS, so their explicit permission is
  // finance:edit (pin-neutral).
  it("member xero-link POST requires finance:edit", async () => {
    const res = await xeroLinkPost(req("POST"), idParams);
    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: FINANCE_EDIT,
    });
  });

  it("member xero-push POST requires finance:edit", async () => {
    const res = await xeroPushPost(req("POST"), idParams);
    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: FINANCE_EDIT,
    });
  });

  it("member xero-unlink POST requires finance:edit", async () => {
    const res = await xeroUnlinkPost(req("POST"), idParams);
    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: FINANCE_EDIT,
    });
  });
});
