import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { PrismaClient, type Prisma } from "@prisma/client";
import {
  DEPENDENT_LINK_INELIGIBILITY_ERRORS,
  DEPENDENT_LINK_INELIGIBILITY_EXPLANATIONS,
  DEPENDENT_LINK_INELIGIBILITY_REASONS,
  DEPENDENT_PARENT_BLOCK_EXPLANATIONS,
  DEPENDENT_PARENT_CREATE_ERRORS,
  DEPENDENT_PARENT_LINK_ERRORS,
  DEPENDENT_PARENT_STATE_REASONS,
  dependentLinkBlockers,
  dependentLinkCandidateWhere,
  dependentParentEligibleWhere,
  dependentParentStateBlocker,
  type DependentLinkCandidate,
  type DependentLinkGraphFacts,
} from "@/lib/dependent-link-eligibility";
import {
  ancestorDepthWithinWhere,
  descendantDepthWithinWhere,
  MAX_FAMILY_LINK_GENERATIONS,
  MAX_PARENT_LINK_CHAIN_LENGTH,
} from "@/lib/member-family-link-depth";
import { notPartnerWithMemberWhere } from "@/lib/member-parent-partner-exclusivity";

/**
 * #2254. The dependant-link candidate search returned "No eligible members
 * found" for perfectly valid members, because `{ not: parentId }` on the
 * NULLABLE `parentMemberId` / `secondaryParentId` columns compiles to a bare
 * `"col" <> $1`, and `NULL <> 'x'` is UNKNOWN in SQL — so every member with no
 * parent recorded was silently dropped.
 *
 * #2255 then replaced the two-generation cap with an explicit four-generation
 * one, which the SQL half expresses as bounded relation nesting ("this candidate
 * has no dependant chain longer than N"). That is exactly the kind of clause a
 * mocked Prisma cannot vouch for either, so it is exercised the same way.
 *
 * A mocked Prisma client cannot catch that: the fault is not in the JS object
 * we hand to Prisma, it is in the SQL Prisma compiles it to. So this suite does
 * not mock Prisma. It:
 *
 *   1. lets the REAL Prisma client compile the real `where` to real SQL,
 *      captured through a driver adapter that records instead of connecting
 *      (no database, no DATABASE_URL, no network); then
 *   2. executes that SQL over fixture rows in an in-memory SQLite database
 *      (`node:sqlite`), because SQL's three-valued NULL logic — the entire
 *      subject of the original bug — is identical in SQLite and Postgres, as is
 *      correlated-subquery semantics, which is what the depth nesting compiles
 *      to.
 *
 * What that proves: the compiled predicate returns the right members, NULLs
 * included. What it does not prove: Postgres-specific behaviour (collations,
 * `mode: "insensitive"` ILIKE, index use). Those are out of scope here — the
 * eligibility predicate uses only equality, IS NULL, IN, and NOT EXISTS.
 */

// ── The recording driver adapter ────────────────────────────────────────────

type CapturedQuery = { sql: string; args: unknown[] };

function recordingAdapterFactory(captured: CapturedQuery[]) {
  const queryable = {
    provider: "postgres" as const,
    adapterName: "@prisma/adapter-pg",
    async queryRaw(params: CapturedQuery) {
      captured.push({ sql: params.sql, args: params.args });
      return { columnTypes: [], columnNames: [], rows: [] };
    },
    async executeRaw(params: CapturedQuery) {
      captured.push({ sql: params.sql, args: params.args });
      return 0;
    },
    async executeScript() {},
    async startTransaction(): Promise<never> {
      throw new Error("the SQL probe never opens a transaction");
    },
    async dispose() {},
    getConnectionInfo() {
      return { supportsRelationJoins: false };
    },
  };

  return {
    provider: "postgres" as const,
    adapterName: "@prisma/adapter-pg",
    async connect() {
      return queryable;
    },
  };
}

/** Compile a `Member.findMany` where clause to SQL without touching a database. */
async function compileMemberWhereToSql(
  where: Prisma.MemberWhereInput,
): Promise<CapturedQuery> {
  const captured: CapturedQuery[] = [];
  const prisma = new PrismaClient({
    adapter: recordingAdapterFactory(captured) as never,
  });
  try {
    await prisma.member.findMany({ where, select: { id: true } });
  } finally {
    await prisma.$disconnect();
  }
  expect(captured).toHaveLength(1);
  return captured[0];
}

/**
 * Postgres -> SQLite, for the narrow shape Prisma emits here: drop the schema
 * qualifier, drop the trailing paging clause (we only exercise the predicate),
 * and turn `$n` into positional `?`. The ascending-order assertion is what
 * makes positional binding safe; if Prisma ever emits placeholders out of
 * order this fails loudly rather than binding the wrong values.
 *
 * Everything from `FROM` onwards is kept, not just the WHERE clause: a to-one
 * relation filter (`parent: { is: … }`, which the ancestor-depth builder uses)
 * compiles to LEFT JOINs plus predicates on the join aliases, so lifting the
 * WHERE alone would produce SQL referring to tables that were never joined.
 */
