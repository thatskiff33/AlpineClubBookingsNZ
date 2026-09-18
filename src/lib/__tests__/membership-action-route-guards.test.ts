import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Guard-focused tests for the membership queue action routes brought under
// explicit per-area permissions in #1997. Each previously used a bare
// `requireAdmin()` (or `requireAdmin(adminGuardOptions)`) and relied on
// path-inference; the explicit permission must match the area the route-area
// matrix already infers (membership), so no matrix pin moves. We mock
// `requireAdmin` to a denial and assert the exact permission each verb requests
// and that the denial short-circuits before any handler work.
const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  // #2402: the cancellation QUEUE read. Stubbed so the guard test can inspect
  // the one argument the route derives from the viewer's permissions.
  getCancellationQueue: vi.fn(),
}));

// One of the queue libs pulls in `server-only`, which throws outside a real
// server component build. Neutralise it for this node-environment guard test.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/membership-cancellation-admin", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/membership-cancellation-admin")),
  getAdminMembershipCancellationRequests: mocks.getCancellationQueue,
}));

import { POST as deletionPost } from "@/app/api/admin/deletion-requests/[id]/route";
import { PATCH as lifecyclePatch } from "@/app/api/admin/member-lifecycle-action-requests/[requestId]/route";
import {
  GET as familyGet,
  PUT as familyPut,
} from "@/app/api/admin/family-groups/requests/route";
import { POST as refreshPost } from "@/app/api/admin/member-applications/[id]/nominations/refresh/route";
import { POST as replacePost } from "@/app/api/admin/member-applications/[id]/nominators/[slot]/replace/route";
import { POST as participantPost } from "@/app/api/admin/membership-cancellation-requests/[requestId]/participants/[participantId]/route";
import { GET as cancellationQueueGet } from "@/app/api/admin/membership-cancellation-requests/route";
import {
  emptyAdminPermissionMatrix,
  type AdminPermissionLevel,
} from "@/lib/admin-permissions";
import {
  GET as familySuggestionsGet,
  POST as familySuggestionsPost,
} from "@/app/api/admin/family-suggestions/route";
import { POST as familySuggestionsHidePost } from "@/app/api/admin/family-suggestions/hide/route";
import { POST as familySuggestionsResetPost } from "@/app/api/admin/family-suggestions/reset/route";

const MEMBERSHIP_EDIT = { area: "membership", level: "edit" } as const;
const MEMBERSHIP_VIEW = { area: "membership", level: "view" } as const;

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

describe("membership action route guards (#1997)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ ok: false, response: forbidden() });
  });

  it("deletion-request POST requires membership:edit", async () => {
    const res = await deletionPost(req("POST"), {
      params: Promise.resolve({ id: "d1" }),
    });
    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: MEMBERSHIP_EDIT,
    });
  });

  it("lifecycle-action PATCH requires membership:edit", async () => {
    const res = await lifecyclePatch(req("PATCH"), {
      params: Promise.resolve({ requestId: "r1" }),
    });
    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: MEMBERSHIP_EDIT,
    });
  });

  it("family-groups requests GET requires membership:view", async () => {
    const res = await familyGet();
    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ permission: MEMBERSHIP_VIEW }),
    );
  });

  it("family-groups requests PUT requires membership:edit", async () => {
    const res = await familyPut(req("PUT"));
    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ permission: MEMBERSHIP_EDIT }),
    );
  });

  it("application nominations refresh POST requires membership:edit", async () => {
    const res = await refreshPost(req("POST"), {
      params: Promise.resolve({ id: "a1" }),
    });
    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: MEMBERSHIP_EDIT,
    });
  });

  it("application nominator replace POST requires membership:edit", async () => {
    const res = await replacePost(req("POST"), {
      params: Promise.resolve({ id: "a1", slot: "one" }),
    });
    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: MEMBERSHIP_EDIT,
    });
  });

  it("cancellation participant POST requires membership:edit", async () => {
    const res = await participantPost(req("POST"), {
      params: Promise.resolve({ requestId: "r1", participantId: "p1" }),
    });
    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: MEMBERSHIP_EDIT,
    });
  });

  it("family-suggestions GET requires membership:view", async () => {
    const res = await familySuggestionsGet();
    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: MEMBERSHIP_VIEW,
    });
  });

  it("family-suggestions POST (create group) requires membership:edit", async () => {
    const res = await familySuggestionsPost(req("POST"));
    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: MEMBERSHIP_EDIT,
    });
  });

  it("family-suggestions hide POST requires membership:edit", async () => {
    const res = await familySuggestionsHidePost(req("POST"));
    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: MEMBERSHIP_EDIT,
    });
  });

  it("family-suggestions reset POST requires membership:edit", async () => {
    const res = await familySuggestionsResetPost();
    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: MEMBERSHIP_EDIT,
    });
  });

  /*
    #2402 — the wiring the whole change's safety rests on.

    The cancellation QUEUE (GET) is readable by any admin, so it cannot simply
    demand membership:edit at the guard. Instead it asks the SAME question
    separately and uses the answer to decide whether to spend a metered Xero
    call. If that question is ever simplified — to `role === "ADMIN"`, to the
    raw JWT matrix, or to membership:view — a view-only admin silently starts
    burning the club's quota again, and the library tests above would all still
    pass because the library only ever sees the boolean it is handed.

    So the boolean itself is pinned here, next to the participant POST whose
    permission it must agree with.
  */
  describe("cancellation queue GET scopes its Xero check to approvers (#2402)", () => {
    function grantMembership(level: AdminPermissionLevel, role = "USER") {
      mocks.requireAdmin.mockResolvedValue({
        ok: true,
        session: {
          user: {
            id: "admin-1",
            role,
            accessRoles: [],
            // The DB-verified matrix `requireAdmin` resolves, which is what the
            // route must read — not the raw JWT claim, not the legacy role.
            adminPermissionMatrix: {
              ...emptyAdminPermissionMatrix(),
              membership: level,
            },
          },
        },
      });
      mocks.getCancellationQueue.mockResolvedValue({
        requests: [],
        pendingCount: 0,
        total: 0,
        page: 1,
        pageSize: 25,
        totalPages: 0,
      });
    }

    /** The flag the route derived, as the library received it. */
    function viewerCanApprove() {
      return mocks.getCancellationQueue.mock.calls.at(-1)?.[0]
        ?.viewerCanApprove;
    }

    it("asks membership:edit — the same permission the participant POST demands", async () => {
      grantMembership("edit");

      const res = await cancellationQueueGet(req("GET"));

      expect(res.status).toBe(200);
      expect(viewerCanApprove()).toBe(true);
    });

    it("still serves the page to a view-only admin, but without the Xero check", async () => {
      grantMembership("view");

      const res = await cancellationQueueGet(req("GET"));

      // The queue is not an edit-gated page: they lose the check, not the page.
      expect(res.status).toBe(200);
      expect(viewerCanApprove()).toBe(false);
    });

    it("does not fall back to the legacy ADMIN role when the matrix says view", async () => {
      // The regression this exists to catch: `session.user.role === "ADMIN"`
      // looks like a reasonable simplification and is wrong — a club can narrow
      // a definition-backed role below the legacy bundle, and the matrix is the
      // only thing that knows.
      grantMembership("view", "ADMIN");

      await cancellationQueueGet(req("GET"));

      expect(viewerCanApprove()).toBe(false);
    });

    it("treats no membership access at all as unable to approve", async () => {
      grantMembership("none");

      await cancellationQueueGet(req("GET"));

      expect(viewerCanApprove()).toBe(false);
    });
  });
});
