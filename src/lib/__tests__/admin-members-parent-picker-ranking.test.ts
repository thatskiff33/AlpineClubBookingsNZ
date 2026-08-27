// #2425 — the admin "Link Parent" picker, on a surname a whole family shares.
//
// THE BUG THIS PINS. #2282 removed the adults-only clause from the parent-
// candidate search, because a 16 or 17 year old can genuinely be a parent and
// the write route accepts one. The side effect was invisible until a family
// with several children turned up: the picker asks for EIGHT rows ordered by
// lastName then firstName, and the children of the Kingi family — all sharing a
// surname, all sorted before the two adults by first name — filled every slot.
// The adult the admin was looking for was simply not on the page, with nothing
// on screen to say the list had been cut short.
//
// THE FIX IS PRESENTATION ONLY (owner decision, 1 Aug 2026): adults rank first,
// then everyone else, at the same page size. Nobody is filtered out — the
// minors follow the grown-ups, and the second half of this file proves the two
// halves compose into exactly the set a single unranked query would return, in
// the same order within each block, across page boundaries.
//
// The line is drawn at MINOR / NOT MINOR rather than ADULT / NOT ADULT (#2425
// review): `NOT_APPLICABLE` is the age-EXEMPT tier carried by real people on a
// forced or N/A-allowing membership type, and organisations are kept out of this
// search by ROLE, so an N/A row here is a grown-up. Ranking them below the
// household's children would have left the fix unbuilt for exactly the members
// it was written for — Whetu Kingi below.
//
// The fake below deliberately implements only `orderBy`, `skip`, `take` and the
// age clause, and passes every other clause through: eligibility is pinned in
// phase3-admin-members.test.ts, and re-implementing a Prisma predicate here
// would test the fake. That narrowness is what makes the mutation check bite —
// with the ranking reverted to one lastName-first query, the fake returns the
// first eight rows of the whole set and the adults vanish.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgeTier } from "@prisma/client";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
    },
  },
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/age-tier", () => ({
  computeAgeTier: vi.fn(),
  getSeasonStartDate: vi.fn().mockReturnValue(new Date("2026-04-01")),
  getAgeTierSettings: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/xero", () => ({
  getXeroContactGroupMemberships: vi.fn().mockResolvedValue({}),
  getXeroContactIdsForGroup: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/email", () => ({ sendMemberSetupInviteEmail: vi.fn() }));
vi.mock("bcryptjs", () => ({ hash: vi.fn() }));

import { prisma } from "@/lib/prisma";
import {
  adminMembersQuerySchema,
  listAdminMembers,
} from "@/lib/admin-members-service";

interface FakeMember {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
}

/** One family, one surname: nine children and the two adults among them. */
const KINGI_CHILDREN: FakeMember[] = [
  "Ana",
  "Bella",
  "Cameron",
  "Daniel",
  "Eve",
  "Finn",
  "Grace",
  "Hemi",
  "Ivy",
].map((firstName, index) => ({
  id: `kid-${index + 1}`,
  firstName,
  lastName: "Kingi",
  ageTier: (index % 2 === 0 ? "CHILD" : "YOUTH") as AgeTier,
}));

const KINGI_ADULTS: FakeMember[] = [
  { id: "adult-1", firstName: "Wiremu", lastName: "Kingi", ageTier: "ADULT" },
  { id: "adult-2", firstName: "Zara", lastName: "Kingi", ageTier: "ADULT" },
];

/**
 * A grown-up of the household whose current-season membership type is age-exempt
 * (honorary/life), so `resolveEnforcedAgeTier` stores her tier as
 * `NOT_APPLICABLE` — not an organisation, which this search excludes by role.
 * Her first name deliberately sorts AFTER every child's, so an ADULT-only
 * ranking would push her off the eight-row page exactly as #2425 describes.
 */
const KINGI_AGE_EXEMPT: FakeMember[] = [
  {
    id: "exempt-1",
    firstName: "Whetu",
    lastName: "Kingi",
    ageTier: "NOT_APPLICABLE",
  },
];

const ALL_KINGI = [...KINGI_CHILDREN, ...KINGI_ADULTS, ...KINGI_AGE_EXEMPT];