function toSqliteSelect(query: CapturedQuery) {
  const fromAt = query.sql.indexOf(" FROM ");
  const whereAt = query.sql.indexOf(" WHERE ");
  expect(fromAt).toBeGreaterThan(-1);
  expect(whereAt).toBeGreaterThan(fromAt);
  const pagingAt = Math.min(
    ...[" OFFSET ", " LIMIT "]
      .map((token) => query.sql.indexOf(token, whereAt))
      .filter((index) => index > -1)
      .concat([query.sql.length]),
  );

  const body = query.sql.slice(fromAt, pagingAt).replaceAll('"public".', "");

  const placeholders = [...body.matchAll(/\$(\d+)/g)].map((match) =>
    Number(match[1]),
  );
  expect(placeholders).toEqual(placeholders.map((_, index) => index + 1));

  return {
    sql: `SELECT "Member"."id"${body.replaceAll(/\$\d+/g, "?")}`,
    args: query.args.slice(0, placeholders.length),
  };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const PARENT_ID = "parent-1";

type Fixture = DependentLinkCandidate & {
  firstName: string;
  active: boolean;
};
type FixtureInput = Omit<
  Fixture,
  "partnerLinksAsMemberA" | "partnerLinksAsMemberB"
> &
  Partial<Pick<Fixture, "partnerLinksAsMemberA" | "partnerLinksAsMemberB">>;

/**
 * A single family graph, expressed ONLY through the two parent columns.
 *
 * #2255 deliberately removed the separate `dependents` / `secondaryDependents`
 * arrays these fixtures used to carry. They were a second, hand-maintained copy
 * of the same edges, and nothing stopped the copy disagreeing with the columns —
 * which is precisely how a depth fixture would end up proving nothing. Downward
 * edges are now derived from the columns by {@link descendantGenerationsOf}, so
 * the row-level predicate, the SQL predicate, and the SQLite rows are all
 * reading one graph.
 */
const FIXTURE_INPUTS: Array<{ member: FixtureInput; why: string }> = [
  {
    why: "the parent themself — cannot be their own dependant",
    member: {
      id: PARENT_ID,
      firstName: "Parent",
      active: true,
      archivedAt: null,
      parentMemberId: null,
      secondaryParentId: null,
    },
  },
  {
    why: "a parentless adult — the case the NULL bug hid",
    member: {
      id: "parentless-adult",
      firstName: "Parentless",
      active: true,
      archivedAt: null,
      parentMemberId: null,
      secondaryParentId: null,
    },
  },
  {
    why: "one parent recorded, second slot free",
    member: {
      id: "one-parent",
      firstName: "OneParent",
      active: true,
      archivedAt: null,
      parentMemberId: "other-parent",
      secondaryParentId: null,
    },
  },
  {
    why: "secondary-only parent — the other half of the NULL bug",
    member: {
      id: "secondary-parent-only",
      firstName: "SecondaryOnly",
      active: true,
      archivedAt: null,
      parentMemberId: null,
      secondaryParentId: "other-parent",
    },
  },
  {
    why: "inactive members stay linkable — the write route accepts them",
    member: {
      id: "inactive",
      firstName: "Inactive",
      active: false,
      archivedAt: null,
      parentMemberId: null,
      secondaryParentId: null,
    },
  },
  {
    why: "a pending or confirmed partner row reserves the incompatible pair",
    member: {
      id: "direct-partner",
      firstName: "Partner",
      active: true,
      archivedAt: null,
      parentMemberId: null,
      secondaryParentId: null,
      partnerLinksAsMemberB: [{ memberAId: PARENT_ID }],
    },
  },
  {
    why: "both parent slots taken",
    member: {
      id: "two-parents",
      firstName: "TwoParents",
      active: true,
      archivedAt: null,
      parentMemberId: "other-parent",
      secondaryParentId: "another-parent",
    },
  },
  {
    why: "archived members are rejected by the write route",
    member: {
      id: "archived",
      firstName: "Archived",
      active: true,
      archivedAt: new Date("2026-01-01T00:00:00.000Z"),
      parentMemberId: null,
      secondaryParentId: null,
    },
  },
  {
    why: "already linked to this very parent",
    member: {
      id: "already-linked",
      firstName: "AlreadyLinked",
      active: true,
      archivedAt: null,
      parentMemberId: PARENT_ID,
      secondaryParentId: null,
    },
  },
  {
    why: "already linked to this parent as the SECOND parent",
    member: {
      id: "already-linked-secondary",
      firstName: "AlreadySecondary",
      active: true,
      archivedAt: null,
      parentMemberId: "other-parent",
      secondaryParentId: PARENT_ID,
    },
  },

  // ── A full four-generation chain through the PRIMARY parent column ────────
  // gen-1 already carries three generations beneath them, so linking gen-1
  // under anyone at all would make a fifth. gen-2 carries two, which is exactly
  // what a root parent still has room for.
  {
    why: "top of a four-generation chain — no room left beneath them",
    member: {
      id: "gen-1",
      firstName: "GreatGrandparent",
      active: true,
      archivedAt: null,
      parentMemberId: null,
      secondaryParentId: null,
    },
  },
  {
    why: "second generation — two generations beneath them",
    member: {
      id: "gen-2",
      firstName: "Grandparent",
      active: true,
      archivedAt: null,
      parentMemberId: "gen-1",
      secondaryParentId: null,
    },
  },
  {
    why: "third generation — one generation beneath them",
    member: {
      id: "gen-3",
      firstName: "Parent",
      active: true,
      archivedAt: null,
      parentMemberId: "gen-2",
      secondaryParentId: null,
    },
  },
  {
    why: "the leaf of the chain",
    member: {
      id: "gen-4",
      firstName: "Child",
      active: true,
      archivedAt: null,
      parentMemberId: "gen-3",
      secondaryParentId: null,
    },
  },

  // ── The same shape, but every edge through the SECONDARY parent column ────
  // This is the pair that makes the secondary half of the nested depth clause
  // decisive: with `secondaryDependents` dropped from the builder, `sec-1` is
  // offered as a candidate even though it heads four generations.
  {
    why: "top of a four-generation chain built entirely from second-parent links",
    member: {
      id: "sec-1",
      firstName: "SecGreatGrandparent",
      active: true,
      archivedAt: null,
      parentMemberId: null,
      secondaryParentId: null,
    },
  },
  {
    why: "second generation, reached through the second-parent slot",
    member: {
      id: "sec-2",
      firstName: "SecGrandparent",
      active: true,
      archivedAt: null,
      parentMemberId: null,
      secondaryParentId: "sec-1",
    },
  },
  {
    why: "third generation, reached through the second-parent slot",
    member: {
      id: "sec-3",
      firstName: "SecParent",
      active: true,
      archivedAt: null,
      parentMemberId: null,
      secondaryParentId: "sec-2",
    },
  },
  {
    why: "the leaf of the second-parent chain",
    member: {
      id: "sec-4",
      firstName: "SecChild",
      active: true,
      archivedAt: null,
      parentMemberId: null,
      secondaryParentId: "sec-3",
    },
  },
];

const FIXTURES: Array<{ member: Fixture; why: string }> = FIXTURE_INPUTS.map(
  ({ member, why }) => ({
    why,
    member: {
      partnerLinksAsMemberA: [],
      partnerLinksAsMemberB: [],
      ...member,
    },
  }),
);

/**
 * Fixtures are addressed by id, never by index: this table grows, and a
 * positional lookup would silently re-point an assertion at a different member.
 */
function fixture(id: string): Fixture {
  const row = FIXTURES.find((entry) => entry.member.id === id);
  if (!row) throw new Error(`no fixture with id ${id}`);
  return row.member;
}

/** Children of `id` in the fixture graph, through either parent column. */
function childrenOf(id: string): Fixture[] {
  return FIXTURES.map((entry) => entry.member).filter(
    (member) => member.parentMemberId === id || member.secondaryParentId === id,
  );
}

/** Longest chain of parent links beneath `id`, over the fixture graph. */
function descendantGenerationsOf(id: string): number {
  const children = childrenOf(id);
  if (children.length === 0) return 0;
  return (
    1 + Math.max(...children.map((child) => descendantGenerationsOf(child.id)))
  );
}

/** Every ancestor of `id`, and the longest chain above them. */
function ancestorsOf(id: string): { ids: string[]; generations: number } {
  const member = FIXTURES.find((entry) => entry.member.id === id)?.member;
  const direct = [member?.parentMemberId, member?.secondaryParentId].filter(
    (value): value is string => Boolean(value),
  );
  if (direct.length === 0) return { ids: [], generations: 0 };

  const ids = new Set<string>(direct);
  let generations = 1;
  for (const parentId of direct) {
    const above = ancestorsOf(parentId);
    above.ids.forEach((value) => ids.add(value));
    generations = Math.max(generations, 1 + above.generations);
  }
  return { ids: [...ids], generations };
}

/**
 * The graph facts the caller is required to supply, derived from the fixture
 * graph rather than restated — so a fixture edit can never leave the expected
 * depth behind.
 */
function graphFactsFor(parentId: string, candidateId: string): DependentLinkGraphFacts {
  const above = ancestorsOf(parentId);
  return {
    parentAncestorIds: above.ids,
    parentAncestorGenerations: above.generations,
    candidateDescendantGenerations: descendantGenerationsOf(candidateId),
  };
}

/** The eligibility answer this suite expects, derived from the same graph. */
function expectedEligible(parentId: string, candidate: Fixture): boolean {
  if (candidate.archivedAt) return false;
  if (candidate.id === parentId) return false;
  if (
    candidate.parentMemberId === parentId ||
    candidate.secondaryParentId === parentId
  ) {
    return false;
  }
  if (candidate.parentMemberId && candidate.secondaryParentId) return false;
  if (
    candidate.partnerLinksAsMemberA?.some(
      (link) => link.memberBId === parentId,
    ) ||
    candidate.partnerLinksAsMemberB?.some(
      (link) => link.memberAId === parentId,
    )
  ) {
    return false;
  }
  const above = ancestorsOf(parentId);
  if (above.ids.includes(candidate.id)) return false;
  return (
    above.generations + 1 + descendantGenerationsOf(candidate.id) <=
    MAX_PARENT_LINK_CHAIN_LENGTH
  );
}

function seedFixtureDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE "Member" (
      "id" TEXT PRIMARY KEY,
      "firstName" TEXT NOT NULL,
      "active" INTEGER NOT NULL,
      "archivedAt" TEXT,
      "parentMemberId" TEXT,
      "secondaryParentId" TEXT
    )`,
  );
  db.exec(
    `CREATE TABLE "MemberPartnerLink" (
      "id" TEXT PRIMARY KEY,
      "memberAId" TEXT NOT NULL,
      "memberBId" TEXT NOT NULL
    )`,
  );
  const insert = db.prepare(
    `INSERT INTO "Member" VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const { member } of FIXTURES) {
    insert.run(
      member.id,
      member.firstName,
      member.active ? 1 : 0,
      member.archivedAt ? member.archivedAt.toISOString() : null,
      member.parentMemberId,
      member.secondaryParentId,
    );
  }
  const insertPartner = db.prepare(
    `INSERT INTO "MemberPartnerLink" VALUES (?, ?, ?)`,
  );
  const insertedPairs = new Set<string>();
  for (const { member } of FIXTURES) {
    for (const link of member.partnerLinksAsMemberA ?? []) {
      const key = `${member.id}\u0000${link.memberBId}`;
      if (insertedPairs.has(key)) continue;
      insertPartner.run(`link-${insertedPairs.size}`, member.id, link.memberBId);
      insertedPairs.add(key);
    }
    for (const link of member.partnerLinksAsMemberB ?? []) {
      const key = `${link.memberAId}\u0000${member.id}`;
      if (insertedPairs.has(key)) continue;
      insertPartner.run(`link-${insertedPairs.size}`, link.memberAId, member.id);
      insertedPairs.add(key);
    }
  }
  return db;
}

