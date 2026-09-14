/**
 * #3058 — who may read the erased-member Xero contact review.
 *
 * WHY THIS IS NOT COVERED BY `admin-route-area-matrix.test.ts`. That test
 * resolves each route path through `getAdminRouteRequirement`, so it pins the
 * path → AREA map. This route passes `requireAdmin` an explicit `permission`
 * literal, and an explicit literal is what wins at runtime — so the matrix
 * would keep passing with `{ area: "overview", level: "view" }` written here.
 * The gate a route really applies is proved by watching the route ask for it.
 *
 * The audience matters more than usual on this surface: every row names a
 * member this club has erased, which is information about a person who asked to
 * be forgotten. `finance:view` is the treasurer audience, matching the sibling
 * missing-contact census — and `view`, not `edit`, because there is nothing
 * here to change.
 */
import { NextRequest } from "next/server";
import { XeroResyncUnavailableError } from "@/lib/xero-mismatch-resync";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getErasedMemberXeroContactReview: vi.fn(),
  checkErasedMemberContactStatuses: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/xero-erased-member-contact-review", () => ({
  DEFAULT_ERASED_CONTACT_ROW_LIMIT: 200,
  getErasedMemberXeroContactReview: mocks.getErasedMemberXeroContactReview,
}));
vi.mock("@/lib/xero-erased-member-contact-status-check", () => ({
  checkErasedMemberContactStatuses: mocks.checkErasedMemberContactStatuses,
}));

import { GET, POST } from "../route";

const EMPTY_REVIEW = {
  needsReview: 0,
  alreadyRetiredInXero: 0,
  rows: [],
  truncated: false,
  lastContactStatusCheckAt: null,
  contactCacheLastRefreshedAt: null,
  contactCacheAgeHours: null,
  contactCacheStale: false,
};

const EMPTY_CHECK = {
  checkedContacts: 0,
  observedContacts: 0,
  notFoundInXero: 0,
  retiredInXero: 0,
  checkedAt: "2026-07-01T00:00:00.000Z",
};

// A real `NextRequest`, because the route reads `nextUrl` — a plain `Request`
// would make the limit-clamping tests pass or fail on the harness rather than
// on the route.
function request(url = "https://club.test/api/admin/xero/erased-member-contacts") {
  return new NextRequest(url);
}

describe("GET /api/admin/xero/erased-member-contacts (#3058)", () => {
  beforeEach(() => {
    mocks.requireAdmin.mockReset();
    mocks.getErasedMemberXeroContactReview.mockReset();
    mocks.checkErasedMemberContactStatuses.mockReset();
    mocks.getErasedMemberXeroContactReview.mockResolvedValue(EMPTY_REVIEW);
    mocks.checkErasedMemberContactStatuses.mockResolvedValue(EMPTY_CHECK);
    mocks.requireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "admin-1" } } });
  });

  it("asks for finance:view, which is the treasurer audience", async () => {
    await GET(request());

    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "finance", level: "view" },
    });
  });

  it("reads nothing at all when the guard refuses", async () => {
    const refusal = new Response("no", { status: 403 });
    mocks.requireAdmin.mockResolvedValue({ ok: false, response: refusal });

    const response = await GET(request());

    expect(response).toBe(refusal);
    // The guard runs BEFORE the review, so an unauthorised caller does not even
    // cause the erased members to be enumerated.
    expect(mocks.getErasedMemberXeroContactReview).not.toHaveBeenCalled();
  });

  it("clamps a nonsense row limit back to the default", async () => {
    await GET(request("https://club.test/api/admin/xero/erased-member-contacts?limit=99999"));
    expect(mocks.getErasedMemberXeroContactReview).toHaveBeenCalledWith({ limit: 200 });

    mocks.getErasedMemberXeroContactReview.mockClear();
    await GET(request("https://club.test/api/admin/xero/erased-member-contacts?limit=twenty"));
    expect(mocks.getErasedMemberXeroContactReview).toHaveBeenCalledWith({ limit: 200 });

    mocks.getErasedMemberXeroContactReview.mockClear();
    await GET(request("https://club.test/api/admin/xero/erased-member-contacts?limit=5"));
    expect(mocks.getErasedMemberXeroContactReview).toHaveBeenCalledWith({ limit: 5 });
  });
});

describe("POST /api/admin/xero/erased-member-contacts (#3058)", () => {
  beforeEach(() => {
    mocks.requireAdmin.mockReset();
    mocks.getErasedMemberXeroContactReview.mockReset();
    mocks.checkErasedMemberContactStatuses.mockReset();
    mocks.getErasedMemberXeroContactReview.mockResolvedValue(EMPTY_REVIEW);
    mocks.checkErasedMemberContactStatuses.mockResolvedValue(EMPTY_CHECK);
    mocks.requireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "admin-1" } } });
  });

  it("applies the same finance:view gate as the read", async () => {
    await POST(request());
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "finance", level: "view" },
    });
  });

  it("asks Xero nothing when the guard refuses", async () => {
    const refusal = new Response("no", { status: 403 });
    mocks.requireAdmin.mockResolvedValue({ ok: false, response: refusal });

    const response = await POST(request());

    expect(response).toBe(refusal);
    expect(mocks.checkErasedMemberContactStatuses).not.toHaveBeenCalled();
    expect(mocks.getErasedMemberXeroContactReview).not.toHaveBeenCalled();
  });

  it("asks Xero about exactly the contacts the screen is listing, and no more", async () => {
    /*
      The bound that keeps this a review aid rather than a licence to sweep the
      Xero contact book. An officer pressing the button pays for the rows in
      front of them; nothing widens the id set behind their back.
    */
    mocks.getErasedMemberXeroContactReview.mockResolvedValue({
      ...EMPTY_REVIEW,
      needsReview: 2,
      rows: [
        { memberId: "m1", xeroContactId: "contact-1" },
        { memberId: "m2", xeroContactId: "contact-2" },
      ],
    });

    await POST(request());

    expect(mocks.checkErasedMemberContactStatuses).toHaveBeenCalledWith([
      "contact-1",
      "contact-2",
    ]);
  });

  it("recomputes after the check, so a newly archived contact leaves the list at once", async () => {
    mocks.getErasedMemberXeroContactReview
      .mockResolvedValueOnce({
        ...EMPTY_REVIEW,
        needsReview: 1,
        rows: [{ memberId: "m1", xeroContactId: "contact-1" }],
      })
      .mockResolvedValueOnce({ ...EMPTY_REVIEW, alreadyRetiredInXero: 1 });

    const body = await (await POST(request())).json();

    expect(mocks.getErasedMemberXeroContactReview).toHaveBeenCalledTimes(2);
    expect(body.review.needsReview).toBe(0);
    expect(body.review.alreadyRetiredInXero).toBe(1);
  });

  it("answers 409 rather than 500 when Xero is not connected", async () => {
    mocks.checkErasedMemberContactStatuses.mockRejectedValue(
      new XeroResyncUnavailableError("Xero is not connected", 409),
    );

    const response = await POST(request());

    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("not connected");
  });
});
