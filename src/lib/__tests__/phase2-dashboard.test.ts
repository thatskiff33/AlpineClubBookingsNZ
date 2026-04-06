import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { PUT as putNotes } from "@/app/api/bookings/[id]/notes/route";

const mockedAuth = vi.mocked(auth);
const mockedBooking = vi.mocked(prisma.booking);

function makeRequest(id: string, body: unknown) {
  return new NextRequest(`http://localhost/api/bookings/${id}/notes`, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("PUT /api/bookings/[id]/notes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 for unauthenticated requests", async () => {
    mockedAuth.mockResolvedValue(null as never);
    const res = await putNotes(makeRequest("b1", { notes: "hi" }), makeParams("b1"));
    expect(res.status).toBe(401);
  });

  it("returns 404 for non-existent booking", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as never);
    mockedBooking.findUnique.mockResolvedValue(null as never);
    const res = await putNotes(makeRequest("b1", { notes: "hi" }), makeParams("b1"));
    expect(res.status).toBe(404);
  });

  it("returns 403 when non-owner non-admin tries to edit", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m2", role: "MEMBER" } } as never);
    mockedBooking.findUnique.mockResolvedValue({ memberId: "m1", status: "CONFIRMED" } as never);
    const res = await putNotes(makeRequest("b1", { notes: "hi" }), makeParams("b1"));
    expect(res.status).toBe(403);
  });

  it("returns 400 for CANCELLED bookings", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as never);
    mockedBooking.findUnique.mockResolvedValue({ memberId: "m1", status: "CANCELLED" } as never);
    const res = await putNotes(makeRequest("b1", { notes: "hi" }), makeParams("b1"));
    expect(res.status).toBe(400);
  });

  it("returns 400 when notes exceed 500 chars", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as never);
    mockedBooking.findUnique.mockResolvedValue({ memberId: "m1", status: "CONFIRMED" } as never);
    const res = await putNotes(makeRequest("b1", { notes: "a".repeat(501) }), makeParams("b1"));
    expect(res.status).toBe(400);
  });

  it("strips HTML tags from notes", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as never);
    mockedBooking.findUnique.mockResolvedValue({ memberId: "m1", status: "CONFIRMED" } as never);
    mockedBooking.update.mockResolvedValue({ id: "b1", notes: "hello world" } as never);
    const res = await putNotes(makeRequest("b1", { notes: "<b>hello</b> <script>alert(1)</script>world" }), makeParams("b1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.notes).toBe("hello world");
  });

  it("successfully updates notes for booking owner", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as never);
    mockedBooking.findUnique.mockResolvedValue({ memberId: "m1", status: "CONFIRMED" } as never);
    mockedBooking.update.mockResolvedValue({ id: "b1", notes: "Test note" } as never);
    const res = await putNotes(makeRequest("b1", { notes: "Test note" }), makeParams("b1"));
    expect(res.status).toBe(200);
    expect(mockedBooking.update).toHaveBeenCalledWith({
      where: { id: "b1" },
      data: { notes: "Test note" },
      select: { id: true, notes: true },
    });
  });

  it("allows admin to edit any booking notes", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN" } } as never);
    mockedBooking.findUnique.mockResolvedValue({ memberId: "m1", status: "PENDING" } as never);
    mockedBooking.update.mockResolvedValue({ id: "b1", notes: "Admin note" } as never);
    const res = await putNotes(makeRequest("b1", { notes: "Admin note" }), makeParams("b1"));
    expect(res.status).toBe(200);
  });

  it("sets notes to null when empty string provided", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as never);
    mockedBooking.findUnique.mockResolvedValue({ memberId: "m1", status: "CONFIRMED" } as never);
    mockedBooking.update.mockResolvedValue({ id: "b1", notes: null } as never);
    const res = await putNotes(makeRequest("b1", { notes: "" }), makeParams("b1"));
    expect(res.status).toBe(200);
    expect(mockedBooking.update).toHaveBeenCalledWith({
      where: { id: "b1" },
      data: { notes: null },
      select: { id: true, notes: true },
    });
  });

  it("returns 400 for invalid JSON", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as never);
    mockedBooking.findUnique.mockResolvedValue({ memberId: "m1", status: "CONFIRMED" } as never);
    const req = new NextRequest("http://localhost/api/bookings/b1/notes", {
      method: "PUT",
      body: "not json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await putNotes(req, makeParams("b1"));
    expect(res.status).toBe(400);
  });
});
