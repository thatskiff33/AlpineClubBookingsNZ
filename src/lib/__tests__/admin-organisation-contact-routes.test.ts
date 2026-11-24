/**
 * #5245 — the routes behind the officer's "Edit school details" dialog.
 *
 * The service owns the rules and is proven against real PostgreSQL
 * (`school-organisation-contact-edit.realdb.test.ts`). These own what a service
 * test cannot reach: which officers the path admits, what a caller may send,
 * the mapping from each refusal to a status code, and that Retry only ever
 * replays this school's latest FAILED row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  updateSchoolOrganisationContact: vi.fn(),
  readSchoolOrganisationContact: vi.fn(),
  findLatest: vi.fn(),
  retryXeroSyncOperation: vi.fn(),
  kick: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/organisation-xero-contacts", () => ({ lockOrganisationXeroContact: vi.fn() }));

vi.mock("@/lib/school-organisation-contact-edit", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  updateSchoolOrganisationContact: mocks.updateSchoolOrganisationContact,
  readSchoolOrganisationContact: mocks.readSchoolOrganisationContact,
}));

vi.mock("@/lib/organisation-xero-contact-details", () => ({
  findLatestOrganisationContactDetailsOperation: mocks.findLatest,
}));

vi.mock("@/lib/xero-operation-retry", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  retryXeroSyncOperation: mocks.retryXeroSyncOperation,
}));

vi.mock("@/lib/xero-operation-outbox", () => ({
  kickQueuedXeroOutboxOperationsIfConnected: mocks.kick,
}));

vi.mock("@/lib/club-format-server", () => ({ clubFormatValues: vi.fn(async () => ({})) }));
vi.mock("@/lib/audit", () => ({ logAudit: mocks.logAudit }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { getAdminRouteRequirement } from "@/lib/admin-permissions";
import {
  SCHOOL_CONTACT_CONFLICT_MESSAGE,
  SchoolContactEditError,
} from "@/lib/school-organisation-contact-edit";
import { XeroOperationRetryError } from "@/lib/xero-operation-retry";
import { GET, PATCH } from "@/app/api/admin/organisations/[id]/contact/route";
import { POST as RETRY } from "@/app/api/admin/organisations/[id]/contact/retry/route";

const params = Promise.resolve({ id: "org-1" });
const LOADED = "2026-07-01T00:00:00.000Z";

const adminSession = {
  ok: true as const,
  session: { user: { id: "admin-1", role: "ADMIN" } },
};

function patch(payload: unknown) {
  return new NextRequest("https://example.test/api/admin/organisations/org-1/contact", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

const valid = { email: "bursar@school.example", phone: "07 886 0000", expectedUpdatedAt: LOADED };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue(adminSession);
  mocks.kick.mockResolvedValue(null);
  mocks.updateSchoolOrganisationContact.mockResolvedValue({
    changed: true,
    email: "bursar@school.example",
    phone: "07 886 0000",
    updatedAt: new Date("2026-07-01T00:00:00.001Z"),
    queueOperationId: "op-1",
  });
});

describe("who the school contact routes admit (#5245)", () => {
  it("resolves to the bookings area: view to read, edit to save or retry", () => {
    expect(getAdminRouteRequirement("/api/admin/organisations/org-1/contact", "GET")).toEqual({ area: "bookings", level: "view" });
    expect(getAdminRouteRequirement("/api/admin/organisations/org-1/contact", "PATCH")).toEqual({ area: "bookings", level: "edit" });
    expect(getAdminRouteRequirement("/api/admin/organisations/org-1/contact/retry", "POST")).toEqual({ area: "bookings", level: "edit" });
  });

  it("refuses an officer without bookings edit before the body is read, and saves nothing", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    });

    expect((await PATCH(patch(valid), { params })).status).toBe(403);
    expect((await RETRY(patch({}), { params })).status).toBe(403);
    expect(mocks.updateSchoolOrganisationContact).not.toHaveBeenCalled();
    expect(mocks.retryXeroSyncOperation).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/admin/organisations/[id]/contact (#5245)", () => {
  it("hands the trimmed fields, the loaded version and the officer to the service, then kicks the queue", async () => {
    const response = await PATCH(patch({ ...valid, email: "  bursar@school.example " }), { params });

    expect(response.status).toBe(200);
    expect(mocks.updateSchoolOrganisationContact).toHaveBeenCalledWith({
      organisationId: "org-1",
      email: "bursar@school.example",
      phone: "07 886 0000",
      expectedUpdatedAt: new Date(LOADED),
      actorId: "admin-1",
    });
    expect(mocks.kick).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a malformed email address", { ...valid, email: "not-an-email" }],
    ["a phone number of 31 characters", { ...valid, phone: "0".repeat(31) }],
    ["a phone number with a line break", { ...valid, phone: "07 886\r\n0000" }],
    ["no loaded version", { email: valid.email, phone: valid.phone }],
  ])("refuses %s with 400 and saves nothing", async (_label, payload) => {
    const response = await PATCH(patch(payload), { params });

    expect(response.status).toBe(400);
    expect(mocks.updateSchoolOrganisationContact).not.toHaveBeenCalled();
  });

  it("accepts empty fields, which clear them", async () => {
    await PATCH(patch({ ...valid, email: "", phone: "" }), { params });

    expect(mocks.updateSchoolOrganisationContact).toHaveBeenCalledWith(
      expect.objectContaining({ email: "", phone: "" }),
    );
  });

  it.each([
    [409, SCHOOL_CONTACT_CONFLICT_MESSAGE],
    [404, "School not found."],
  ] as const)("maps the service's %i refusal to the same status", async (status, message) => {
    mocks.updateSchoolOrganisationContact.mockRejectedValue(new SchoolContactEditError(message, status));

    const response = await PATCH(patch(valid), { params });

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: message });
    expect(mocks.kick).not.toHaveBeenCalled();
  });

  it("does not kick the queue when nothing was queued", async () => {
    mocks.updateSchoolOrganisationContact.mockResolvedValue({
      changed: false, email: null, phone: null, updatedAt: new Date(LOADED), queueOperationId: null,
    });

    await PATCH(patch(valid), { params });

    expect(mocks.kick).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/organisations/[id]/contact (#5245)", () => {
  it("returns 404 for a school that is missing or archived", async () => {
    mocks.readSchoolOrganisationContact.mockResolvedValue(null);

    expect((await GET(patch({}), { params })).status).toBe(404);
  });
});

describe("POST /api/admin/organisations/[id]/contact/retry (#5245)", () => {
  it.each([
    ["no contact-details row at all", null],
    ["a latest row that did not fail", { id: "op-2", status: "SUCCEEDED" }],
  ])("refuses with 409 when there is %s", async (_label, latest) => {
    mocks.findLatest.mockResolvedValue(latest);

    const response = await RETRY(patch({}), { params });

    expect(response.status).toBe(409);
    expect(mocks.retryXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("replays the latest FAILED row through the Xero operations retry, audits it and kicks the queue", async () => {
    mocks.findLatest.mockResolvedValue({ id: "op-3", status: "FAILED" });
    mocks.retryXeroSyncOperation.mockResolvedValue({ message: "Queued." });

    const response = await RETRY(patch({}), { params });

    expect(response.status).toBe(202);
    expect(mocks.findLatest).toHaveBeenCalledWith("org-1");
    expect(mocks.retryXeroSyncOperation).toHaveBeenCalledWith("op-3", expect.anything(), { createdByMemberId: "admin-1" });
    expect(mocks.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "XERO_OPERATION_RETRY", entityId: "op-3" }));
    expect(mocks.kick).toHaveBeenCalledTimes(1);
  });

  it("passes on the retry's own refusal and status", async () => {
    mocks.findLatest.mockResolvedValue({ id: "op-3", status: "FAILED" });
    mocks.retryXeroSyncOperation.mockRejectedValue(new XeroOperationRetryError("Already queued.", 409));

    const response = await RETRY(patch({}), { params });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "Already queued." });
  });
});
