/**
 * #3407 review: the group-discount policy's minimum-size check measures the
 * club's DEFAULT lodge, because the policy has no lodge of its own. At a default
 * lodge with no capacity the officer is told that the DEFAULT lodge is not set
 * up, never "this lodge" — they are editing a club-wide policy, not a lodge.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getDefaultLodgeCapacity: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/lodge-capacity", () => ({
  getDefaultLodgeCapacity: mocks.getDefaultLodgeCapacity,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    membershipType: { findFirst: vi.fn(async () => ({ id: "type-full" })) },
    groupDiscountSetting: {
      findUnique: vi.fn(async () => null),
      upsert: mocks.upsert,
    },
  },
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/public-content-revalidation", () => ({
  revalidatePublicPageContent: vi.fn(),
}));

import { PUT } from "@/app/api/admin/booking-policies/group-discount/route";
import {
  DEFAULT_LODGE_NOT_SET_UP_FOR_BOOKINGS_MESSAGE,
  LODGE_NOT_SET_UP_FOR_BOOKINGS_MESSAGE,
} from "@/lib/lodge-booking-readiness";

function put(minGroupSize: number) {
  return PUT(
    new NextRequest("http://localhost/api/admin/booking-policies/group-discount", {
      method: "PUT",
      body: JSON.stringify({ minGroupSize, summerOnly: false, enabled: true }),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1" } },
  });
});

describe("PUT group-discount — the minimum size against the default lodge (#3407)", () => {
  it("names the DEFAULT lodge, not 'this lodge', when it has no capacity", async () => {
    mocks.getDefaultLodgeCapacity.mockResolvedValue(0);

    const res = await put(4);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe(DEFAULT_LODGE_NOT_SET_UP_FOR_BOOKINGS_MESSAGE);
    expect(body.error).not.toBe(LODGE_NOT_SET_UP_FOR_BOOKINGS_MESSAGE);
    expect(body.error).not.toMatch(/this lodge/i);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("CONTROL: a configured default lodge keeps its limit wording", async () => {
    mocks.getDefaultLodgeCapacity.mockResolvedValue(10);

    const res = await put(20);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      "Minimum group size cannot exceed lodge capacity (10).",
    );
  });
});
