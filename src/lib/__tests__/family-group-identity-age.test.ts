import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The privacy boundary for the Family Group identity-age work (#2568).
 *
 * Three things are pinned here, and each of them is the whole point of the
 * change rather than an implementation detail:
 *
 * 1. Age reaches the browser as a finished, server-calculated label, and the
 *    stored date of birth does NOT — on any of the identity-sensitive payloads.
 * 2. The routine Family Group overview carries neither.
 * 3. Only an administrator with membership permission gets the identity
 *    information; a general administrator with an unrelated role gets nothing,
 *    and the database is not even queried on their behalf.
 */

vi.mock("@/lib/prisma", () => ({
  prisma: {
    familyGroup: { findMany: vi.fn(), findUnique: vi.fn() },
    familyGroupJoinRequest: { findMany: vi.fn() },
    member: { findMany: vi.fn(), count: vi.fn() },
    hiddenFamilySuggestion: { findMany: vi.fn() },
    ageTierSetting: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

const mockRequireActiveSessionUser = vi.fn<() => Promise<Response | null>>(
  async () => null
);
vi.mock("@/lib/session-guards", async () => ({
  requireActiveSessionUser: () => mockRequireActiveSessionUser(),
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
}));

vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/email", () => ({
  sendChildRequestApprovedEmail: vi.fn(),
  sendChildRequestRejectedEmail: vi.fn(),
  sendFamilyGroupInvitationEmail: vi.fn(),
  sendGroupCreateApprovedEmail: vi.fn(),
  sendGroupCreateRejectedEmail: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";

const mockedPrisma = vi.mocked(prisma, true);
const mockedAuth = vi.mocked(auth);

// ADMIN_MEMBERSHIP holds membership:edit; ADMIN_BOOKINGS holds membership:view.
// ADMIN_CONTENT holds no membership permission at all — the "general
// administrator with an unrelated role" the owner specification names.
const membershipManagerSession = {
  user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN_MEMBERSHIP" }] },
} as never;
const membershipViewerSession = {
  user: { id: "admin-2", role: "ADMIN", accessRoles: [{ role: "ADMIN_BOOKINGS" }] },
} as never;
const unrelatedAdminSession = {
  user: { id: "admin-3", role: "ADMIN", accessRoles: [{ role: "ADMIN_CONTENT" }] },
} as never;

/** Every string in a payload, so a leaked date shows up wherever it hides. */
function serialise(value: unknown) {
  return JSON.stringify(value);
}

function expectNoDateOfBirth(payload: unknown) {
  const text = serialise(payload);
  expect(text).not.toContain("dateOfBirth");
  // The fixture birth dates below, in both stored and rendered form.
  expect(text).not.toContain("1974-03-02");
  expect(text).not.toContain("2007-06-15");
  expect(text).not.toContain("2022-10-20");
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireActiveSessionUser.mockResolvedValue(null);
  mockedPrisma.ageTierSetting.findMany.mockResolvedValue([] as never);
});

describe("GET /api/admin/family-groups/member-search (#2568)", () => {
  function searchRequest(query = "?q=smith") {
    return new NextRequest(
      `http://localhost/api/admin/family-groups/member-search${query}`
    );
  }

  const candidateRows = [
    {
      id: "parent-1",
      firstName: "John",
      lastName: "Smith",
      email: "smiths@example.com",
      ageTier: "ADULT",
      active: true,
      canLogin: true,
      dateOfBirth: new Date("1974-03-02T00:00:00.000Z"),
    },
    {
      id: "child-1",
      firstName: "John",
      lastName: "Smith",
      email: "smiths@example.com",
      ageTier: "ADULT",
      active: true,
      canLogin: false,
      dateOfBirth: new Date("2007-06-15T00:00:00.000Z"),
    },
  ];

  it("returns the calculated age, and no date of birth, to a membership viewer", async () => {
    mockedAuth.mockResolvedValue(membershipViewerSession);
    mockedPrisma.member.findMany.mockResolvedValue(candidateRows as never);
    mockedPrisma.member.count.mockResolvedValue(2 as never);

    const { GET } = await import(
      "@/app/api/admin/family-groups/member-search/route"
    );
    const response = await GET(searchRequest());
    expect(response.status).toBe(200);

    const body = await response.json();
    // Two identical names, one age apart — exactly the confusion this fixes.
    expect(body.members).toEqual([
      expect.objectContaining({ id: "parent-1", ageLabel: "52 years" }),
      expect.objectContaining({ id: "child-1", ageLabel: "19 years" }),
    ]);
    expect(body.total).toBe(2);
    expectNoDateOfBirth(body);
  });

  it("carries each candidate's parent links, so a search cannot collapse the notification-email choices", async () => {
    // The members endpoint this lookup replaced returned `parentLinks` on every
    // row, and the child-request "Notification email recipient" select is built
    // from them. Because a searched row OVERWRITES the same candidate id loaded
    // with the request, dropping the links removed the child's real parent from
    // that choice the moment an admin pressed Search.
    mockedAuth.mockResolvedValue(membershipViewerSession);
    mockedPrisma.member.findMany.mockResolvedValue([
      {
        ...candidateRows[1],
        id: "ivy-1",
        firstName: "Ivy",
        ageTier: "CHILD",
        parent: {
          id: "ann-1",
          firstName: "Ann",
          lastName: "Smith",
          email: "ann@example.com",
          ageTier: "ADULT",
          active: true,
          canLogin: true,
          inheritEmailFromId: null,
        },
        secondaryParent: {
          id: "bob-1",
          firstName: "Bob",
          lastName: "Smith",
          email: "bob@no-email.invalid",
          ageTier: "ADULT",
          active: true,
          canLogin: true,
          inheritEmailFromId: null,
        },
      },
    ] as never);
    mockedPrisma.member.count.mockResolvedValue(1 as never);

    const { GET } = await import(
      "@/app/api/admin/family-groups/member-search/route"
    );
    const body = await (await GET(searchRequest())).json();

    expect(body.members[0].parentLinks).toEqual([
      expect.objectContaining({ id: "ann-1", parentLinkType: "PRIMARY" }),
      expect.objectContaining({ id: "bob-1", parentLinkType: "SECONDARY" }),
    ]);
    // A parent option is a name in a dropdown: no parent's birth date is read.
    const select = (
      mockedPrisma.member.findMany.mock.calls[0][0] as {
        select: { parent: { select: Record<string, unknown> } };
      }
    ).select;
    expect(select.parent.select).not.toHaveProperty("dateOfBirth");
    expectNoDateOfBirth(body);
  });

  it("labels a member with no date of birth as unavailable", async () => {
    mockedAuth.mockResolvedValue(membershipViewerSession);
    mockedPrisma.member.findMany.mockResolvedValue([
      { ...candidateRows[0], dateOfBirth: null },
    ] as never);
    mockedPrisma.member.count.mockResolvedValue(1 as never);

    const { GET } = await import(
      "@/app/api/admin/family-groups/member-search/route"
    );
    const body = await (await GET(searchRequest())).json();
    expect(body.members[0].ageLabel).toBe("Age unavailable");
  });

  it("denies a general administrator with an unrelated role, without querying members", async () => {
    mockedAuth.mockResolvedValue(unrelatedAdminSession);

    const { GET } = await import(
      "@/app/api/admin/family-groups/member-search/route"
    );
    const response = await GET(searchRequest());

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mockedPrisma.member.findMany).not.toHaveBeenCalled();
  });

  it("denies an unauthenticated caller", async () => {
    mockedAuth.mockResolvedValue(null as never);

    const { GET } = await import(
      "@/app/api/admin/family-groups/member-search/route"
    );
    expect((await GET(searchRequest())).status).toBe(401);
    expect(mockedPrisma.member.findMany).not.toHaveBeenCalled();
  });

  it("refuses a query shorter than two characters", async () => {
    mockedAuth.mockResolvedValue(membershipViewerSession);

    const { GET } = await import(
      "@/app/api/admin/family-groups/member-search/route"
    );
    const response = await GET(searchRequest("?q=a"));

    expect(response.status).toBe(400);
    expect(mockedPrisma.member.findMany).not.toHaveBeenCalled();
  });

  it("restricts to active, non-archived members and to the requested age tiers", async () => {
    mockedAuth.mockResolvedValue(membershipViewerSession);
    mockedPrisma.member.findMany.mockResolvedValue([] as never);
    mockedPrisma.member.count.mockResolvedValue(0 as never);

    const { GET } = await import(
      "@/app/api/admin/family-groups/member-search/route"
    );
    await GET(searchRequest("?q=smith&ageTierIn=INFANT,CHILD,YOUTH"));

    const args = mockedPrisma.member.findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      take: number;
    };
    expect(args.where.active).toBe(true);
    expect(args.where.archivedAt).toBeNull();
    expect(args.where.ageTier).toEqual({ in: ["INFANT", "CHILD", "YOUTH"] });
    expect(args.take).toBe(10);
  });

  it("refuses an unrecognised age tier rather than widening the search", async () => {
    mockedAuth.mockResolvedValue(membershipViewerSession);

    const { GET } = await import(
      "@/app/api/admin/family-groups/member-search/route"
    );
    const response = await GET(searchRequest("?q=smith&ageTierIn=EVERYONE"));

    expect(response.status).toBe(400);
    expect(mockedPrisma.member.findMany).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/family-groups/[id] — the editor payload (#2568)", () => {
  const groupRow = {
    id: "fg-1",
    name: "Smith Family",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    memberships: [
      {
        member: {
          id: "parent-1",
          firstName: "John",
          lastName: "Smith",
          email: "smiths@example.com",
          ageTier: "ADULT",
          active: true,
          canLogin: true,
          archivedAt: null,
          inheritEmailFromId: null,
          inheritEmailFrom: null,
          passwordHash: "hashed",
          passwordChangedAt: new Date("2026-02-01T00:00:00.000Z"),
          lastLoginAt: new Date("2026-03-01T00:00:00.000Z"),
          dateOfBirth: new Date("1974-03-02T00:00:00.000Z"),
        },
      },
      {
        member: {
          id: "toddler-1",
          firstName: "Ivy",
          lastName: "Smith",
          email: "smiths@example.com",
          ageTier: "INFANT",
          active: true,
          canLogin: false,
          archivedAt: null,
          inheritEmailFromId: "parent-1",
          inheritEmailFrom: { email: "smiths@example.com" },
          passwordHash: null,
          passwordChangedAt: null,
          lastLoginAt: null,
          dateOfBirth: new Date("2022-10-20T00:00:00.000Z"),
        },
      },
    ],
    joinRequests: [],
  };

  it("carries an age per member, in years for an adult and months for a toddler", async () => {
    mockedAuth.mockResolvedValue(membershipManagerSession);
    mockedPrisma.familyGroup.findUnique.mockResolvedValue(groupRow as never);

    const { GET } = await import("@/app/api/admin/family-groups/[id]/route");
    const response = await GET(
      new NextRequest("http://localhost/api/admin/family-groups/fg-1"),
      { params: Promise.resolve({ id: "fg-1" }) }
    );
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.members).toEqual([
      expect.objectContaining({ id: "parent-1", ageLabel: "52 years" }),
      expect.objectContaining({ id: "toddler-1", ageLabel: "3 years 8 months" }),
    ]);
    // The WHOLE body, not just the sanitised `members` array. Scoping this to
    // `body.members` is what let a `...group` spread re-export the raw
    // `memberships` relation — dates of birth and password hashes included —
    // beside the array the map had carefully cleaned.
    expectNoDateOfBirth(body);
  });

  it("returns only the four keys the editor reads, and no raw membership rows", async () => {
    mockedAuth.mockResolvedValue(membershipManagerSession);
    mockedPrisma.familyGroup.findUnique.mockResolvedValue(groupRow as never);

    const { GET } = await import("@/app/api/admin/family-groups/[id]/route");
    const body = await (
      await GET(new NextRequest("http://localhost/api/admin/family-groups/fg-1"), {
        params: Promise.resolve({ id: "fg-1" }),
      })
    ).json();

    expect(Object.keys(body).sort()).toEqual(["createdAt", "id", "members", "name"]);
    // No second, unsanitised copy of the same people under another key.
    expect(body).not.toHaveProperty("memberships");
    // Credential columns are read to derive `hasPassword` and never forwarded —
    // anywhere in the payload, under any key.
    const text = serialise(body);
    expect(text).not.toContain("passwordHash");
    expect(text).not.toContain("passwordChangedAt");
    expect(text).not.toContain("lastLoginAt");
    expect(text).not.toContain("hashed");
    expect(body.members[0].hasPassword).toBe(true);
    expect(body.members[1].hasPassword).toBe(false);
  });

  it("denies a general administrator with an unrelated role", async () => {
    mockedAuth.mockResolvedValue(unrelatedAdminSession);

    const { GET } = await import("@/app/api/admin/family-groups/[id]/route");
    const response = await GET(
      new NextRequest("http://localhost/api/admin/family-groups/fg-1"),
      { params: Promise.resolve({ id: "fg-1" }) }
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mockedPrisma.familyGroup.findUnique).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/family-groups — the ROUTINE overview (#2568)", () => {
  it("carries neither an age nor a date of birth", async () => {
    mockedAuth.mockResolvedValue(membershipManagerSession);
    mockedPrisma.familyGroup.findMany.mockResolvedValue([
      {
        id: "fg-1",
        name: "Smith Family",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        memberships: [
          {
            member: {
              id: "parent-1",
              firstName: "John",
              lastName: "Smith",
              email: "smiths@example.com",
              ageTier: "ADULT",
              active: true,
              canLogin: true,
              archivedAt: null,
            },
          },
        ],
        _count: { joinRequests: 0 },
      },
    ] as never);

    const { GET } = await import("@/app/api/admin/family-groups/route");
    const body = await (await GET()).json();

    expect(body.familyGroups[0].members).toHaveLength(1);
    expect(serialise(body)).not.toContain("ageLabel");
    expect(serialise(body)).not.toContain("dateOfBirth");
  });
});

describe("listAdminFamilyGroupRequests — the review queue payload (#2568)", () => {
  const childRequestRow = {
    id: "req-1",
    type: "CHILD_REQUEST",
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    familyGroupId: "fg-1",
    childFirstName: "Ivy",
    childLastName: "Smith",
    childDateOfBirth: new Date("2022-10-20T00:00:00.000Z"),
    requestedFirstName: null,
    requestedLastName: null,
    requestedDateOfBirth: null,
    requestedEmail: null,
    requester: {
      id: "parent-1",
      firstName: "John",
      lastName: "Smith",
      email: "smiths@example.com",
      dateOfBirth: new Date("1974-03-02T00:00:00.000Z"),
    },
    subjectMember: null,
    invitedMember: null,
    familyGroup: {
      id: "fg-1",
      name: "Smith Family",
      memberships: [
        {
          member: {
            id: "parent-1",
            firstName: "John",
            lastName: "Smith",
            email: "smiths@example.com",
            ageTier: "ADULT",
          },
        },
      ],
    },
  };

  it("gives the requester, the declared child, and every suggested match an age", async () => {
    mockedPrisma.familyGroupJoinRequest.findMany.mockResolvedValue([
      childRequestRow,
    ] as never);
    mockedPrisma.member.findMany.mockResolvedValue([
      {
        id: "candidate-1",
        firstName: "Ivy",
        lastName: "Smith",
        email: "smiths@example.com",
        ageTier: "INFANT",
        active: true,
        canLogin: false,
        parentMemberId: null,
        secondaryParentId: null,
        inheritEmailFromId: null,
        parent: null,
        secondaryParent: null,
        dateOfBirth: new Date("2022-10-20T00:00:00.000Z"),
        familyGroupMemberships: [],
        partnerLinksAsMemberA: [],
        partnerLinksAsMemberB: [],
      },
    ] as never);

    const { listAdminFamilyGroupRequests } = await import(
      "@/lib/admin-family-group-requests-service"
    );
    const result = (await listAdminFamilyGroupRequests()).body as {
      requests: Array<Record<string, unknown>>;
    };
    const request = result.requests[0];

    expect(request.childAgeLabel).toBe("3 years 8 months");
    expect(request.requestedAgeLabel).toBeNull();
    expect(request.requester).toEqual(
      expect.objectContaining({ id: "parent-1", ageLabel: "52 years" })
    );
    expect(request.matchingMembers).toEqual([
      expect.objectContaining({
        id: "candidate-1",
        ageLabel: "3 years 8 months",
      }),
    ]);

    // No member record's stored birth date on the payload. The DECLARED
    // childDateOfBirth stays (the card has always shown it, and it is what the
    // admin checks a candidate against) — so it is excluded from this sweep.
    const withoutDeclared = { ...request };
    delete withoutDeclared.childDateOfBirth;
    expectNoDateOfBirth(withoutDeclared);

    // The group's own roster is a routine list, so it gets no age.
    expect(serialise(request.familyGroup)).not.toContain("ageLabel");
  });

  it("gives the member being REMOVED an age on a removal request", async () => {
    mockedPrisma.familyGroupJoinRequest.findMany.mockResolvedValue([
      {
        ...childRequestRow,
        id: "req-2",
        type: "REMOVAL_REQUEST",
        childDateOfBirth: null,
        subjectMember: {
          id: "child-1",
          firstName: "John",
          lastName: "Smith",
          email: "smiths@example.com",
          ageTier: "ADULT",
          active: true,
          dateOfBirth: new Date("2007-06-15T00:00:00.000Z"),
        },
      },
    ] as never);
    mockedPrisma.member.findMany.mockResolvedValue([] as never);

    const { listAdminFamilyGroupRequests } = await import(
      "@/lib/admin-family-group-requests-service"
    );
    const result = (await listAdminFamilyGroupRequests()).body as {
      requests: Array<Record<string, unknown>>;
    };

    expect(result.requests[0].subjectMember).toEqual(
      expect.objectContaining({ id: "child-1", ageLabel: "19 years" })
    );
    expect(result.requests[0].childAgeLabel).toBeNull();
    expectNoDateOfBirth(result.requests[0]);
  });

  it("gives the partner a GROUP_CREATE approval would invite an age", async () => {
    mockedPrisma.familyGroupJoinRequest.findMany.mockResolvedValue([
      {
        ...childRequestRow,
        id: "req-3",
        type: "GROUP_CREATE",
        childDateOfBirth: null,
        invitedMember: {
          id: "partner-1",
          firstName: "Ada",
          lastName: "Smith",
          email: "ada@example.com",
          ageTier: "ADULT",
          active: true,
          dateOfBirth: new Date("1974-03-02T00:00:00.000Z"),
        },
      },
    ] as never);
    mockedPrisma.member.findMany.mockResolvedValue([] as never);

    const { listAdminFamilyGroupRequests } = await import(
      "@/lib/admin-family-group-requests-service"
    );
    const result = (await listAdminFamilyGroupRequests()).body as {
      requests: Array<Record<string, unknown>>;
    };

    expect(result.requests[0].invitedMember).toEqual(
      expect.objectContaining({ id: "partner-1", ageLabel: "52 years" })
    );
    expectNoDateOfBirth(result.requests[0]);
  });

  it("gives an adult request's declared adult an age", async () => {
    mockedPrisma.familyGroupJoinRequest.findMany.mockResolvedValue([
      {
        ...childRequestRow,
        id: "req-4",
        type: "ADULT_REQUEST",
        childFirstName: null,
        childLastName: null,
        childDateOfBirth: null,
        requestedFirstName: "Ada",
        requestedLastName: "Smith",
        requestedDateOfBirth: new Date("2007-06-15T00:00:00.000Z"),
        requestedEmail: "smiths@example.com",
      },
    ] as never);
    mockedPrisma.member.findMany.mockResolvedValue([] as never);

    const { listAdminFamilyGroupRequests } = await import(
      "@/lib/admin-family-group-requests-service"
    );
    const result = (await listAdminFamilyGroupRequests()).body as {
      requests: Array<Record<string, unknown>>;
    };

    expect(result.requests[0].requestedAgeLabel).toBe("19 years");
    expect(result.requests[0].childAgeLabel).toBeNull();
  });
});

describe("suggestFamilyGroups — duplicate prevention (#2568)", () => {
  it("gives every suggested member an age and no date of birth", async () => {
    mockedPrisma.member.findMany.mockResolvedValue([
      {
        id: "parent-1",
        firstName: "John",
        lastName: "Smith",
        email: "smiths@example.com",
        ageTier: "ADULT",
        canLogin: true,
        xeroContactId: null,
        dateOfBirth: new Date("1974-03-02T00:00:00.000Z"),
        familyGroupMemberships: [],
      },
      {
        id: "child-1",
        firstName: "John",
        lastName: "Smith",
        email: "smiths@example.com",
        ageTier: "ADULT",
        canLogin: false,
        xeroContactId: null,
        dateOfBirth: new Date("2007-06-15T00:00:00.000Z"),
        familyGroupMemberships: [],
      },
    ] as never);
    mockedPrisma.hiddenFamilySuggestion.findMany.mockResolvedValue([] as never);

    const { suggestFamilyGroups } = await import("@/lib/family-suggestions");
    const result = await suggestFamilyGroups();

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].members).toEqual([
      expect.objectContaining({ id: "parent-1", ageLabel: "52 years" }),
      expect.objectContaining({ id: "child-1", ageLabel: "19 years" }),
    ]);
    expectNoDateOfBirth(result.suggestions);
  });
});
