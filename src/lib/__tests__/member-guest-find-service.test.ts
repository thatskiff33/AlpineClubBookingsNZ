import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: { member: { findMany } },
}));

import {
  resolveMemberGuestCandidatesByEmail,
  searchMemberGuestCandidatesByName,
} from "@/lib/member-guest-find-service";
import { notDeletedAccountWhere } from "@/lib/deleted-account";

const SETTINGS = {
  approvalRequired: false,
  pendingHoldExpiryDays: 7,
  openMemberSearchEnabled: true,
  openMemberSearchIncludesMinors: false,
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "member-1",
    firstName: "Ada",
    lastName: "Example",
    ageTier: "ADULT",
    email: "ada@example.test",
    deletedAt: null,
    ...overrides,
  };
}

describe("member guest lookup excludes erased accounts (#3542)", () => {
  beforeEach(() => {
    findMany.mockReset();
  });

  it("does not resolve an adopter-era erased row by its reserved address", async () => {
    findMany.mockResolvedValue([
      row({
        id: "legacy-erased",
        email: "deleted-legacy@deleted.invalid",
        deletedAt: null,
      }),
    ]);

    await expect(
      resolveMemberGuestCandidatesByEmail({
        email: "deleted-legacy@deleted.invalid",
      }),
    ).resolves.toEqual({ candidates: [] });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ email: true, deletedAt: true }),
      }),
    );
  });

  it("does not return either structural or adopter-era erased rows by name", async () => {
    findMany.mockResolvedValue([
      row(),
      row({
        id: "legacy-erased",
        email: "deleted-legacy@deleted.invalid",
      }),
      row({
        id: "structurally-erased",
        email: "other@example.test",
        deletedAt: new Date("2026-07-01T00:00:00.000Z"),
      }),
    ]);

    await expect(
      searchMemberGuestCandidatesByName({ q: "ad", settings: SETTINGS }),
    ).resolves.toEqual({
      candidates: [
        {
          memberId: "member-1",
          firstName: "Ada",
          lastName: "Example",
          ageTier: "ADULT",
        },
      ],
      truncated: false,
    });
  });

  it("keeps the deletion prefilter when a two-token name adds its own AND", async () => {
    findMany.mockResolvedValue([]);

    await searchMemberGuestCandidatesByName({
      q: "ada example",
      settings: SETTINGS,
    });

    const where = findMany.mock.calls[0]?.[0]?.where;
    expect(where.AND).toEqual([
      ...notDeletedAccountWhere(),
      {
        AND: [
          {
            firstName: {
              startsWith: "ada",
              mode: "insensitive",
            },
          },
          {
            lastName: {
              startsWith: "example",
              mode: "insensitive",
            },
          },
        ],
      },
    ]);
  });
});
