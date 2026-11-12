import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The guest finder behind the subject access report (#4915): guest rows hold
 * no email, so a Full Admin finds a non-member guest's exact row by name and
 * stay. Only non-member rows, only Full Admins, only what tells rows apart.
 */

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), guestFindMany: vi.fn() }));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/prisma", () => ({ prisma: { bookingGuest: { findMany: mocks.guestFindMany } } }));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn() } }));

import { GET } from "../route";

function asAdmin(roles: string[]) {
  mocks.requireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "officer-1", accessRoles: roles } } });
}

function get(query: string) {
  return GET(new NextRequest(`https://club.example.com/api/admin/members/subject-access/guests?${query}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  asAdmin(["ADMIN"]);
  mocks.guestFindMany.mockResolvedValue([]);
});

describe("subject access guest finder", () => {
  it("refuses anyone but a Full Admin", async () => {
    asAdmin(["ADMIN_MEMBERSHIP"]);
    expect((await get("name=Ana")).status).toBe(403);
    expect(mocks.guestFindMany).not.toHaveBeenCalled();
  });

  it("asks for a name", async () => {
    expect((await get("name=%20")).status).toBe(400);
  });

  it("searches non-member rows only, every word against first or last name, at most 20", async () => {
    await get("name=Ana%20Smith");
    const args = mocks.guestFindMany.mock.calls[0]![0];
    expect(args.where.memberId).toBeNull();
    expect(args.where.AND).toHaveLength(2);
    expect(args.take).toBe(20);
  });

  it("returns the row id with its name and stay dates, and nothing else", async () => {
    mocks.guestFindMany.mockResolvedValue([{
      id: "g-1", firstName: "Ana", lastName: "Smith",
      stayStart: new Date("2026-08-01T00:00:00.000Z"), stayEnd: new Date("2026-08-03T00:00:00.000Z"),
      booking: { lodge: { name: "Top Hut" }, memberId: null, organisationId: "o-1", member: null,
        organisation: { name: "Valley School" } },
    }]);
    const body = await (await get("name=Ana")).json();
    expect(mocks.guestFindMany.mock.calls[0]![0].select).not.toHaveProperty("booking");
    expect(body).toEqual({ guests: [{
      id: "g-1", name: "Ana Smith", stayStart: "2026-08-01", stayEnd: "2026-08-03",
    }] });
  });
});
