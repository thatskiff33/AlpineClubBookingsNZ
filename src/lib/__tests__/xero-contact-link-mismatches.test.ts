import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    xeroSyncCursor: {
      findUnique: vi.fn(),
    },
    member: {
      findMany: vi.fn(),
    },
    xeroContactCache: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: mocks.prisma,
}));

import {
  getXeroContactLinkMismatchSnapshot,
  namesAppearToMatchMemberAndContact,
} from "@/lib/xero-contact-link-mismatches";

describe("xero contact link mismatches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("treats matching names as safe even with case and whitespace differences", () => {
    expect(
      namesAppearToMatchMemberAndContact(
        {
          firstName: " Jane ",
          lastName: "McDonald",
          xeroContactId: "contact_1",
        },
        {
          name: "jane   mcdonald",
          firstName: null,
          lastName: null,
          emailAddress: "jane@example.com",
        }
      )
    ).toBe(true);
  });

  it("treats last-name-first display names as safe matches", () => {
    expect(
      namesAppearToMatchMemberAndContact(
        {
          firstName: "Jane",
          lastName: "McDonald",
          xeroContactId: "contact_1",
        },
        {
          name: "McDonald, Jane",
          firstName: null,
          lastName: null,
          emailAddress: "jane@example.com",
        }
      )
    ).toBe(true);
  });

  it("does not infer a match from freeform display-name tokens", () => {
    expect(
      namesAppearToMatchMemberAndContact(
        {
          firstName: "Jane",
          lastName: "Doe",
          xeroContactId: "contact_1",
        },
        {
          name: "The Doe Family",
          firstName: null,
          lastName: null,
          emailAddress: "family@example.com",
        }
      )
    ).toBe(false);
  });

  it("returns linked member/contact mismatches from cached contacts", async () => {
    mocks.prisma.xeroSyncCursor.findUnique.mockResolvedValue({
      lastSuccessfulSyncAt: new Date("2026-04-28T00:00:00.000Z"),
    });
    mocks.prisma.member.findMany.mockResolvedValue([
      {
        id: "member_1",
        firstName: "Jane",
        lastName: "Doe",
        email: "jane@example.com",
        active: true,
        xeroContactId: "contact_1",
      },
      {
        id: "member_2",
        firstName: "John",
        lastName: "Smith",
        email: "john@example.com",
        active: true,
        xeroContactId: "contact_2",
      },
    ]);
    mocks.prisma.xeroContactCache.findMany.mockResolvedValue([
      {
        contactId: "contact_1",
        name: "John Doe",
        firstName: "John",
        lastName: "Doe",
        emailAddress: "jane@example.com",
      },
      {
        contactId: "contact_2",
        name: "John Smith",
        firstName: "John",
        lastName: "Smith",
        emailAddress: "john@example.com",
      },
    ]);

    const snapshot = await getXeroContactLinkMismatchSnapshot();

    expect(snapshot.cacheReady).toBe(true);
    expect(snapshot.count).toBe(1);
    expect(snapshot.mismatches).toEqual([
      {
        memberId: "member_1",
        memberName: "Jane Doe",
        memberEmail: "jane@example.com",
        active: true,
        xeroContactId: "contact_1",
        xeroContactName: "John Doe",
        xeroContactEmail: "jane@example.com",
        reasons: ["First name differs"],
      },
    ]);
  });
});
