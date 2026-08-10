import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  findMany: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  del: vi.fn(),
  auditLogCreate: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async (options: unknown) =>
    (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock(
      options as never,
    ),
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    otherLodge: {
      findMany: mocks.findMany,
      findUnique: mocks.findUnique,
      create: mocks.create,
      update: mocks.update,
      delete: mocks.del,
    },
    auditLog: { create: mocks.auditLogCreate },
  },
}));

import { GET, POST } from "@/app/api/admin/other-lodges/route";
import { PATCH, DELETE } from "@/app/api/admin/other-lodges/[id]/route";

const adminSession = {
  user: { id: "admin-1", role: "ADMIN", accessRoles: ["ADMIN"] },
};
const memberSession = {
  user: { id: "member-1", role: "USER", accessRoles: ["USER"] },
};

const now = new Date("2026-08-10T10:00:00.000Z");

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: "ol-1",
    name: "Ruapehu Ski Club",
    location: "Whakapapa",
    bookingOfficerName: "Jo Officer",
    bookingOfficerEmail: "jo@example.com",
    bookingOfficerPhone: "021 555 0000",
    bedCapacity: 40,
    active: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function jsonRequest(method: "POST" | "PATCH" | "DELETE", body?: unknown) {
  return new NextRequest("http://localhost/api/admin/other-lodges", {
    method,
    headers: { "content-type": "application/json" },
    body:
      body === undefined
        ? undefined
        : typeof body === "string"
          ? body
          : JSON.stringify(body),
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(adminSession);
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.auditLogCreate.mockResolvedValue(undefined);
});

describe("GET /api/admin/other-lodges", () => {
  it("rejects unauthenticated callers", async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it("rejects non-admin members", async () => {
    mocks.auth.mockResolvedValue(memberSession);
    expect((await GET()).status).toBe(403);
  });

  it("returns serialized other lodges", async () => {
    mocks.findMany.mockResolvedValue([record()]);
    const response = await GET();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.otherLodges).toHaveLength(1);
    expect(data.otherLodges[0]).toMatchObject({
      id: "ol-1",
      name: "Ruapehu Ski Club",
      bedCapacity: 40,
      active: true,
    });
    // Dates are serialized to ISO strings, not Date objects.
    expect(data.otherLodges[0].createdAt).toBe(now.toISOString());
  });
});

describe("POST /api/admin/other-lodges", () => {
  it("returns 400 for malformed JSON", async () => {
    expect((await POST(jsonRequest("POST", "{not json"))).status).toBe(400);
  });

  it("returns 400 for a missing name", async () => {
    expect((await POST(jsonRequest("POST", { name: "" }))).status).toBe(400);
  });

  it("returns 400 for a malformed booking officer email", async () => {
    const response = await POST(
      jsonRequest("POST", { name: "X", bookingOfficerEmail: "not-an-email" }),
    );
    expect(response.status).toBe(400);
  });

  it("creates a lodge, folding blanks to null, and writes an audit log", async () => {
    mocks.create.mockResolvedValue(
      record({ id: "ol-2", name: "Tongariro Lodge", location: null }),
    );
    const response = await POST(
      jsonRequest("POST", {
        name: "  Tongariro Lodge  ",
        location: "   ",
        bookingOfficerEmail: "",
        bedCapacity: 24,
      }),
    );
    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "Tongariro Lodge",
          location: null,
          bookingOfficerEmail: null,
          bedCapacity: 24,
          active: true,
        }),
      }),
    );
    expect(mocks.auditLogCreate).toHaveBeenCalledTimes(1);
  });

  it("returns 409 when the name already exists", async () => {
    mocks.create.mockRejectedValue(uniqueViolation());
    const response = await POST(jsonRequest("POST", { name: "Dup Lodge" }));
    expect(response.status).toBe(409);
    expect(mocks.auditLogCreate).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/admin/other-lodges/[id]", () => {
  it("returns 404 for an unknown lodge", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const response = await PATCH(
      jsonRequest("PATCH", { name: "Renamed" }),
      params("missing"),
    );
    expect(response.status).toBe(404);
  });

  it("updates provided fields and writes an audit log", async () => {
    mocks.findUnique.mockResolvedValue(record());
    mocks.update.mockResolvedValue(record({ name: "Renamed", bedCapacity: 12 }));
    const response = await PATCH(
      jsonRequest("PATCH", { name: "Renamed", bedCapacity: 12 }),
      params("ol-1"),
    );
    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "ol-1" },
        data: expect.objectContaining({ name: "Renamed", bedCapacity: 12 }),
      }),
    );
    expect(mocks.auditLogCreate).toHaveBeenCalledTimes(1);
  });

  it("toggles active without touching other fields", async () => {
    mocks.findUnique.mockResolvedValue(record());
    mocks.update.mockResolvedValue(record({ active: false }));
    const response = await PATCH(
      jsonRequest("PATCH", { active: false }),
      params("ol-1"),
    );
    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { active: false } }),
    );
  });

  it("returns 409 when renaming onto an existing name", async () => {
    mocks.findUnique.mockResolvedValue(record());
    mocks.update.mockRejectedValue(uniqueViolation());
    const response = await PATCH(
      jsonRequest("PATCH", { name: "Taken" }),
      params("ol-1"),
    );
    expect(response.status).toBe(409);
  });
});

describe("DELETE /api/admin/other-lodges/[id]", () => {
  it("returns 404 for an unknown lodge", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const response = await DELETE(jsonRequest("DELETE"), params("missing"));
    expect(response.status).toBe(404);
    expect(mocks.del).not.toHaveBeenCalled();
  });

  it("deletes the lodge and writes an audit log", async () => {
    mocks.findUnique.mockResolvedValue(record());
    mocks.del.mockResolvedValue(record());
    const response = await DELETE(jsonRequest("DELETE"), params("ol-1"));
    expect(response.status).toBe(200);
    expect(mocks.del).toHaveBeenCalledWith({ where: { id: "ol-1" } });
    expect(mocks.auditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "OTHER_LODGE_DELETED",
        }),
      }),
    );
  });

  it("rejects non-admin members", async () => {
    mocks.auth.mockResolvedValue(memberSession);
    const response = await DELETE(jsonRequest("DELETE"), params("ol-1"));
    expect(response.status).toBe(403);
  });
});
