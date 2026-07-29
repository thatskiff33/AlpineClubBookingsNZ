import { describe, it, expect } from "vitest";
import {
  getMemberFamilyTree,
  MAX_FAMILY_TREE_MEMBERS,
  type FamilyTreeNode,
  type MemberFamilyTree,
} from "@/lib/member-family-tree";
import { MAX_PARENT_LINK_CHAIN_LENGTH } from "@/lib/member-family-link-depth";

/**
 * #2253: the whole-connected-graph family tree derivation. Exercised directly
 * against a fake db client (same pattern as member-parent-links.test.ts).
 *
 * The fake enforces a QUERY BUDGET: the traversal's safety rests on the
 * visited set and the vertical/size caps, and a broken guard shows up first as
 * runaway querying — a budget overrun fails the test immediately instead of
 * hanging it.
 *
 * It also HONOURS `take` and records the `take` it was given, because bounding
 * the tree is not the same as bounding the queries: a member with hundreds of
 * dependants must not materialise hundreds of joined rows for the walk to keep
 * a capped handful of them. A fake that ignored `take` would let that
 * regression pass silently.
 *
 * Not covered here, deliberately: the round cap (`MAX_FAMILY_TREE_ROUNDS`).
 * It is a backstop that the size cap already implies — a round either admits a
 * member or ends the walk — so no seed can reach it without first tripping the
 * size cap. It exists so the query count is bounded by something explicit.
 */

type Row = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  ageTier: string;
  active: boolean;
  canLogin: boolean;
  archivedAt: Date | null;
  cancelledAt: Date | null;
  parentMemberId: string | null;
  secondaryParentId: string | null;
  inheritEmailFromId: string | null;
  billingFamilyGroupId: string | null;
  familyGroups: string[];
};

type Seed = Partial<Row> & { id: string };

type PartnerSeed = {
  a: string;
  b: string;
  status?: string;
  id?: string;
};