async function runWhereAgainstFixtures(where: Prisma.MemberWhereInput) {
  const compiled = await compileMemberWhereToSql(where);
  const translated = toSqliteSelect(compiled);
  const db = seedFixtureDatabase();
  try {
    const rows = db
      .prepare(translated.sql)
      .all(...(translated.args as string[]));
    return rows.map((row) => (row as { id: string }).id);
  } finally {
    db.close();
  }
}

/** The SQL half, for a parent whose own chain is read off the fixture graph. */
function candidateWhereFor(parentId: string) {
  const above = ancestorsOf(parentId);
  return dependentLinkCandidateWhere(parentId, {
    parentAncestorIds: above.ids,
    parentAncestorGenerations: above.generations,
  });
}

// ── The row-level predicate ─────────────────────────────────────────────────

describe("dependentLinkBlockers", () => {
  for (const { member, why } of FIXTURES) {
    const eligible = expectedEligible(PARENT_ID, member);
    it(`${eligible ? "clears" : "blocks"} ${member.id}: ${why}`, () => {
      const blockers = dependentLinkBlockers(
        PARENT_ID,
        member,
        graphFactsFor(PARENT_ID, member.id),
      );
      expect(blockers.length === 0).toBe(eligible);
    });
  }

  it("names the specific reason, most specific first", () => {
    const blockersFor = (id: string) =>
      dependentLinkBlockers(PARENT_ID, fixture(id), graphFactsFor(PARENT_ID, id));

    expect(blockersFor("two-parents")).toEqual(["TWO_PARENTS"]);
    expect(blockersFor("archived")).toEqual(["ARCHIVED"]);
    expect(blockersFor("already-linked")).toEqual(["ALREADY_LINKED_TO_PARENT"]);
    // The parent themself trips SELF first, and SELF is what the admin needs.
    expect(blockersFor(PARENT_ID)[0]).toBe("SELF");
    // #2255: having dependants is no longer a blocker by itself — only a chain
    // that would not FIT is. gen-2 heads two generations and clears; gen-1 heads
    // three and does not.
    expect(blockersFor("gen-2")).toEqual([]);
    expect(blockersFor("gen-1")).toEqual(["EXCEEDS_GENERATION_LIMIT"]);
    // And the same is true through the second-parent slot, which is a parent
    // link like any other.
    expect(blockersFor("sec-2")).toEqual([]);
    expect(blockersFor("sec-1")).toEqual(["EXCEEDS_GENERATION_LIMIT"]);
  });

  it("blocks an ancestor of the parent outright (cycle guard)", () => {
    // Linking gen-2 (the parent's own grandparent) under gen-4 would close a
    // loop. Before #2255 this was excluded only as a SIDE EFFECT of gen-2 having
    // dependants; the rule is now stated in its own right, which is what keeps
    // it working once the depth rule stops covering it.
    expect(
      dependentLinkBlockers(
        "gen-4",
        fixture("gen-2"),
        graphFactsFor("gen-4", "gen-2"),
      ),
    ).toContain("ANCESTOR_OF_PARENT");
  });

  it("returns reasons in the declared order", () => {
    const everyBlocker = dependentLinkBlockers(
      PARENT_ID,
      {
        id: PARENT_ID,
        archivedAt: new Date(),
        parentMemberId: PARENT_ID,
        secondaryParentId: "other",
        partnerLinksAsMemberA: [{ memberBId: PARENT_ID }],
        partnerLinksAsMemberB: [],
      },
      {
        parentAncestorIds: [PARENT_ID],
        parentAncestorGenerations: MAX_PARENT_LINK_CHAIN_LENGTH,
        candidateDescendantGenerations: MAX_PARENT_LINK_CHAIN_LENGTH,
      },
    );
    expect(everyBlocker).toEqual([...DEPENDENT_LINK_INELIGIBILITY_REASONS]);
  });

  it("gives every reason both an API message and an admin-facing phrase", () => {
    for (const reason of DEPENDENT_LINK_INELIGIBILITY_REASONS) {
      expect(DEPENDENT_LINK_INELIGIBILITY_ERRORS[reason]).toBeTruthy();
      expect(DEPENDENT_LINK_INELIGIBILITY_EXPLANATIONS[reason]).toBeTruthy();
    }
  });

  it("states the cap as four generations, i.e. three parent links", () => {
    expect(MAX_FAMILY_LINK_GENERATIONS).toBe(4);
    expect(MAX_PARENT_LINK_CHAIN_LENGTH).toBe(3);
    expect(
      DEPENDENT_LINK_INELIGIBILITY_ERRORS.EXCEEDS_GENERATION_LIMIT,
    ).toContain("4 generations");
  });
});

