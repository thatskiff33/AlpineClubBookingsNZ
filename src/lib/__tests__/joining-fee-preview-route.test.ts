// #1931 (E5, item 15) HIGH-2 regression: the approval panel feeds the
// applications API's applicantDateOfBirth straight into the joining-fee
// preview route, whose dateOfBirth schema is a strict date-only regex. The
// applications API used to serialise a full ISO datetime, so EVERY applicant
// with a DOB got a 400 and the preview/prefill silently never fired. This test
// drives a real stored DOB through the same serialisation the applications API
// now uses and into the REAL route handler (joining-fee-preview.test.tsx mocks
// fetch, so it cannot catch a schema/serialisation mismatch).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { requireAdmin, previewForInputs, previewForMember } = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  previewForInputs: vi.fn(),
  previewForMember: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin }));
vi.mock("@/lib/joining-fee", () => ({
  getJoiningFeePreviewForInputs: previewForInputs,
  getJoiningFeePreviewForMember: previewForMember,
}));

import { POST } from "@/app/api/admin/members/[id]/joining-fee/preview/route";
import { formatDateOnlyForTimeZone } from "@/lib/date-only";

const PREVIEW = {
  defaultAmountCents: 10000,
  defaultNarration: "Membership joining fee (Adult)",
  exempt: false,
  effectiveFrom: "2026-01-01",
  source: "SCHEDULE",
};

function makeRequest(body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/admin/members/app-1/joining-fee/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const routeParams = { params: Promise.resolve({ id: "app-1" }) };

/**
 * The club's zone, named rather than taken from a helper default (#3123).
 * This suite is about the DOB round-trip, and both cases below turn on what
 * the club calls the stored instant. That the zone comes from the PERSISTED
 * club timezone is pinned in
 * `joining-fee/preview/__tests__/club-time-authority.test.ts`.
 */
const CLUB_ZONE = "Pacific/Auckland";

beforeEach(() => {
  vi.clearAllMocks();
  requireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "admin-1" } } });
  previewForInputs.mockResolvedValue(PREVIEW);
  previewForMember.mockResolvedValue(PREVIEW);
});

describe("POST /api/admin/members/[id]/joining-fee/preview — applicant DOB round-trip", () => {
  it("accepts the NZ date-only DOB the applications API serialises (UTC-midnight storage)", async () => {
    // What the DB hands the applications API, and what that API now emits.
    const storedDob = new Date("1990-05-15T00:00:00.000Z");
    const serialised = formatDateOnlyForTimeZone(storedDob, CLUB_ZONE);
    expect(serialised).toBe("1990-05-15");

    const response = await POST(
      makeRequest({ membershipTypeKey: "FULL", dateOfBirth: serialised }),
      routeParams,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ defaultAmountCents: 10000 });
    expect(previewForInputs).toHaveBeenCalledWith(
      expect.objectContaining({
        membershipTypeKey: "FULL",
        dateOfBirth: new Date("1990-05-15T00:00:00.000Z"),
      }),
      // #3123 - the route now resolves the club's day and passes it as the fee
      // schedule's `asOf`. WHICH day it is belongs to
      // `joining-fee/preview/__tests__/club-time-authority.test.ts`; this suite
      // is about the DOB round-trip, so it only pins that one is supplied.
      expect.objectContaining({ asOf: expect.any(Date) }),
    );
    expect(previewForMember).not.toHaveBeenCalled();
  });

  it("accepts the NZ date-only DOB for an NZ-midnight-stored value (no UTC off-by-one)", async () => {
    // 1990-05-14T12:00:00Z is 1990-05-15 00:00 in Pacific/Auckland: a naive
    // .toISOString().slice(0, 10) would produce 1990-05-14 (the wrong day);
    // the club-time-zone formatter produces the honest NZ date.
    const storedDob = new Date("1990-05-14T12:00:00.000Z");
    const serialised = formatDateOnlyForTimeZone(storedDob, CLUB_ZONE);
    expect(serialised).toBe("1990-05-15");

    const response = await POST(
      makeRequest({ membershipTypeKey: "FULL", dateOfBirth: serialised }),
      routeParams,
    );

    expect(response.status).toBe(200);
    expect(previewForInputs).toHaveBeenCalledWith(
      expect.objectContaining({ dateOfBirth: new Date("1990-05-15T00:00:00.000Z") }),
      expect.objectContaining({ asOf: expect.any(Date) }),
    );
  });

  it("still rejects a full ISO datetime DOB (the schema stays strictly date-only)", async () => {
    const response = await POST(
      makeRequest({
        membershipTypeKey: "FULL",
        dateOfBirth: "1990-05-15T00:00:00.000Z",
      }),
      routeParams,
    );

    expect(response.status).toBe(400);
    expect(previewForInputs).not.toHaveBeenCalled();
    expect(previewForMember).not.toHaveBeenCalled();
  });
});