function db(
  members: Seed[],
  partnerLinks: PartnerSeed[] = [],
  options: { queryBudget?: number } = {},
) {
  const budget = options.queryBudget ?? 200;
  let queries = 0;
  // Every `take` the traversal passed on its two open-ended reads, and the
  // largest row count any single query was allowed to return.
  const takes: Array<number | undefined> = [];
  let maxRowsReturned = 0;
  const record = <T,>(rows: T[]) => {
    maxRowsReturned = Math.max(maxRowsReturned, rows.length);
    return rows;
  };
  const spend = () => {
    queries += 1;
    if (queries > budget) {
      throw new Error(
        `query budget exceeded (${budget}) — traversal is not bounded`,
      );
    }
  };

  const rows = new Map<string, Row>(
    members.map((seed) => [
      seed.id,
      {
        firstName: seed.id,
        lastName: "",
        email: `${seed.id}@example.org`,
        ageTier: "ADULT",
        active: true,
        canLogin: true,
        archivedAt: null,
        cancelledAt: null,
        parentMemberId: null,
        secondaryParentId: null,
        inheritEmailFromId: null,
        billingFamilyGroupId: null,
        familyGroups: [],
        ...seed,
      } as Row,
    ]),
  );

  const links = partnerLinks.map((link, index) => ({
    id: link.id ?? `link-${index}`,
    memberAId: link.a,
    memberBId: link.b,
    status: link.status ?? "CONFIRMED",
  }));

  function shape(row: Row) {
    const source = row.inheritEmailFromId
      ? rows.get(row.inheritEmailFromId)
      : null;
    return {
      id: row.id,
      firstName: row.firstName,
      lastName: row.lastName,
      email: row.email,
      ageTier: row.ageTier,
      active: row.active,
      canLogin: row.canLogin,
      archivedAt: row.archivedAt,
      cancelledAt: row.cancelledAt,
      parentMemberId: row.parentMemberId,
      secondaryParentId: row.secondaryParentId,
      inheritEmailFromId: row.inheritEmailFromId,
      inheritEmailFrom: source
        ? { id: source.id, firstName: source.firstName, lastName: source.lastName }
        : null,
      billingFamilyGroupId: row.billingFamilyGroupId,
      familyGroupMemberships: row.familyGroups.map((groupId) => ({
        familyGroupId: groupId,
        familyGroup: { id: groupId, name: `Group ${groupId}` },
      })),
    };
  }

  function sortRows(list: Row[]) {
    return [...list].sort(
      (a, b) =>
        a.firstName.localeCompare(b.firstName) ||
        a.lastName.localeCompare(b.lastName) ||
        a.id.localeCompare(b.id),
    );
  }

  const client = {
    member: {
      async findUnique({ where }: { where: { id: string } }) {
        spend();
        const row = rows.get(where.id);
        return row ? shape(row) : null;
      },
      async findMany({
        where,
        take,
      }: {
        where: {
          id?: { in: string[] };
          OR?: Array<{
            parentMemberId?: { in: string[] };
            secondaryParentId?: { in: string[] };
          }>;
        };
        take?: number;
      }) {
        spend();
        if (where.id?.in) {
          // The by-id backfill is bounded by its own `in` list, not by `take`.
          return record(
            where.id.in
              .map((id) => rows.get(id))
              .filter((row): row is Row => Boolean(row))
              .map(shape),
          );
        }
        takes.push(take);
        const primaryIn = new Set(
          where.OR?.find((clause) => clause.parentMemberId)?.parentMemberId
            ?.in ?? [],
        );
        const secondaryIn = new Set(
          where.OR?.find((clause) => clause.secondaryParentId)
            ?.secondaryParentId?.in ?? [],
        );
        const matches = [...rows.values()].filter(
          (row) =>
            (row.parentMemberId && primaryIn.has(row.parentMemberId)) ||
            (row.secondaryParentId && secondaryIn.has(row.secondaryParentId)),
        );
        const sorted = sortRows(matches).map(shape);
        return record(take === undefined ? sorted : sorted.slice(0, take));
      },
    },
    memberPartnerLink: {
      async findMany({
        where,
        take,
      }: {
        where: {
          status: string;
          OR: Array<{
            memberAId?: { in: string[] };
            memberBId?: { in: string[] };
          }>;
        };
        take?: number;
      }) {
        spend();
        takes.push(take);
        const aIn = new Set(
          where.OR.find((clause) => clause.memberAId)?.memberAId?.in ?? [],
        );
        const bIn = new Set(
          where.OR.find((clause) => clause.memberBId)?.memberBId?.in ?? [],
        );
        const matches = links
          .filter(
            (link) =>
              link.status === where.status &&
              (aIn.has(link.memberAId) || bIn.has(link.memberBId)),
          )
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((link) => ({
            id: link.id,
            memberAId: link.memberAId,
            memberBId: link.memberBId,
          }));
        return record(take === undefined ? matches : matches.slice(0, take));
      },
    },
    get queryCount() {
      return queries;
    },
    get openEndedTakes() {
      return takes;
    },
    get maxRowsReturned() {
      return maxRowsReturned;
    },
  };

  return client as unknown as Parameters<typeof getMemberFamilyTree>[0] & {
    queryCount: number;
    openEndedTakes: Array<number | undefined>;
    maxRowsReturned: number;
  };
}

function flatten(tree: MemberFamilyTree): FamilyTreeNode[] {
  const out: FamilyTreeNode[] = [];
  const walk = (node: FamilyTreeNode) => {
    out.push(node);
    if (node.attachedPartner) walk(node.attachedPartner);
    node.children.forEach(walk);
  };
  tree.roots.forEach(walk);
  return out;
}

function byId(tree: MemberFamilyTree, id: string): FamilyTreeNode {
  const node = flatten(tree).find((candidate) => candidate.id === id);
  if (!node) {
    throw new Error(
      `member ${id} not in tree (${flatten(tree)
        .map((candidate) => candidate.id)
        .join(", ")})`,
    );
  }
  return node;
}