// ── The SQL half: shape, then real generated SQL, then real rows ────────────

describe("dependentLinkCandidateWhere", () => {
  it("guards both nullable parent columns with an explicit IS NULL branch", () => {
    expect(candidateWhereFor(PARENT_ID)).toEqual([
      { id: { notIn: [PARENT_ID] } },
      { OR: [{ parentMemberId: null }, { parentMemberId: { not: PARENT_ID } }] },
      ...notPartnerWithMemberWhere(PARENT_ID),
      {
        OR: [
          { secondaryParentId: null },
          { secondaryParentId: { not: PARENT_ID } },
        ],
      },
      { OR: [{ parentMemberId: null }, { secondaryParentId: null }] },
      descendantDepthWithinWhere(2),
      { archivedAt: null },
    ]);
  });

  it("shrinks the allowed dependant depth as the parent's own chain grows", () => {
    // A parent with no ancestors leaves room for two generations beneath the
    // candidate; a parent who is already a grandchild leaves room for none; a
    // parent at the very bottom of a four-generation chain leaves a clause
    // nothing can satisfy.
    expect(candidateWhereFor(PARENT_ID)).toContainEqual(
      descendantDepthWithinWhere(2),
    );
    expect(candidateWhereFor("gen-3")).toContainEqual(
      descendantDepthWithinWhere(0),
    );
    expect(candidateWhereFor("gen-4")).toContainEqual(
      descendantDepthWithinWhere(-1),
    );
  });

  it("compiles to SQL that admits NULL parent columns", async () => {
    const { sql } = await compileMemberWhereToSql({
      AND: candidateWhereFor(PARENT_ID),
    });

    expect(sql).toContain(
      `"public"."Member"."parentMemberId" IS NULL OR "public"."Member"."parentMemberId" <> `,
    );
    expect(sql).toContain(
      `"public"."Member"."secondaryParentId" IS NULL OR "public"."Member"."secondaryParentId" <> `,
    );
    expect(sql).toContain(`"public"."Member"."archivedAt" IS NULL`);
  });

  it("returns every eligible member — including members with no parent", async () => {
    const returned = await runWhereAgainstFixtures({
      AND: candidateWhereFor(PARENT_ID),
    });
    const expected = FIXTURES.filter(({ member }) =>
      expectedEligible(PARENT_ID, member),
    ).map(({ member }) => member.id);

    expect(returned.sort()).toEqual([...expected].sort());
    // Guard against the expectation collapsing to "everything" or "nothing".
    expect(returned).toContain("parentless-adult");
    expect(returned).toContain("gen-2");
    expect(returned).not.toContain("gen-1");
  });

  it("counts depth through the SECOND parent slot as well as the first", async () => {
    const clauses = candidateWhereFor(PARENT_ID);
    const returned = await runWhereAgainstFixtures({ AND: clauses });
    expect(returned).not.toContain("sec-1");

    // Mutation check, kept executable: rebuild the depth clause with only the
    // primary-parent branch at each level and sec-1 comes back. Without this the
    // secondary branch of the nested filter is inert over the fixture set and
    // could be deleted with every other test in this suite still passing.
    const primaryOnlyDepth: Prisma.MemberWhereInput = {
      NOT: {
        dependents: { some: { dependents: { some: { dependents: { some: {} } } } } },
      },
    };
    // Addressed by CONTENT, not by index: `clauses[4]` would silently start
    // removing a different clause the moment the builder's order changed, and
    // the mutation check would then pass for the wrong reason.
    const depthClause = descendantDepthWithinWhere(2);
    const withoutDepthClause = clauses.filter(
      (clause) => JSON.stringify(clause) !== JSON.stringify(depthClause),
    );
    expect(withoutDepthClause).toHaveLength(clauses.length - 1);

    const withoutSecondaryBranch = await runWhereAgainstFixtures({
      AND: [...withoutDepthClause, primaryOnlyDepth],
    });
    expect(withoutSecondaryBranch).toContain("sec-1");
  });

  it("offers nothing at all under a parent who already fills the cap", async () => {
    // gen-4 sits three parent links below gen-1. Any dependant of theirs would
    // be a fifth generation, so the clause must be unsatisfiable rather than
    // absent — an omitted filter would fail OPEN and offer the whole club.
    const returned = await runWhereAgainstFixtures({
      AND: candidateWhereFor("gen-4"),
    });
    expect(returned).toEqual([]);
  });

  it("never offers an ancestor of the parent", async () => {
    const returned = await runWhereAgainstFixtures({
      AND: candidateWhereFor("gen-3"),
    });
    expect(returned).not.toContain("gen-2");
    expect(returned).not.toContain("gen-1");
  });

  it("agrees row-for-row with the row-level predicate (search/write parity)", async () => {
    for (const parentId of [PARENT_ID, "gen-2", "gen-3", "gen-4", "sec-2"]) {
      const returned = new Set(
        await runWhereAgainstFixtures({ AND: candidateWhereFor(parentId) }),
      );

      for (const { member } of FIXTURES) {
        expect({
          parentId,
          id: member.id,
          offeredBySearch: returned.has(member.id),
        }).toEqual({
          parentId,
          id: member.id,
          offeredBySearch:
            dependentLinkBlockers(
              parentId,
              member,
              graphFactsFor(parentId, member.id),
            ).length === 0,
        });
      }
    }
  });

  it("the pre-#2254 filter dropped every parentless member (regression guard)", async () => {
    // The exact clauses this fix replaced. Kept as an executable record of the
    // bug: `{ not: id }` on a nullable column is not "everyone except id".
    const returned = await runWhereAgainstFixtures({
      AND: [
        { id: { not: PARENT_ID } },
        { parentMemberId: { not: PARENT_ID } },
        { secondaryParentId: { not: PARENT_ID } },
        { OR: [{ parentMemberId: null }, { secondaryParentId: null }] },
        { dependents: { none: {} } },
        { secondaryDependents: { none: {} } },
      ],
    });

    expect(returned).not.toContain("parentless-adult");
    expect(returned).not.toContain("one-parent");
    expect(returned).not.toContain("inactive");
    // It matched nobody at all: every candidate has at least one NULL parent
    // column, which is exactly why the dialog looked broken for everyone.
    expect(returned).toEqual([]);
  });
});

