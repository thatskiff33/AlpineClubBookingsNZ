/**
 * #2936 — the two routes behind the officer's correction form.
 *
 * The service owns every rule, so these tests own the three things a service
 * test cannot reach and a component test cannot either: the schema that decides
 * what a caller may even send, the mapping from each refusal to a status code,
 * and the committed-error branch — the one that has to tell the panel "this
 * SAVED" so the officer releases a hold instead of re-typing the whole form.
 *
 * The test matrix claims route coverage for this surface, and until this file
 * existed that claim was not true.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { BookingRequestType } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  correctBookingRequest: vi.fn(),
  requestFindUnique: vi.fn(),
  previewSchoolRecordForName: vi.fn(),
  serializeBookingRequestForAdmin: vi.fn(() => ({ id: "req-1" })),
  getClientIp: vi.fn(() => "203.0.113.9"),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));

vi.mock("@/lib/prisma", () => ({
  prisma: { bookingRequest: { findUnique: mocks.requestFindUnique } },
}));

vi.mock("@/lib/booking-request-corrections", () => ({
  correctBookingRequest: mocks.correctBookingRequest,
}));

vi.mock("@/lib/booking-request", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/booking-request");
  return {
    ...actual,
    serializeBookingRequestForAdmin: mocks.serializeBookingRequestForAdmin,
  };
});

vi.mock("@/lib/school-organisation-preview", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("@/lib/school-organisation-preview");
  return {
    ...actual,
    previewSchoolRecordForName: mocks.previewSchoolRecordForName,
  };
});

vi.mock("@/lib/rate-limit", () => ({ getClientIp: mocks.getClientIp }));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { BookingRequestError } from "@/lib/booking-request";
import { BookingRequestCorrectionCommittedError } from "@/lib/booking-request-correction-hold";
import {
  EmptySchoolNameError,
  SchoolRecordAcknowledgementError,
} from "@/lib/school-organisation-preview";
import { POST } from "@/app/api/admin/booking-requests/[id]/correct/route";
import { GET } from "@/app/api/admin/booking-requests/[id]/school-record/route";

const params = Promise.resolve({ id: "req-1" });

const adminSession = {
  ok: true as const,
  session: { user: { id: "admin-1", role: "ADMIN" } },
};

/** A complete, valid correction body for a SCHOOL request. */
function body(overrides: Record<string, unknown> = {}) {
  return {
    expectedVersion: 4,
    reason: "The school rang about the dates.",
    checkIn: "2026-08-17",
    checkOut: "2026-08-19",
    contactFirstName: "Ann",
    contactLastName: "Baker",
    contactEmail: "ann@example.test",
    contactPhone: "0211111111",
    school: {
      schoolName: "Tokoroa Primary School",
      teachers: [
        { firstName: "Ann", lastName: "Baker", email: "ann@example.test" },
      ],
      childCounts: { CHILD: 3 },
      cateringPreference: "QUOTE_BOTH",
      schoolRecord: { outcome: "existing", schoolRecordId: "org-7" },
    },
    ...overrides,
  };
}