/** The tiers that rank in the top block: everyone who is not a minor. */
const NON_MINOR_TIERS = new Set<AgeTier>(["ADULT", "NOT_APPLICABLE"]);

/** The row shape `listAdminMembers` maps over, with nothing else set. */
function toRow(member: FakeMember) {
  return {
    ...member,
    email: `${member.firstName.toLowerCase()}@kingi.example.org`,
    role: "USER",
    accessRoles: [],
    active: true,
    canLogin: true,
    cancelledAt: null,
    archivedAt: null,
    dateOfBirth: null,
    parentMemberId: null,
    secondaryParentId: null,
    parent: null,
    secondaryParent: null,
    xeroContactId: null,
    passwordChangedAt: null,
    lastLoginAt: null,
    familyGroupMemberships: [],
    subscriptions: [],
    seasonalMembershipAssignments: [],
    passwordResetTokens: [],
  };
}

/**
 * The only clause the fake understands; everything else is passed through.
 *
 * Every age-clause shape Prisma accepts here is served faithfully — the current
 * `in`/`notIn` split and the `ADULT` / `not ADULT` one it replaced — so a
 * mutation back to either fails on the ROWS it returns rather than by confusing
 * the fake. An unrecognised shape throws instead of silently filtering nothing,
 * which would rescue a broken ranking with a green test.
 */
type FakeAgeClause = { include: AgeTier[] } | { exclude: AgeTier[] };

function ageClauseOf(args: any): FakeAgeClause | null {
  const conditions = (args?.where?.AND ?? []) as any[];
  const clause = conditions.find(
    (condition) => condition && typeof condition === "object" && "ageTier" in condition,
  );
  if (!clause) return null;
  const value = clause.ageTier;
  if (typeof value === "string") return { include: [value as AgeTier] };
  if (Array.isArray(value?.in)) return { include: value.in as AgeTier[] };
  if (Array.isArray(value?.notIn)) return { exclude: value.notIn as AgeTier[] };
  if (typeof value?.not === "string") return { exclude: [value.not as AgeTier] };
  throw new Error(`Unsupported ageTier clause: ${JSON.stringify(value)}`);
}

function selectFor(args: any): FakeMember[] {
  const clause = ageClauseOf(args);
  const filtered = ALL_KINGI.filter((member) => {
    if (!clause) return true;
    return "include" in clause
      ? clause.include.includes(member.ageTier)
      : !clause.exclude.includes(member.ageTier);
  });
  // Whatever the caller asked to sort by, honoured generically so a reverted
  // ranking is served faithfully rather than being rescued by the fake.
  const orderBy = Array.isArray(args?.orderBy) ? args.orderBy : [args?.orderBy ?? {}];
  const sorted = [...filtered].sort((left, right) => {
    for (const term of orderBy) {
      const [field, direction] = Object.entries(term ?? {})[0] ?? [];
      if (!field) continue;
      const leftValue = String((left as any)[field] ?? "");
      const rightValue = String((right as any)[field] ?? "");
      if (leftValue === rightValue) continue;
      return (leftValue < rightValue ? -1 : 1) * (direction === "desc" ? -1 : 1);
    }
    return 0;
  });
  const skip = args?.skip ?? 0;
  return args?.take === undefined
    ? sorted.slice(skip)
    : sorted.slice(skip, skip + args.take);
}

function installFakeDatabase() {
  vi.mocked(prisma.member.findUnique).mockResolvedValue({
    parentMemberId: null,
    secondaryParentId: null,
  } as never);
  vi.mocked(prisma.member.findMany).mockImplementation((async (args: any) => {
    // The downward family walk (`describeChildSideDepth`), not a search.
    if (args?.where?.OR?.some?.((clause: any) => clause.parentMemberId?.in)) {
      return [];
    }
    return selectFor(args).map(toRow);
  }) as never);
  vi.mocked(prisma.member.count).mockImplementation((async (args: any) =>
    selectFor(args).length) as never);
}