// ── The mirror-image clause used by the "Add Parent" search ─────────────────

/**
 * #2255. The acceptance criterion says the cap holds in EITHER direction, and
 * only the dependant direction had executed-SQL parity. The "Add Parent" search
 * is the mirror: the searched-for member becomes the PARENT, so the member's own
 * dependants eat into the budget and the candidate's ANCESTOR chain must fit in
 * what is left. Same rule, same numbers, reflected — so the same executed check.
 */
describe("parent-direction (Add Parent) search/write parity", () => {
  /**
   * The SQL half of the parent-direction search, assembled exactly as
   * `admin-members-service` assembles it, so this test cannot pass against a
   * predicate the service does not actually issue.
   */
  function parentCandidateWhereFor(memberId: string): Prisma.MemberWhereInput[] {
    const below = descendantGenerationsOf(memberId);
    const descendants = FIXTURES.map(({ member }) => member.id).filter((id) =>
      ancestorsOf(id).ids.includes(memberId),
    );
    return [
      { id: { notIn: [memberId, ...descendants] } },
      ...notPartnerWithMemberWhere(memberId),
      ancestorDepthWithinWhere(MAX_PARENT_LINK_CHAIN_LENGTH - 1 - below),
    ];
  }

  /** The row-level verdict for "may `candidate` become `member`'s parent?" */
  function parentLinkAllowed(memberId: string, candidateId: string): boolean {
    if (candidateId === memberId) return false;
    const candidate = fixture(candidateId);
    if (
      candidate.partnerLinksAsMemberA?.some(
        (link) => link.memberBId === memberId,
      ) ||
      candidate.partnerLinksAsMemberB?.some(
        (link) => link.memberAId === memberId,
      )
    ) {
      return false;
    }
    // A descendant becoming a parent is a cycle.
    if (ancestorsOf(candidateId).ids.includes(memberId)) return false;
    return (
      ancestorsOf(candidateId).generations +
        1 +
        descendantGenerationsOf(memberId) <=
      MAX_PARENT_LINK_CHAIN_LENGTH
    );
  }

  it("agrees row-for-row with the row-level verdict, at every depth", async () => {
    for (const memberId of ["gen-1", "gen-2", "gen-3", "gen-4", "sec-2", "parentless-adult"]) {
      const offered = new Set(
        await runWhereAgainstFixtures({ AND: parentCandidateWhereFor(memberId) }),
      );

      for (const { member } of FIXTURES) {
        expect({
          memberId,
          candidate: member.id,
          offeredBySearch: offered.has(member.id),
        }).toEqual({
          memberId,
          candidate: member.id,
          offeredBySearch: parentLinkAllowed(memberId, member.id),
        });
      }
    }
  });

  it("offers nobody a parent to a member who already heads four generations", async () => {
    // gen-1 has three generations beneath them, so any parent above would be a
    // fifth. The budget goes negative and the clause must be unsatisfiable.
    expect(
      await runWhereAgainstFixtures({ AND: parentCandidateWhereFor("gen-1") }),
    ).toEqual([]);
  });

  it("never offers one of the member's own descendants as a parent", async () => {
    const offered = await runWhereAgainstFixtures({
      AND: parentCandidateWhereFor("gen-3"),
    });
    expect(offered).not.toContain("gen-4");
  });

  it("shrinks the candidate's allowed ancestor depth as the member's own family grows", async () => {
    // A childless member can take a parent who is themselves a grandchild;
    // a member with two generations below them can only take a root.
    const childless = await runWhereAgainstFixtures({
      AND: parentCandidateWhereFor("parentless-adult"),
    });
    expect(childless).toContain("gen-3");

    const twoBelow = await runWhereAgainstFixtures({
      AND: parentCandidateWhereFor("gen-2"),
    });
    expect(twoBelow).not.toContain("gen-3");
  });
});