function post(payload: unknown) {
  return new NextRequest(
    "https://example.test/api/admin/booking-requests/req-1/correct",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

const successResult = {
  changedFields: ["checkIn"],
  holdOutcome: "none" as const,
  supersededQuoteCount: 0,
  clearedMemberLinkCount: 0,
  schoolRecord: null,
  availability: { available: true, fullNights: [] },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue(adminSession);
  mocks.correctBookingRequest.mockResolvedValue(successResult);
  mocks.requestFindUnique.mockResolvedValue({ id: "req-1" });
  mocks.serializeBookingRequestForAdmin.mockReturnValue({ id: "req-1" });
});

describe("POST /api/admin/booking-requests/[id]/correct", () => {
  it("enforces requireAdmin before anything is parsed", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });
    const res = await POST(post(body()), { params });
    expect(res.status).toBe(401);
    expect(mocks.correctBookingRequest).not.toHaveBeenCalled();
  });

  it("passes the parsed correction, the actor and the caller's IP to the service", async () => {
    const res = await POST(post(body()), { params });
    expect(res.status).toBe(200);
    const input = mocks.correctBookingRequest.mock.calls[0][0];
    expect(input.requestId).toBe("req-1");
    expect(input.adminMemberId).toBe("admin-1");
    expect(input.ipAddress).toBe("203.0.113.9");
    // The date-only strings are parsed to the lodge-night instants the service
    // compares against, not handed on as text.
    expect(input.checkIn).toBeInstanceOf(Date);
    expect(input.checkIn.toISOString()).toBe("2026-08-17T00:00:00.000Z");
    expect(input.school.schoolRecord).toEqual({
      outcome: "existing",
      schoolRecordId: "org-7",
    });
  });

  it("reports what the correction did, including the links it cleared", async () => {
    mocks.correctBookingRequest.mockResolvedValue({
      ...successResult,
      changedFields: ["guests"],
      clearedMemberLinkCount: 2,
      supersededQuoteCount: 1,
      holdOutcome: "released" as const,
    });
    const res = await POST(post(body()), { params });
    await expect(res.json()).resolves.toMatchObject({
      changedFields: ["guests"],
      clearedMemberLinkCount: 2,
      supersededQuoteCount: 1,
      holdOutcome: "released",
    });
  });

  describe("the schema is the first fence", () => {
    it("refuses a body that is not JSON at all", async () => {
      const req = new NextRequest(
        "https://example.test/api/admin/booking-requests/req-1/correct",
        { method: "POST", body: "not json" },
      );
      const res = await POST(req, { params });
      expect(res.status).toBe(400);
      expect(mocks.correctBookingRequest).not.toHaveBeenCalled();
    });

    it.each([
      ["a missing reason", { reason: "" }],
      ["a reason carrying line breaks", { reason: "one\ntwo" }],
      ["a date that is not a lodge night", { checkIn: "17/08/2026" }],
      ["a contact address that is not one", { contactEmail: "not-an-email" }],
      ["no expected version at all", { expectedVersion: undefined }],
    ])("refuses %s", async (_label, override) => {
      const res = await POST(post(body(override)), { params });
      expect(res.status).toBe(422);
      expect(mocks.correctBookingRequest).not.toHaveBeenCalled();
    });

    it("refuses a school half with no teacher in it", async () => {
      const res = await POST(
        post(body({ school: { ...body().school, teachers: [] } })),
        { params },
      );
      expect(res.status).toBe(422);
      expect(mocks.correctBookingRequest).not.toHaveBeenCalled();
    });

    it("refuses an acknowledgement outcome it does not recognise", async () => {
      // The acknowledgement is what stands between a corrected name and another
      // school's Xero customer, so an unrecognised one is refused here rather
      // than normalised into something the service would accept.
      const res = await POST(
        post(
          body({
            school: { ...body().school, schoolRecord: { outcome: "maybe" } },
          }),
        ),
        { params },
      );
      expect(res.status).toBe(422);
      expect(mocks.correctBookingRequest).not.toHaveBeenCalled();
    });
  });

  describe("each refusal keeps its own status code", () => {
    it.each([
      [new BookingRequestError("no longer open", 409), 409],
      [new BookingRequestError("needs a guest", 422), 422],
      [new SchoolRecordAcknowledgementError("confirm it first"), 409],
      [new EmptySchoolNameError(), 422],
    ])("maps %s", async (error, status) => {
      mocks.correctBookingRequest.mockRejectedValue(error);
      const res = await POST(post(body()), { params });
      expect(res.status).toBe(status);
      await expect(res.json()).resolves.toHaveProperty("error");
    });

    it("lets an unrecognised failure through rather than dressing it as a refusal", async () => {
      mocks.correctBookingRequest.mockRejectedValue(new Error("boom"));
      await expect(POST(post(body()), { params })).rejects.toThrow("boom");
    });
  });

  describe("a correction that SAVED but could not finish", () => {
    it("says so, so the officer releases a hold instead of re-typing the form", async () => {
      // The whole point of the separate shape: a retry would refuse on the
      // bumped version anyway, so inviting one is the confusion this surface
      // exists to remove.
      mocks.correctBookingRequest.mockRejectedValue(
        new BookingRequestCorrectionCommittedError(
          "The correction was saved, but this request's held beds could not be released.",
          500,
          true,
        ),
      );
      const res = await POST(post(body()), { params });
      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toMatchObject({
        corrected: true,
        holdReleasePending: true,
      });
    });

    it("still says so when the failure was the hosting participant fence", async () => {
      // The fence is a RETRY signal with its own response body, and the
      // correction is committed underneath it. Both facts have to reach the
      // panel, which is why the committed fields ride along with the retry.
      const fence = Object.assign(new Error("participants moved"), {
        code: "HOSTING_COVERAGE_PARTICIPANTS_CHANGED",
      });
      mocks.correctBookingRequest.mockRejectedValue(
        new BookingRequestCorrectionCommittedError(
          "The correction was saved, but its held beds could not be confirmed.",
          409,
          true,
          { cause: fence },
        ),
      );
      const res = await POST(post(body()), { params });
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({
        corrected: true,
        holdReleasePending: true,
      });
    });
  });

  it("reports a row it cannot read back rather than returning half an answer", async () => {
    mocks.requestFindUnique.mockResolvedValue(null);
    const res = await POST(post(body()), { params });
    expect(res.status).toBe(500);
  });
});