describe("getMemberFamilyTree", () => {
  it("returns null for a member that does not exist", async () => {
    expect(await getMemberFamilyTree(db([]), "ghost")).toBeNull();
  });

  it("renders a single member with no links as themselves only", async () => {
    const tree = (await getMemberFamilyTree(db([{ id: "solo" }]), "solo"))!;
    expect(tree.memberCount).toBe(1);
    expect(tree.generationSpan).toBe(1);
    expect(tree.truncated).toBe(false);
    expect(tree.hasDerivedRelationships).toBe(false);
    expect(tree.roots).toHaveLength(1);
    const self = tree.roots[0];
    expect(self.id).toBe("solo");
    expect(self.isRoot).toBe(true);
    expect(self.relationship.label).toBe("This member");
    expect(self.relationship.derived).toBe(false);
    expect(self.children).toHaveLength(0);
  });

  it("nests a three-generation chain and labels stored vs derived", async () => {
    const tree = (await getMemberFamilyTree(
      db([
        { id: "gp" },
        { id: "p", parentMemberId: "gp" },
        { id: "me", parentMemberId: "p" },
        { id: "kid", parentMemberId: "me" },
      ]),
      "me",
    ))!;

    expect(tree.memberCount).toBe(4);
    expect(tree.generationSpan).toBe(4);
    // Forest nests along recorded primary links: gp → p → me → kid.
    expect(tree.roots.map((node) => node.id)).toEqual(["gp"]);
    expect(tree.roots[0].children.map((node) => node.id)).toEqual(["p"]);
    expect(byId(tree, "p").children.map((node) => node.id)).toEqual(["me"]);
    expect(byId(tree, "me").children.map((node) => node.id)).toEqual(["kid"]);

    // The root's own recorded links are stored; everything further is derived.
    expect(byId(tree, "p").relationship).toMatchObject({
      label: "Parent",
      derived: false,
    });
    expect(byId(tree, "kid").relationship).toMatchObject({
      label: "Dependant",
      derived: false,
    });
    expect(byId(tree, "gp").relationship).toMatchObject({
      label: "Grandparent",
      derived: true,
    });
    expect(byId(tree, "gp").generation).toBe(-2);
    expect(byId(tree, "kid").generation).toBe(1);
    expect(byId(tree, "me").linkToDisplayParent).toBe("PRIMARY");
    expect(tree.hasDerivedRelationships).toBe(true);
  });

  it("names the second parent inline on a two-parent child", async () => {
    const tree = (await getMemberFamilyTree(
      db([
        { id: "mum" },
        { id: "dad" },
        { id: "me", parentMemberId: "mum", secondaryParentId: "dad" },
      ]),
      "me",
    ))!;

    const me = byId(tree, "me");
    // Nested under the primary parent, second parent named inline (mockup).
    expect(me.linkToDisplayParent).toBe("PRIMARY");
    expect(byId(tree, "mum").children.map((node) => node.id)).toEqual(["me"]);
    expect(me.secondParentInline).toEqual({ id: "dad", name: "dad" });
    expect(me.relationship.description).toContain("Second parent: dad.");
    expect(byId(tree, "dad").relationship).toMatchObject({
      label: "Second parent",
      derived: false,
    });
    expect(byId(tree, "dad").children).toHaveLength(0);
  });

  it("renders a CONFIRMED partner attached beside the member, and ignores PENDING", async () => {
    const confirmed = (await getMemberFamilyTree(
      db([{ id: "me" }, { id: "kate" }], [{ a: "me", b: "kate" }]),
      "me",
    ))!;
    expect(confirmed.roots.map((node) => node.id)).toEqual(["me"]);
    expect(confirmed.roots[0].attachedPartner?.id).toBe("kate");
    expect(confirmed.roots[0].partner).toEqual({
      id: "kate",
      name: "kate",
      attachedHere: true,
    });
    expect(byId(confirmed, "kate").relationship).toMatchObject({
      label: "Partner",
      derived: false,
    });

    const pending = (await getMemberFamilyTree(
      db(
        [{ id: "me" }, { id: "kate" }],
        [{ a: "me", b: "kate", status: "PENDING" }],
      ),
      "me",
    ))!;
    expect(pending.memberCount).toBe(1);
    expect(pending.roots[0].partner).toBeNull();
  });

  it("follows the whole connected graph across households (owner reach decision)", async () => {
    // me — partner kate; kate's father hemi is in ANOTHER household; hemi has
    // another child ruby (kate's sibling) with a child of her own.
    const tree = (await getMemberFamilyTree(
      db(
        [
          { id: "me" },
          { id: "kate", parentMemberId: "hemi" },
          { id: "hemi" },
          { id: "ruby", parentMemberId: "hemi" },
          { id: "cub", parentMemberId: "ruby" },
        ],
        [{ a: "me", b: "kate" }],
      ),
      "me",
    ))!;

    expect(flatten(tree).map((node) => node.id).sort()).toEqual([
      "cub",
      "hemi",
      "kate",
      "me",
      "ruby",
    ]);
    // Affinity labels resolve relative to the partner.
    expect(byId(tree, "hemi").relationship).toMatchObject({
      label: "kate's parent",
      derived: true,
    });
    expect(byId(tree, "ruby").relationship).toMatchObject({
      label: "kate's sibling",
      derived: true,
    });
    // Partner hops never change generation: hemi is one generation up.
    expect(byId(tree, "kate").generation).toBe(0);
    expect(byId(tree, "hemi").generation).toBe(-1);
    expect(byId(tree, "cub").generation).toBe(1);
  });

  it("derives sibling vs half-sibling by WHICH parents are shared", async () => {
    const tree = (await getMemberFamilyTree(
      db([
        { id: "p" },
        { id: "k" },
        { id: "me", parentMemberId: "p", secondaryParentId: "k" },
        // Same recorded parent set — full sibling.
        { id: "sam", parentMemberId: "p", secondaryParentId: "k" },
        // Shares only k, while me also has p — half-sibling.
        { id: "ruby", parentMemberId: "k" },
      ]),
      "me",
    ))!;

    expect(byId(tree, "sam").relationship).toMatchObject({
      label: "Sibling",
      derived: true,
    });
    const ruby = byId(tree, "ruby");
    expect(ruby.relationship.label).toBe("Half-sibling");
    expect(ruby.relationship.derived).toBe(true);
    expect(ruby.relationship.description).toContain("Shares parent k.");
    // ruby's recorded parents are a proper subset of me's, so the label is
    // driven by a missing record — the node says whose (see below).
    expect(ruby.relationship.qualifier).toBe(
      "one parent not recorded for ruby",
    );
    expect(byId(tree, "sam").relationship.qualifier).toBeNull();
  });

  it("discloses whose record is incomplete behind a subset half-sibling, both ways", async () => {
    // The rule itself is unchanged and owner-decided: a different recorded
    // parent SET is a half-sibling. What is asserted here is the honesty
    // qualifier for the LIKELY real-data shape — one side simply has no second
    // parent recorded, so the two share every parent that side actually has,
    // and "Half-sibling" would otherwise be read as a claim about the family.

    // (a) the VIEWED member is the one with the incomplete record.
    const viewerIncomplete = (await getMemberFamilyTree(
      db([
        { id: "mum" },
        { id: "dad" },
        { id: "me", parentMemberId: "mum" },
        { id: "sam", parentMemberId: "mum", secondaryParentId: "dad" },
      ]),
      "me",
    ))!;
    const sam = byId(viewerIncomplete, "sam");
    expect(sam.relationship.label).toBe("Half-sibling");
    expect(sam.relationship.qualifier).toBe("one parent not recorded for me");
    expect(sam.relationship.description).toContain(
      "One parent not recorded for me.",
    );

    // (b) the OTHER member is the one with the incomplete record.
    const otherIncomplete = (await getMemberFamilyTree(
      db([
        { id: "mum" },
        { id: "dad" },
        { id: "me", parentMemberId: "mum", secondaryParentId: "dad" },
        { id: "sam", parentMemberId: "mum" },
      ]),
      "me",
    ))!;
    expect(byId(otherIncomplete, "sam").relationship).toMatchObject({
      label: "Half-sibling",
      qualifier: "one parent not recorded for sam",
    });

    // (c) genuinely different second parents on both sides — no missing
    // record to disclose, so no qualifier softens the label.
    const genuinelyHalf = (await getMemberFamilyTree(
      db([
        { id: "mum" },
        { id: "dad" },
        { id: "other" },
        { id: "me", parentMemberId: "mum", secondaryParentId: "dad" },
        { id: "sam", parentMemberId: "mum", secondaryParentId: "other" },
      ]),
      "me",
    ))!;
    expect(byId(genuinelyHalf, "sam").relationship).toMatchObject({
      label: "Half-sibling",
      qualifier: null,
    });
  });

  it("derives cousins, aunts/uncles and nieces/nephews from shared ancestors", async () => {
    const tree = (await getMemberFamilyTree(
      db([
        { id: "gp" },
        { id: "p1", parentMemberId: "gp" },
        { id: "p2", parentMemberId: "gp" },
        { id: "me", parentMemberId: "p1" },
        { id: "sib", parentMemberId: "p1" },
        { id: "cuz", parentMemberId: "p2" },
        { id: "nib", parentMemberId: "sib" },
      ]),
      "me",
    ))!;

    expect(byId(tree, "cuz").relationship.label).toBe("Cousin");
    expect(byId(tree, "p2").relationship.label).toBe("Aunt or uncle");
    expect(byId(tree, "nib").relationship.label).toBe("Niece or nephew");
    for (const id of ["cuz", "p2", "nib", "sib", "gp"]) {
      expect(byId(tree, id).relationship.derived).toBe(true);
    }
  });

  it("labels a dependant's other parent as co-parent when no partner link exists", async () => {
    const tree = (await getMemberFamilyTree(
      db([
        { id: "me" },
        { id: "ex" },
        { id: "kid", parentMemberId: "me", secondaryParentId: "ex" },
      ]),
      "me",
    ))!;

    expect(byId(tree, "ex").relationship).toMatchObject({
      label: "Co-parent of kid",
      derived: true,
    });
    // The child nests under the primary parent with the second parent inline.
    expect(byId(tree, "kid").secondParentInline).toEqual({
      id: "ex",
      name: "ex",
    });
  });

  it("keeps archived members in the tree, badged, with contact details suppressed", async () => {
    const tree = (await getMemberFamilyTree(
      db([
        { id: "me", parentMemberId: "gran" },
        { id: "gran", archivedAt: new Date("2019-06-01"), cancelledAt: new Date("2019-06-01") },
      ]),
      "me",
    ))!;

    const gran = byId(tree, "gran");
    expect(gran.archived).toBe(true);
    expect(gran.cancelled).toBe(true);
    expect(gran.email).toBeNull();
    expect(gran.relationship.description).toContain(
      "Archived member — contact details hidden.",
    );
    // Non-archived members keep the email the admin member page already shows.
    expect(byId(tree, "me").email).toBe("me@example.org");
  });

  it("terminates on a parent-link cycle and renders each member exactly once", async () => {
    const client = db(
      [
        { id: "a", parentMemberId: "b" },
        { id: "b", parentMemberId: "a" },
      ],
      [],
      { queryBudget: 30 },
    );
    const tree = (await getMemberFamilyTree(client, "a"))!;

    const ids = flatten(tree).map((node) => node.id);
    expect([...ids].sort()).toEqual(["a", "b"]);
    expect(ids).toHaveLength(2); // no duplicates: the display cycle is broken
    expect(client.queryCount).toBeLessThanOrEqual(30);

    // `a` is promoted to a display root to break the loop, so it has no display
    // parent — and its one recorded parent, `b`, must NOT then be announced as
    // its "second parent". On data this corrupt the tree may show less; it may
    // not state something confidently false.
    expect(byId(tree, "a").secondParentInline).toBeNull();
    expect(byId(tree, "a").relationship.description).not.toContain(
      "Second parent",
    );
    expect(byId(tree, "b").secondParentInline).toBeNull();
  });

  it("terminates when a member is recorded as their own parent", async () => {
    const client = db([{ id: "ouro", parentMemberId: "ouro" }], [], {
      queryBudget: 20,
    });
    const tree = (await getMemberFamilyTree(client, "ouro"))!;
    expect(tree.memberCount).toBe(1);
  });

  it("caps the walk at 4 generations vertically from the viewed member", async () => {
    // Over-deep legacy chains: 5 ancestors up and 5 descendants down.
    const seeds: Seed[] = [{ id: "me", parentMemberId: "up1" }];
    for (let i = 1; i <= 5; i += 1) {
      seeds.push({ id: `up${i}`, parentMemberId: i < 5 ? `up${i + 1}` : null });
      seeds.push({
        id: `down${i}`,
        parentMemberId: i === 1 ? "me" : `down${i - 1}`,
      });
    }
    const tree = (await getMemberFamilyTree(db(seeds), "me"))!;

    const ids = flatten(tree).map((node) => node.id);
    expect(ids).toContain("up3");
    expect(ids).toContain("down3");
    expect(ids).not.toContain("up4");
    expect(ids).not.toContain("down4");
    expect(tree.truncated).toBe(true);
    for (const node of flatten(tree)) {
      expect(Math.abs(node.generation)).toBeLessThanOrEqual(
        MAX_PARENT_LINK_CHAIN_LENGTH,
      );
    }
  });

  it("terminates across long horizontal co-parent/partner chains", async () => {
    // Ten households chained sideways: each couple shares a child, and one
    // member of each couple has a partner link into the next household.
    // Partner hops do not increment generation, so only the visited set and
    // size cap bound this shape.
    const seeds: Seed[] = [{ id: "me" }];
    const partners: PartnerSeed[] = [];
    for (let i = 0; i < 10; i += 1) {
      const left = i === 0 ? "me" : `spouse${i}`;
      seeds.push({
        id: `child${i}`,
        parentMemberId: left,
        secondaryParentId: `co${i}`,
      });
      seeds.push({ id: `co${i}` });
      seeds.push({ id: `spouse${i + 1}` });
      partners.push({ a: `co${i}`, b: `spouse${i + 1}` });
    }
    const client = db(seeds, partners, { queryBudget: 150 });
    const tree = (await getMemberFamilyTree(client, "me"))!;

    // The whole chain is reachable and the walk terminated within budget.
    expect(byId(tree, "co9")).toBeDefined();
    expect(byId(tree, "spouse10")).toBeDefined();
    expect(tree.memberCount).toBe(seeds.length);
    for (const node of flatten(tree)) {
      expect([0, 1]).toContain(node.generation);
    }
  });

  it("terminates on an invalid partner-link triangle (first link wins)", async () => {
    const client = db(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      [
        { id: "link-1", a: "a", b: "b" },
        { id: "link-2", a: "b", b: "c" },
        { id: "link-3", a: "c", b: "a" },
      ],
      { queryBudget: 30 },
    );
    const tree = (await getMemberFamilyTree(client, "a"))!;
    // a–b is kept (lowest link id); the conflicting links are ignored, so c is
    // not reachable through any recorded edge.
    expect(flatten(tree).map((node) => node.id).sort()).toEqual(["a", "b"]);
    expect(byId(tree, "a").partner?.id).toBe("b");
  });

  it("stops at the member size cap and reports truncation", async () => {
    const seeds: Seed[] = [{ id: "me" }];
    for (let i = 0; i < MAX_FAMILY_TREE_MEMBERS + 50; i += 1) {
      seeds.push({ id: `kid${String(i).padStart(3, "0")}`, parentMemberId: "me" });
    }
    const tree = (await getMemberFamilyTree(db(seeds), "me"))!;
    expect(tree.memberCount).toBeLessThanOrEqual(MAX_FAMILY_TREE_MEMBERS);
    expect(tree.truncated).toBe(true);
    expect(tree.truncatedReason).toBe("size");
  });

  it("reports truncation when a round lands EXACTLY on the size cap", async () => {
    // The boundary the size cap misses if it is only checked while admitting:
    // one round's candidates fill the tree to exactly MAX_FAMILY_TREE_MEMBERS,
    // so nothing is ever refused, but the frontier those candidates form is
    // never explored — here that hides a whole generation of grandchildren.
    const childCount = MAX_FAMILY_TREE_MEMBERS - 1;
    const seeds: Seed[] = [{ id: "me" }];
    for (let i = 0; i < childCount; i += 1) {
      const kid = `kid${String(i).padStart(3, "0")}`;
      seeds.push({ id: kid, parentMemberId: "me" });
      seeds.push({ id: `grand${String(i).padStart(3, "0")}`, parentMemberId: kid });
    }
    const tree = (await getMemberFamilyTree(db(seeds), "me"))!;

    expect(tree.memberCount).toBe(MAX_FAMILY_TREE_MEMBERS);
    const ids = flatten(tree).map((node) => node.id);
    expect(ids).not.toContain("grand000"); // the unexplored generation
    expect(tree.truncated).toBe(true);
    expect(tree.truncatedReason).toBe("size");
  });

  it("bounds the QUERIES as well as the tree, and says the family is bigger", async () => {
    // 400 dependants: the walk keeps at most MAX_FAMILY_TREE_MEMBERS people, so
    // it must not ASK the database for 400 rows-with-joins to throw most away.
    const seeds: Seed[] = [{ id: "me" }];
    for (let i = 0; i < 400; i += 1) {
      seeds.push({ id: `kid${String(i).padStart(3, "0")}`, parentMemberId: "me" });
    }
    const client = db(seeds);
    const tree = (await getMemberFamilyTree(client, "me"))!;

    // Every open-ended read carries the row cap plus one sentinel row...
    expect(client.openEndedTakes.length).toBeGreaterThan(0);
    for (const take of client.openEndedTakes) {
      expect(take).toBe(MAX_FAMILY_TREE_MEMBERS + 1);
    }
    // ...and no single query was ever allowed to return more than that.
    expect(client.maxRowsReturned).toBeLessThanOrEqual(
      MAX_FAMILY_TREE_MEMBERS + 1,
    );
    // Hitting the cap is reported, not silently rendered as a whole family.
    expect(tree.truncated).toBe(true);
    expect(tree.truncatedReason).toBe("size");
  });

  it("distinguishes a generation-capped family from a size-capped one", async () => {
    const overDeep = (await getMemberFamilyTree(
      db([
        { id: "me", parentMemberId: "up1" },
        { id: "up1", parentMemberId: "up2" },
        { id: "up2", parentMemberId: "up3" },
        { id: "up3", parentMemberId: "up4" },
        { id: "up4" },
      ]),
      "me",
    ))!;
    expect(overDeep.truncatedReason).toBe("generations");

    // Both bounds can bite on the same family; the notice must not pick one.
    // The over-deep chain is walked first (parents lead each round), so the
    // vertical cap fires before great-grandad's 200 other children fill the
    // tree — a family that is at once too tall AND too wide.
    const seeds: Seed[] = [
      { id: "me", parentMemberId: "up1" },
      { id: "up1", parentMemberId: "up2" },
      { id: "up2", parentMemberId: "up3" },
      { id: "up3", parentMemberId: "up4" },
      { id: "up4" },
    ];
    for (let i = 0; i < MAX_FAMILY_TREE_MEMBERS + 50; i += 1) {
      seeds.push({
        id: `aunt${String(i).padStart(3, "0")}`,
        parentMemberId: "up3",
      });
    }
    const both = (await getMemberFamilyTree(db(seeds), "me"))!;
    expect(both.truncatedReason).toBe("both");

    const untruncated = (await getMemberFamilyTree(
      db([{ id: "me", parentMemberId: "p" }, { id: "p" }]),
      "me",
    ))!;
    expect(untruncated.truncated).toBe(false);
    expect(untruncated.truncatedReason).toBeNull();
  });

  it("reports the STORED email-inheritance answer, never a re-derivation", async () => {
    // kid's stored pointer names the grandparent even though kid's direct
    // parent has a perfectly usable address — a re-derivation would answer
    // "p". The tree must repeat the stored answer.
    const tree = (await getMemberFamilyTree(
      db([
        { id: "gp" },
        { id: "p", parentMemberId: "gp" },
        { id: "kid", parentMemberId: "p", inheritEmailFromId: "gp" },
      ]),
      "kid",
    ))!;

    const kid = byId(tree, "kid");
    expect(kid.notificationEmail).toEqual({
      sourceId: "gp",
      sourceName: "gp",
      sourceRelationship: "grandparent",
      beyondDirectParent: true,
      inTree: true,
    });
    expect(byId(tree, "gp").emailRecipientCount).toBe(1);
    expect(byId(tree, "p").notificationEmail).toBeNull();
  });

  it("marks direct-parent inheritance as not beyond the direct parent", async () => {
    const tree = (await getMemberFamilyTree(
      db([
        { id: "p" },
        { id: "kid", parentMemberId: "p", inheritEmailFromId: "p" },
      ]),
      "kid",
    ))!;
    expect(byId(tree, "kid").notificationEmail).toMatchObject({
      sourceId: "p",
      beyondDirectParent: false,
      inTree: true,
    });
  });

  it("never names an email-inheritance source from outside the tree", async () => {
    // #2255 retired the family-link constraint on inheritance sources, so an
    // admin can point a member's club email at ANY member. Naming that member
    // here would assert a family connection the database does not record — and
    // would leak an unrelated member's name onto this family's card.
    const tree = (await getMemberFamilyTree(
      db([
        { id: "p" },
        { id: "kid", parentMemberId: "p", inheritEmailFromId: "treasurer" },
        // Connected to nobody in kid's family.
        { id: "treasurer" },
      ]),
      "kid",
    ))!;

    const kid = byId(tree, "kid");
    expect(flatten(tree).map((node) => node.id)).not.toContain("treasurer");
    expect(kid.notificationEmail).toEqual({
      sourceId: null,
      sourceName: null,
      sourceRelationship: null,
      beyondDirectParent: true,
      inTree: false,
    });
    // The sr-only sentence states the fact without identifying anyone.
    expect(kid.relationship.description).toContain(
      "Club email goes to a member outside this family tree.",
    );
    expect(kid.relationship.description).not.toContain("treasurer");
  });

  it("lists family groups per member and flags the billing family", async () => {
    const tree = (await getMemberFamilyTree(
      db([
        {
          id: "me",
          familyGroups: ["g1", "g2"],
          billingFamilyGroupId: "g2",
        },
      ]),
      "me",
    ))!;
    expect(byId(tree, "me").familyGroups).toEqual([
      { id: "g1", name: "Group g1", billing: false },
      { id: "g2", name: "Group g2", billing: true },
    ]);
  });

  it("renders a member in more than one family group once, with both chips", async () => {
    const tree = (await getMemberFamilyTree(
      db(
        [
          { id: "me", familyGroups: ["g1"] },
          { id: "kate", familyGroups: ["g2"] },
          {
            id: "kid",
            parentMemberId: "me",
            secondaryParentId: "kate",
            familyGroups: ["g1", "g2"],
          },
        ],
        [{ a: "me", b: "kate" }],
      ),
      "me",
    ))!;
    const ids = flatten(tree).map((node) => node.id);
    expect(ids.filter((id) => id === "kid")).toHaveLength(1);
    expect(byId(tree, "kid").familyGroups.map((group) => group.id)).toEqual([
      "g1",
      "g2",
    ]);
  });
});