describe("ancestorDepthWithinWhere", () => {
  it("selects members whose own ancestor chain is short enough", async () => {
    const withinOne = await runWhereAgainstFixtures(
      ancestorDepthWithinWhere(1),
    );
    // gen-1 (root) and gen-2 (one link above) fit; gen-3 and gen-4 do not.
    expect(withinOne).toContain("gen-1");
    expect(withinOne).toContain("gen-2");
    expect(withinOne).not.toContain("gen-3");
    expect(withinOne).not.toContain("gen-4");
  });

  it("counts a chain built from SECOND parent links the same way", async () => {
    const withinOne = await runWhereAgainstFixtures(
      ancestorDepthWithinWhere(1),
    );
    expect(withinOne).toContain("sec-2");
    expect(withinOne).not.toContain("sec-3");
    expect(withinOne).not.toContain("sec-4");
  });

  it("admits only parentless members at zero, and nobody below zero", async () => {
    const roots = await runWhereAgainstFixtures(ancestorDepthWithinWhere(0));
    expect(roots).toContain("gen-1");
    expect(roots).toContain("parentless-adult");
    expect(roots).not.toContain("gen-2");

    expect(await runWhereAgainstFixtures(ancestorDepthWithinWhere(-1))).toEqual(
      [],
    );
  });
});