describe("GET /api/admin/booking-requests/[id]/school-record", () => {
  function get(query = "?name=Tokoroa%20Primary%20School") {
    return new NextRequest(
      `https://example.test/api/admin/booking-requests/req-1/school-record${query}`,
    );
  }

  beforeEach(() => {
    mocks.requestFindUnique.mockResolvedValue({
      id: "req-1",
      type: BookingRequestType.SCHOOL,
      schoolName: "Tokora Primary School",
    });
    mocks.previewSchoolRecordForName.mockResolvedValue({
      normalisedName: "Tokoroa Primary School",
      known: true,
      schoolRecordId: "org-7",
      schoolRecordName: "Tokoroa Primary School",
      schoolRecordArchived: false,
      schoolRecordHasXeroCustomer: true,
      currentContactNames: ["Bill Carter"],
      currentContactNamesTruncated: false,
    });
  });

  it("enforces requireAdmin", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });
    const res = await GET(get(), { params });
    expect(res.status).toBe(401);
    expect(mocks.previewSchoolRecordForName).not.toHaveBeenCalled();
  });

  it("answers for the typed name", async () => {
    const res = await GET(get(), { params });
    expect(res.status).toBe(200);
    expect(mocks.previewSchoolRecordForName).toHaveBeenCalledWith(
      expect.anything(),
      "Tokoroa Primary School",
    );
    await expect(res.json()).resolves.toMatchObject({
      schoolRecord: { known: true, schoolRecordId: "org-7" },
    });
  });

  it("falls back to the name already on the request, so the form opens answered", async () => {
    await GET(get(""), { params });
    expect(mocks.previewSchoolRecordForName).toHaveBeenCalledWith(
      expect.anything(),
      "Tokora Primary School",
    );
  });

  it("refuses a request that is not a school request", async () => {
    mocks.requestFindUnique.mockResolvedValue({
      id: "req-1",
      type: BookingRequestType.GENERAL,
      schoolName: null,
    });
    const res = await GET(get(), { params });
    expect(res.status).toBe(409);
    expect(mocks.previewSchoolRecordForName).not.toHaveBeenCalled();
  });

  it("reports a request that does not exist", async () => {
    mocks.requestFindUnique.mockResolvedValue(null);
    const res = await GET(get(), { params });
    expect(res.status).toBe(404);
  });

  it("reports a name that is nothing once normalised", async () => {
    mocks.previewSchoolRecordForName.mockRejectedValue(new EmptySchoolNameError());
    const res = await GET(get("?name=%20%20"), { params });
    expect(res.status).toBe(422);
  });
});