async function searchParentCandidates(page: number) {
  const query = adminMembersQuerySchema.parse({
    q: "kingi",
    page: String(page),
    pageSize: "8",
    parentLinkEligibleFor: "child-1",
  });
  const result = await listAdminMembers(query);
  const body = result.body as {
    members: Array<{ id: string; ageTier: AgeTier }>;
    total: number;
  };
  return body;
}

describe("#2425 — parent-picker candidate ranking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installFakeDatabase();
  });

  it("reaches the adults on a surname nine children share, without extra typing", async () => {
    const body = await searchParentCandidates(1);

    // Every grown-up of the household is ON the eight-row page. Before the
    // ranking they were rows ten to twelve of an alphabetical list the picker
    // never asked for.
    expect(body.members.map((member) => member.id)).toEqual([
      "exempt-1",
      "adult-1",
      "adult-2",
      "kid-1",
      "kid-2",
      "kid-3",
      "kid-4",
      "kid-5",
    ]);
    // Stated as a property too, so a fixture reshuffle cannot make the list
    // above pass for the wrong reason: no minor precedes a grown-up.
    const firstMinor = body.members.findIndex(
      (member) => !NON_MINOR_TIERS.has(member.ageTier),
    );
    expect(firstMinor).toBeGreaterThan(0);
    expect(
      body.members
        .slice(firstMinor)
        .every((member) => !NON_MINOR_TIERS.has(member.ageTier)),
    ).toBe(true);
  });

  it("ranks an age-exempt member with the adults, never among the children", async () => {
    // #2425 review. `NOT_APPLICABLE` is the age-EXEMPT tier, not the
    // organisation tier — organisations are excluded from this search by ROLE
    // (`dependentParentEligibleWhere`), so a row carrying it here is a real
    // person, typically an adult on an honorary or life membership type. Split
    // on ADULT alone, Whetu sorts after Ivy and falls off the very page this
    // issue exists to fix, which is the pre-#2425 behaviour for that member.
    const body = await searchParentCandidates(1);
    const ids = body.members.map((member) => member.id);

    expect(ids).toContain("exempt-1");
    const lastGrownUp = Math.max(
      ids.indexOf("exempt-1"),
      ids.indexOf("adult-1"),
      ids.indexOf("adult-2"),
    );
    const firstChild = ids.indexOf("kid-1");
    expect(firstChild).toBeGreaterThan(lastGrownUp);
  });

  it("counts the whole eligible set, so the dialog can say the page was cut short", async () => {
    const body = await searchParentCandidates(1);

    // 12 eligible, 8 shown: `total > members.length` is what the dialog turns
    // into "Keep typing to narrow this down." Counting only the adults, or
    // counting the page, would silence the hint exactly when it is needed.
    expect(body.total).toBe(ALL_KINGI.length);
    expect(body.members).toHaveLength(8);
    expect(body.total).toBeGreaterThan(body.members.length);
  });

  it("keeps every candidate reachable across the page boundary — no drops, no repeats", async () => {
    const [first, second] = [
      await searchParentCandidates(1),
      await searchParentCandidates(2),
    ];

    const ids = [...first.members, ...second.members].map((member) => member.id);
    // The ranking is a re-ORDER of the same set, so the two pages together are
    // still everyone: a window that sliced across the adult/non-adult boundary
    // wrongly would show a row twice and lose another.
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ALL_KINGI.map((member) => member.id).sort());
    expect(second.members.map((member) => member.id)).toEqual([
      "kid-6",
      "kid-7",
      "kid-8",
      "kid-9",
    ]);
  });

  it("leaves an ordinary members-list query on one unranked query", async () => {
    // The ranking is scoped to the picker's own parameter. Every other caller of
    // this endpoint — the members table, the exports, the other pickers — still
    // gets exactly the query it got before, in the sort it asked for.
    const query = adminMembersQuerySchema.parse({ q: "kingi", pageSize: "8" });
    const body = (await listAdminMembers(query)).body as {
      members: Array<{ id: string }>;
    };

    expect(vi.mocked(prisma.member.findMany)).toHaveBeenCalledTimes(1);
    expect(body.members.map((member) => member.id)).toEqual(
      KINGI_CHILDREN.slice(0, 8).map((member) => member.id),
    );
  });
});