/**
 * #2282 — the PARENT-side rule, which is all that is left of the checks on the
 * member who takes the dependent.
 *
 * The `ageTier === "ADULT"` clause that used to sit here is gone by owner
 * decision: a 16 or 17 year old can genuinely be a parent and the club could not
 * record it. This predicate is what BOTH write routes and BOTH admin controls
 * now consult, so the disabled button, the dialog's notice and the two 422
 * bodies cannot disagree about who may take a dependent.
 *
 * The ORGANISATION clause replaces what the ADULT clause used to exclude by
 * accident. It is classified by ROLE and never by `ageTier`, because
 * `NOT_APPLICABLE` is the age-EXEMPT tier and age-exempt HUMAN members carry it
 * too (#1440, #2106) — filtering on the tier would bar real people from being
 * recorded as parents and show them copy calling them an organisation.
 *
 * Mutation probes: delete the `archivedAt` branch and the archived cases fail;
 * delete the `active` branch and the inactive case fails; delete the
 * organisation branch and both organisation cases fail; drop `canLogin` from the
 * token resolution, or swap the SQL clause to `ageTier`, and the parity cases
 * fail.
 */
describe("dependentParentStateBlocker (#2282)", () => {
  /** An ordinary current member, whatever their age. */
  const CURRENT = {
    role: "USER",
    accessRoles: ["USER"] as string[],
    canLogin: true,
    active: true,
    archivedAt: null as Date | string | null,
  };

  it("clears an active, non-archived member", () => {
    expect(dependentParentStateBlocker(CURRENT)).toBeNull();
  });

  it("clears an age-exempt HUMAN account, which is not an organisation", () => {
    // #1440/#2106: `NOT_APPLICABLE` is carried by organisations AND by
    // age-exempt people (an admin on an age-exempt membership type, say). The
    // predicate cannot see `ageTier` at all — that is deliberate, and the SQL
    // parity case below is what stops the tier creeping back in — so what this
    // pins is that an ordinary non-ORG role clears regardless of anything the
    // tier might say.
    expect(
      dependentParentStateBlocker({ ...CURRENT, accessRoles: ["ADMIN"] }),
    ).toBeNull();
  });

  it("blocks an organisation holding the ORG access token", () => {
    expect(
      dependentParentStateBlocker({
        ...CURRENT,
        role: "SCHOOL",
        accessRoles: ["ORG"],
      }),
    ).toBe("ORGANISATION");
  });

  it("blocks a NON-LOGIN school account, whose ORG token is cleared", () => {
    // `resolveAccessRoleTokens` returns [] for `canLogin: false`, which is
    // exactly why `isOrganisationMember` also reads the legacy role. A check
    // written on the tokens alone would let a non-login school be a parent.
    expect(
      dependentParentStateBlocker({
        ...CURRENT,
        role: "SCHOOL",
        accessRoles: ["ORG"],
        canLogin: false,
      }),
    ).toBe("ORGANISATION");
  });

  it("clears a NON-LOGIN member whose ORG token is cleared and role is not SCHOOL", () => {
    // Not a product rule so much as the PARITY rule. `resolveAccessRoleTokens`
    // returns [] for `canLogin: false`, so `isOrganisationMember` says no here —
    // and the SQL half spells the same thing out as
    // `canLogin: true AND accessRoles.some(role: ORG)`. If this predicate
    // ignored `canLogin` (or the SQL wrote a plain `accessRoles: { none: … }`)
    // the search would hide a member the write route accepts, which is the
    // #2254 drift in the other direction.
    expect(
      dependentParentStateBlocker({
        ...CURRENT,
        role: "USER",
        accessRoles: ["ORG"],
        canLogin: false,
      }),
    ).toBeNull();
  });

  it("says ORGANISATION before ARCHIVED or INACTIVE", () => {
    // Order decides the sentence the admin reads, and "archive" and
    // "reactivate" both imply that undoing the state would let them add a
    // dependent here. For an organisation account it never would.
    expect(
      dependentParentStateBlocker({
        ...CURRENT,
        role: "SCHOOL",
        accessRoles: [],
        active: false,
        archivedAt: new Date("2026-01-01"),
      }),
    ).toBe("ORGANISATION");
  });

  it("blocks an inactive member", () => {
    expect(dependentParentStateBlocker({ ...CURRENT, active: false })).toBe(
      "INACTIVE",
    );
  });

  it("blocks an archived member as ARCHIVED, not INACTIVE", () => {
    // Archiving also clears `active`, so order decides which reason the admin
    // reads — and archiving cannot be undone, so "reactivate them" would be the
    // wrong instruction entirely.
    expect(
      dependentParentStateBlocker({
        ...CURRENT,
        active: false,
        archivedAt: new Date("2026-01-01"),
      }),
    ).toBe("ARCHIVED");
    expect(
      dependentParentStateBlocker({
        ...CURRENT,
        archivedAt: new Date("2026-01-01"),
      }),
    ).toBe("ARCHIVED");
  });

  it("accepts a serialised date, so the admin UI shares one predicate", () => {
    // The member detail page passes the JSON response straight in; if this only
    // took `Date`, the client would need its own copy of the rule and the two
    // would drift — which is the whole failure #2254 existed to close.
    expect(
      dependentParentStateBlocker({
        ...CURRENT,
        archivedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe("ARCHIVED");
  });

  it("accepts already-resolved tokens as well as raw assignment rows", () => {
    // The admin UI passes `member.accessRoles` (strings the detail API already
    // resolved); the write routes pass `MemberAccessRole` rows. One predicate,
    // both sides of the wire.
    expect(
      dependentParentStateBlocker({
        ...CURRENT,
        role: "SCHOOL",
        accessRoles: [{ role: "ORG", roleDefinitionId: null }],
      }),
    ).toBe("ORGANISATION");
  });

  it("mirrors itself in SQL, by role and never by age tier", async () => {
    // #2254's no-drift rule: the "Add Parent" search must offer exactly what the
    // write route accepts. Pinned structurally so a rewrite to
    // `{ ageTier: { not: "NOT_APPLICABLE" } }` — the shape that looks equivalent
    // and quietly bars age-exempt PEOPLE — fails here.
    expect(dependentParentEligibleWhere()).toEqual([
      {
        NOT: {
          OR: [
            { role: "SCHOOL" },
            { canLogin: true, accessRoles: { some: { role: "ORG" } } },
          ],
        },
      },
      { active: true },
      { archivedAt: null },
    ]);

    const { sql } = await compileMemberWhereToSql({
      AND: dependentParentEligibleWhere(),
    });
    expect(sql).not.toContain("ageTier");
    expect(sql).toContain("MemberAccessRole");
  });

  it("gives every reason a link message, a create message and an explanation", () => {
    // Three surfaces, one reason set. A new reason added to the union without
    // copy for all three would fail here rather than render `undefined` at an
    // admin.
    for (const reason of DEPENDENT_PARENT_STATE_REASONS) {
      expect(DEPENDENT_PARENT_LINK_ERRORS[reason]).toBeTruthy();
      expect(DEPENDENT_PARENT_CREATE_ERRORS[reason]).toBeTruthy();
      expect(DEPENDENT_PARENT_BLOCK_EXPLANATIONS[reason]).toBeTruthy();
    }
    // The two API messages are deliberately distinct: they are two endpoints
    // with two contracts, and a shared sentence would have to be vague about
    // which action was refused.
    for (const reason of DEPENDENT_PARENT_STATE_REASONS) {
      expect(DEPENDENT_PARENT_LINK_ERRORS[reason]).not.toBe(
        DEPENDENT_PARENT_CREATE_ERRORS[reason],
      );
    }
  });

  it("states no age rule in any of its copy", () => {
    // #2282 acceptance criterion: copy must not claim a rule the code does not
    // enforce. These strings are the ones an admin actually reads on refusal.
    //
    // Word-bounded (#2282 review). The first version of this pattern was a bare
    // /age/, which matches "manage" and "message" — so a perfectly good future
    // rewording like "restore this member to manage dependents" would have
    // failed here for a reason that has nothing to do with the rule.
    for (const message of [
      ...Object.values(DEPENDENT_PARENT_LINK_ERRORS),
      ...Object.values(DEPENDENT_PARENT_CREATE_ERRORS),
      ...Object.values(DEPENDENT_PARENT_BLOCK_EXPLANATIONS),
    ]) {
      expect(message).not.toMatch(
        /\b(adult|adults|age|ages|aged|18|youth|minor|minors)\b/i,
      );
    }
  });
});
