import type { Prisma } from "@prisma/client";
import type { prisma } from "@/lib/prisma";
import { MAX_PARENT_LINK_CHAIN_LENGTH } from "@/lib/member-family-link-depth";

/**
 * Read-only membership family tree (#2253, owner decisions on the issue).
 *
 * Derives the WHOLE CONNECTED FAMILY GRAPH for one member — every recorded
 * parent / second-parent link and every CONFIRMED partner link, followed
 * transitively across households — and shapes it as a display forest for the
 * admin member page's Family card. Nothing here is stored: the tree is a VIEW
 * of `Member.parentMemberId` / `Member.secondaryParentId` /
 * `MemberPartnerLink` and must never become a second place to edit them.
 *
 * BOUNDS. The link graph can contain cycles (bad legacy data can make a member
 * their own ancestor; partner links plus shared children legitimately close
 * loops), so the walk is belt-and-braces bounded:
 *
 *  1. A visited set — each member is admitted once, at the generation it was
 *     first reached, so no cycle can be walked twice.
 *  2. A vertical cap of {@link MAX_PARENT_LINK_CHAIN_LENGTH} parent-links
 *     above and below the viewed member — i.e. at most
 *     `MAX_FAMILY_LINK_GENERATIONS` generations counting the root's own, in
 *     each vertical direction, applying #2255's cap to the walk itself.
 *     Partner hops never change generation, so sideways travel cannot smuggle
 *     the walk past the cap by zig-zagging up through another household.
 *  3. A total size cap of {@link MAX_FAMILY_TREE_MEMBERS} members, so a
 *     pathological graph (or a partner-hop chain across many households)
 *     terminates even though partner hops are generation-free.
 *  4. Bounds on the QUERIES themselves, not just on the tree they build. The
 *     two open-ended reads per round (a frontier's children, a frontier's
 *     partner links) take at most `MAX_FAMILY_TREE_MEMBERS + 1` rows, so a
 *     member with hundreds of recorded dependants never materialises hundreds
 *     of joined rows to keep a capped handful; and the number of BFS ROUNDS is
 *     explicitly capped, so the number of SEQUENTIAL queries one request can
 *     issue is bounded by the code rather than only by how the admission rules
 *     happen to behave.
 *
 * Anything cut off by bound 2, 3 or 4 sets `truncated`, which the card states
 * rather than silently pretending the family ends there, and `truncatedReason`
 * says WHICH kind of bound fired so the card can word it truthfully.
 *
 * PRIVACY. The tree reports names, relationship structure, badges, and — only
 * for non-archived members — the email address the admin member page already
 * shows. It exposes no field beyond what `membership:view` already exposes:
 * `/api/admin/members` returns the same email at the same permission.
 *
 * Archived members stay in the tree (dropping them would make a grandparent
 * look unrelated) and their contact details are left off the node. That is a
 * PRESENTATION choice (decision 4) matching how the member page treats an
 * archived member's contacts — not a privacy boundary, and it should not be
 * relied on as one.
 *
 * The email-inheritance line is the one genuine gate here. It reports the
 * STORED #2255 resolver answer (`Member.inheritEmailFromId`, which the resolver
 * keeps flat-terminal) — it never re-derives its own answer, so the tree can
 * never disagree with what the club actually sends — but it only NAMES the
 * mailbox holder when that member is inside this tree. #2255 retired the
 * family-link constraint on inheritance sources, so an admin can point a
 * member's club email at any member club-wide; naming an unrelated member on
 * this member's family card would assert a family connection the data does not
 * record. An out-of-tree source is reported without id or name.
 */

type FamilyTreeClient = Prisma.TransactionClient | typeof prisma;

/**
 * Hard ceiling on how many members one tree may contain. Generous — a real
 * four-generation multi-household family is a few dozen people — but present
 * so the generation-free partner hops (bound 3 above) always terminate.
 */
export const MAX_FAMILY_TREE_MEMBERS = 150;

/**
 * Hard ceiling on how many BFS rounds the walk may run — i.e. on how many
 * SEQUENTIAL round-trips one request can issue (three queries per round).
 *
 * Today the size cap already implies this bound: a round either admits at least
 * one new member or leaves the frontier empty and ends the walk, so the walk
 * cannot outlive {@link MAX_FAMILY_TREE_MEMBERS} rounds. The cap is stated
 * anyway, and enforced with its own `truncated` flag, so the query count stays
 * bounded by something explicit rather than by an emergent property of the
 * admission rules that a later change could quietly remove.
 *
 * It is deliberately NOT tightened below the member cap: partner hops are
 * generation-free, so a genuine chain of households can legitimately need one
 * round per member (the horizontal-chain test walks ~30 rounds for 31 people),
 * and a tighter bound would truncate real families to save queries.
 */
const MAX_FAMILY_TREE_ROUNDS = MAX_FAMILY_TREE_MEMBERS;

const FAMILY_TREE_MEMBER_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  ageTier: true,
  active: true,
  canLogin: true,
  archivedAt: true,
  cancelledAt: true,
  parentMemberId: true,
  secondaryParentId: true,
  inheritEmailFromId: true,
  inheritEmailFrom: { select: { id: true, firstName: true, lastName: true } },
  billingFamilyGroupId: true,
  familyGroupMemberships: {
    select: {
      familyGroupId: true,
      familyGroup: { select: { id: true, name: true } },
    },
  },
} as const;

type FamilyTreeMemberRecord = {
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
  inheritEmailFrom: { id: string; firstName: string; lastName: string } | null;
  billingFamilyGroupId: string | null;
  familyGroupMemberships: Array<{
    familyGroupId: string;
    familyGroup: { id: string; name: string | null } | null;
  }>;
};

type ParentLinkKind = "PRIMARY" | "SECONDARY";

export type FamilyTreeRelationship = {
  /** Short label rendered on the node, e.g. "Parent", "Half-sibling". */
  label: string;
  /**
   * True when the relationship to the viewed member is worked out from the
   * links rather than being one of their own recorded links (their parents,
   * their dependants, their confirmed partner). Derived nodes render with the
   * dashed "derived, not stored" treatment.
   */
  derived: boolean;
  /**
   * Short VISIBLE qualifier rendered beside the label when the label alone
   * would overstate what the data records — e.g. "one parent not recorded for
   * Ruby Ngata" beside "Half-sibling", where the two members share every parent
   * one of them actually has and the label is an artefact of a missing record
   * rather than a statement about the family.
   */
  qualifier: string | null;
  /** Full sr-only sentence for the node. */
  description: string;
};

export type FamilyTreeNode = {
  id: string;
  name: string;
  ageTier: string;
  active: boolean;
  canLogin: boolean;
  archived: boolean;
  cancelled: boolean;
  isRoot: boolean;
  /** Generations from the viewed member: negative = older, positive = younger. */
  generation: number;
  relationship: FamilyTreeRelationship;
  /** How this node hangs off the node above it in the rendered list. */
  linkToDisplayParent: ParentLinkKind | null;
  /** Suppressed (null) for archived members — decision 4. */
  email: string | null;
  /** How many OTHER tree members' club email is this member's address. */
  emailRecipientCount: number;
  /**
   * The stored #2255 resolver answer for this member, reported verbatim.
   * `beyondDirectParent` mirrors the mockup rule: badge-worthy only when the
   * mailbox is NOT one of the member's own recorded parents.
   *
   * The mailbox holder is IDENTIFIED only when they are in this tree
   * (`inTree`). #2255 allows any member club-wide as an inheritance source, and
   * naming an unconnected member on a family card would assert a family
   * connection that is not recorded — so an out-of-tree source arrives as a
   * name-free marker and the card says only that the email leaves the tree.
   */
  notificationEmail: {
    /** Null when the mailbox holder is not in this tree. */
    sourceId: string | null;
    /** Null when the mailbox holder is not in this tree. */
    sourceName: string | null;
    /** e.g. "grandparent" when the source is in the tree; null otherwise. */
    sourceRelationship: string | null;
    beyondDirectParent: boolean;
    /** True when the mailbox holder is a member of this tree. */
    inTree: boolean;
  } | null;
  /** The recorded parent NOT used as this node's position in the list. */
  secondParentInline: { id: string; name: string } | null;
  /** Confirmed partner, when the partner is in the tree. */
  partner: { id: string; name: string; attachedHere: boolean } | null;
  /** Partner rendered beside this node (double-rule treatment). */
  attachedPartner: FamilyTreeNode | null;
  familyGroups: Array<{ id: string; name: string | null; billing: boolean }>;
  children: FamilyTreeNode[];
};

/**
 * Which bound cut the walk short. `generations` = the vertical cap; `size` =
 * the member cap, the per-round row cap, or the round cap (all "this family is
 * bigger than the tree shows"); `both` = at least one of each.
 */
export type FamilyTreeTruncationReason = "generations" | "size" | "both";

export type MemberFamilyTree = {
  root: { id: string; name: string };
  roots: FamilyTreeNode[];
  memberCount: number;
  /** Distinct generation span rendered, e.g. 4 for great-grandparent → child. */
  generationSpan: number;
  /** True when the vertical cap or the size cap cut reachable members off. */
  truncated: boolean;
  /** Which bound fired, so the card words the notice truthfully. */
  truncatedReason: FamilyTreeTruncationReason | null;
  /** True when at least one rendered relationship is derived-not-stored. */
  hasDerivedRelationships: boolean;
};

type GraphNode = {
  record: FamilyTreeMemberRecord;
  generation: number;
  /** Discovery order — the deterministic tie-break everywhere below. */
  index: number;
};

type FamilyGraph = {
  rootId: string;
  nodes: Map<string, GraphNode>;
  /** memberId -> confirmed partner's memberId (both directions present). */
  partnerOf: Map<string, string>;
  truncated: boolean;
  truncatedReason: FamilyTreeTruncationReason | null;
};

function displayName(member: { firstName: string; lastName: string }): string {
  return `${member.firstName} ${member.lastName}`.trim();
}

/**
 * Walk the whole connected family graph from `rootId`. Cycle-safe via the
 * visited map; vertically bounded to ±{@link MAX_PARENT_LINK_CHAIN_LENGTH}
 * generations from the root; size-bounded by {@link MAX_FAMILY_TREE_MEMBERS}.
 *
 * Each member enters the frontier exactly once, and each frontier round asks
 * three batched questions: the frontier's parents (by id), its children (by
 * parent column), and its CONFIRMED partner links. Because every member is in
 * the frontier exactly once, every member's partner links are seen exactly
 * once — so partner-hop chains terminate with the visited map alone.
 */
async function collectFamilyGraph(
  db: FamilyTreeClient,
  rootId: string,
): Promise<FamilyGraph | null> {
  const rootRecord = (await db.member.findUnique({
    where: { id: rootId },
    select: FAMILY_TREE_MEMBER_SELECT,
  })) as FamilyTreeMemberRecord | null;
  if (!rootRecord) return null;

  const nodes = new Map<string, GraphNode>();
  nodes.set(rootId, { record: rootRecord, generation: 0, index: 0 });
  const partnerOf = new Map<string, string>();
  // Tracked separately so the card can say WHICH bound bit; both can fire on
  // the same walk (a wide family that is also over-deep).
  let truncatedByGenerations = false;
  let truncatedBySize = false;
  let nextIndex = 1;

  let frontier: string[] = [rootId];
  let rounds = 0;

  while (frontier.length > 0 && nodes.size < MAX_FAMILY_TREE_MEMBERS) {
    if (rounds >= MAX_FAMILY_TREE_ROUNDS) {
      // Belt-and-braces query bound (see MAX_FAMILY_TREE_ROUNDS): unreachable
      // while a round must admit a member to continue, but it keeps the number
      // of sequential queries a bounded property of THIS loop.
      truncatedBySize = true;
      break;
    }
    rounds += 1;

    // Candidate ids for this round, in a deterministic discovery order:
    // parents of each frontier member (primary before secondary), then
    // partners, then children (name-ordered by the query). First discovery
    // fixes a candidate's generation — a member reachable at two generations
    // through inconsistent data keeps the one nearest the root.
    const candidateGeneration = new Map<string, number>();
    const candidateOrder: string[] = [];
    const addCandidate = (id: string, generation: number) => {
      if (nodes.has(id) || candidateGeneration.has(id)) return;
      if (Math.abs(generation) > MAX_PARENT_LINK_CHAIN_LENGTH) {
        // Vertical cap (#2255 applied to the walk): a member more than
        // MAX_PARENT_LINK_CHAIN_LENGTH parent-links above or below the viewed
        // member is out of reach, and the card says so via `truncated`.
        truncatedByGenerations = true;
        return;
      }
      candidateGeneration.set(id, generation);
      candidateOrder.push(id);
    };

    for (const id of frontier) {
      const node = nodes.get(id);
      if (!node) continue;
      if (node.record.parentMemberId) {
        addCandidate(node.record.parentMemberId, node.generation - 1);
      }
      if (node.record.secondaryParentId) {
        addCandidate(node.record.secondaryParentId, node.generation - 1);
      }
    }

    const partnerLinks = (await db.memberPartnerLink.findMany({
      where: {
        status: "CONFIRMED",
        OR: [{ memberAId: { in: frontier } }, { memberBId: { in: frontier } }],
      },
      select: { id: true, memberAId: true, memberBId: true },
      orderBy: { id: "asc" },
      // Bound the READ, not just the tree built from it. The extra row is the
      // "there was more" sentinel; the deterministic id ordering makes the
      // rows we keep the same rows on every request.
      take: MAX_FAMILY_TREE_MEMBERS + 1,
    })) as Array<{ id: string; memberAId: string; memberBId: string }>;
    if (partnerLinks.length > MAX_FAMILY_TREE_MEMBERS) truncatedBySize = true;

    for (const link of partnerLinks) {
      // The service layer allows at most one CONFIRMED partner per member;
      // first-link-wins (by link id order) keeps this deterministic even on
      // data that breaches that invariant.
      if (partnerOf.has(link.memberAId) || partnerOf.has(link.memberBId)) {
        continue;
      }
      partnerOf.set(link.memberAId, link.memberBId);
      partnerOf.set(link.memberBId, link.memberAId);
      const anchor = nodes.get(link.memberAId) ?? nodes.get(link.memberBId);
      if (!anchor) continue;
      const otherId = nodes.has(link.memberAId) ? link.memberBId : link.memberAId;
      // Partner hop: same generation, no vertical movement.
      addCandidate(otherId, anchor.generation);
    }

    const childRows = (await db.member.findMany({
      where: {
        OR: [
          { parentMemberId: { in: frontier } },
          { secondaryParentId: { in: frontier } },
        ],
      },
      select: FAMILY_TREE_MEMBER_SELECT,
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }, { id: "asc" }],
      // Same reason as the partner-link read: a member with 400 recorded
      // dependants must not materialise 400 joined rows so the walk can admit
      // a capped handful of them. Deterministic order, plus a sentinel row.
      take: MAX_FAMILY_TREE_MEMBERS + 1,
    })) as FamilyTreeMemberRecord[];
    if (childRows.length > MAX_FAMILY_TREE_MEMBERS) truncatedBySize = true;

    const recordById = new Map<string, FamilyTreeMemberRecord>();
    for (const child of childRows) {
      recordById.set(child.id, child);
      // A child sits one generation below whichever of its recorded parents is
      // already placed — the primary parent's placement wins when both are.
      const viaPrimary = child.parentMemberId
        ? nodes.get(child.parentMemberId)
        : undefined;
      const viaSecondary = child.secondaryParentId
        ? nodes.get(child.secondaryParentId)
        : undefined;
      const parentNode = viaPrimary ?? viaSecondary;
      if (!parentNode) continue;
      addCandidate(child.id, parentNode.generation + 1);
    }

    // Fetch the records the child query did not already return (parents and
    // partners are known only by id so far). This read needs no `take` of its
    // own: it is an `id IN (...)` over `candidateOrder`, which is itself
    // bounded — at most two parents per frontier member plus the two capped
    // reads above — so it can never fan out beyond a few hundred rows.
    const missingIds = candidateOrder.filter((id) => !recordById.has(id));
    if (missingIds.length > 0) {
      const rows = (await db.member.findMany({
        where: { id: { in: missingIds } },
        select: FAMILY_TREE_MEMBER_SELECT,
      })) as FamilyTreeMemberRecord[];
      for (const row of rows) recordById.set(row.id, row);
    }

    const added: string[] = [];
    for (const id of candidateOrder) {
      if (nodes.size >= MAX_FAMILY_TREE_MEMBERS) {
        truncatedBySize = true;
        break;
      }
      const record = recordById.get(id);
      // A dangling parent id (SetNull raced, or a fetch miss) is skipped, not
      // fatal: the tree renders what exists.
      if (!record) continue;
      nodes.set(id, {
        record,
        generation: candidateGeneration.get(id) ?? 0,
        index: nextIndex,
      });
      nextIndex += 1;
      added.push(id);
    }

    frontier = added;
  }

  // The size cap can also bite WITHOUT the admission loop breaking: when a
  // round's candidates land exactly on MAX_FAMILY_TREE_MEMBERS, every candidate
  // is admitted, `added` is non-empty, and the outer `while` then exits on the
  // size condition — leaving a frontier whose parents, partners and children
  // were never asked for. Without this the tree would claim to be complete
  // while an entire generation below it is missing.
  if (frontier.length > 0 && nodes.size >= MAX_FAMILY_TREE_MEMBERS) {
    truncatedBySize = true;
  }

  const truncatedReason: FamilyTreeTruncationReason | null =
    truncatedByGenerations && truncatedBySize
      ? "both"
      : truncatedByGenerations
        ? "generations"
        : truncatedBySize
          ? "size"
          : null;

  return {
    rootId,
    nodes,
    partnerOf,
    truncated: truncatedReason !== null,
    truncatedReason,
  };
}

/**
 * Minimum parent-link distance from `startId` up to each in-graph ancestor.
 * Bounded by the chain cap and a visited set, so cyclic data terminates; the
 * MINIMUM distance is deliberate — for naming a relationship the closest
 * reading is the honest one (the depth-cap lib wants the maximum for the
 * opposite reason: refusing links).
 */
function ancestorDepths(
  graph: FamilyGraph,
  startId: string,
): Map<string, number> {
  const depths = new Map<string, number>();
  const visited = new Set<string>([startId]);
  let frontier = [startId];
  for (
    let depth = 1;
    depth <= MAX_PARENT_LINK_CHAIN_LENGTH && frontier.length > 0;
    depth += 1
  ) {
    const next: string[] = [];
    for (const id of frontier) {
      const node = graph.nodes.get(id);
      if (!node) continue;
      for (const parentId of [
        node.record.parentMemberId,
        node.record.secondaryParentId,
      ]) {
        if (!parentId || visited.has(parentId)) continue;
        visited.add(parentId);
        if (graph.nodes.has(parentId)) {
          depths.set(parentId, depth);
          next.push(parentId);
        }
      }
    }
    frontier = next;
  }
  return depths;
}

const ANCESTOR_LABELS = ["", "Parent", "Grandparent", "Great-grandparent"];
const DESCENDANT_LABELS = ["", "Child", "Grandchild", "Great-grandchild"];

const COLLATERAL_LABELS: Record<string, string> = {
  "2,1": "Aunt or uncle",
  "3,1": "Great-aunt or great-uncle",
  "1,2": "Niece or nephew",
  "1,3": "Great-niece or great-nephew",
  "2,2": "Cousin",
  "3,2": "Parent's cousin",
  "2,3": "Cousin's child",
  "3,3": "Second cousin",
};

function recordedParentIds(record: FamilyTreeMemberRecord): Set<string> {
  const ids = new Set<string>();
  if (record.parentMemberId) ids.add(record.parentMemberId);
  if (record.secondaryParentId) ids.add(record.secondaryParentId);
  return ids;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/** True when every member of `a` is in `b` and `b` has at least one more. */
function isProperSubset(a: Set<string>, b: Set<string>): boolean {
  if (a.size >= b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

type BloodRelation = {
  label: string;
  /** Shared parents, for the sibling / half-sibling sr-only derivation. */
  sharedParentIds: string[];
  /**
   * Set when "Half-sibling" comes out of an INCOMPLETE record rather than a
   * genuinely different parentage: one member's recorded parents are a proper
   * subset of the other's, so the two share every parent the smaller record
   * actually names. This is the likely real-data shape — one-sided parent
   * records are common — and "Half-sibling" is a socially loaded thing to
   * assert on it, so the id of the member with the incomplete record travels
   * out to be disclosed on the node.
   */
  incompleteParentRecordFor: string | null;
};

/**
 * Blood relationship of `b` relative to `a` ("b is a's <label>"), or null when
 * no parent-link path connects them within the graph. Sibling vs half-sibling
 * follows the mockup rule: it compares WHICH parents are shared, not how many
 * — identical recorded parent sets are siblings, an overlapping-but-different
 * set is a half-sibling.
 */
function bloodRelation(
  graph: FamilyGraph,
  depthsById: Map<string, Map<string, number>>,
  aId: string,
  bId: string,
): BloodRelation | null {
  if (aId === bId) {
    return { label: "Self", sharedParentIds: [], incompleteParentRecordFor: null };
  }
  const aDepths = depthsById.get(aId);
  const bDepths = depthsById.get(bId);
  if (!aDepths || !bDepths) return null;

  const upToB = aDepths.get(bId);
  if (upToB !== undefined && upToB < ANCESTOR_LABELS.length) {
    return {
      label: ANCESTOR_LABELS[upToB],
      sharedParentIds: [],
      incompleteParentRecordFor: null,
    };
  }
  const downToB = bDepths.get(aId);
  if (downToB !== undefined && downToB < DESCENDANT_LABELS.length) {
    return {
      label: DESCENDANT_LABELS[downToB],
      sharedParentIds: [],
      incompleteParentRecordFor: null,
    };
  }

  // Closest common ancestor: minimise total distance, then the distance on the
  // viewed member's side, then ancestor id — all deterministic.
  let best: { u: number; d: number; ancestorId: string } | null = null;
  for (const [ancestorId, u] of aDepths) {
    const d = bDepths.get(ancestorId);
    if (d === undefined) continue;
    if (
      !best ||
      u + d < best.u + best.d ||
      (u + d === best.u + best.d &&
        (u < best.u || (u === best.u && ancestorId < best.ancestorId)))
    ) {
      best = { u, d, ancestorId };
    }
  }
  if (!best) return null;

  if (best.u === 1 && best.d === 1) {
    const aParents = recordedParentIds(graph.nodes.get(aId)!.record);
    const bParents = recordedParentIds(graph.nodes.get(bId)!.record);
    const shared = [...aParents].filter((id) => bParents.has(id));
    const equal = setsEqual(aParents, bParents);
    // The rule itself is owner-decided and stays exactly as decided: a
    // different recorded parent SET is a half-sibling. What changes here is
    // only honesty about WHY — a proper subset means the label is driven by a
    // missing record on one side, not by a recorded second parentage.
    let incompleteParentRecordFor: string | null = null;
    if (!equal) {
      if (isProperSubset(aParents, bParents)) incompleteParentRecordFor = aId;
      else if (isProperSubset(bParents, aParents)) {
        incompleteParentRecordFor = bId;
      }
    }
    return {
      label: equal ? "Sibling" : "Half-sibling",
      sharedParentIds: shared,
      incompleteParentRecordFor,
    };
  }

  const label = COLLATERAL_LABELS[`${best.u},${best.d}`];
  return label
    ? { label, sharedParentIds: [], incompleteParentRecordFor: null }
    : null;
}

type RelationshipKind =
  | "self"
  | "stored-parent"
  | "stored-child"
  | "stored-partner"
  | "blood"
  | "affinity"
  | "unknown";

type ResolvedRelationship = {
  kind: RelationshipKind;
  label: string;
  sharedParentIds: string[];
  /** Visible caveat rendered beside the label; see FamilyTreeRelationship. */
  qualifier: string | null;
};

/**
 * Label every graph member relative to the root. Stored relationships (the
 * root's own recorded parents, dependants, and confirmed partner) win first;
 * then blood relationships via parent-link paths; then affinity rules applied
 * to a fixpoint (co-parents, partners of labelled members, relatives of the
 * root's partner, parents/children of labelled members); anything still
 * unlabelled — reachable only through chains of marriages the rules do not
 * name — is "Extended family".
 */
function resolveRelationships(
  graph: FamilyGraph,
): Map<string, ResolvedRelationship> {
  const root = graph.nodes.get(graph.rootId)!;
  const depthsById = new Map<string, Map<string, number>>();
  for (const id of graph.nodes.keys()) {
    depthsById.set(id, ancestorDepths(graph, id));
  }

  const resolved = new Map<string, ResolvedRelationship>();
  resolved.set(graph.rootId, {
    kind: "self",
    label: "This member",
    sharedParentIds: [],
    qualifier: null,
  });

  const rootParents = recordedParentIds(root.record);
  const ordered = [...graph.nodes.values()].sort((a, b) => a.index - b.index);

  for (const node of ordered) {
    if (resolved.has(node.record.id)) continue;
    const id = node.record.id;

    if (rootParents.has(id)) {
      resolved.set(id, {
        kind: "stored-parent",
        label: root.record.parentMemberId === id ? "Parent" : "Second parent",
        sharedParentIds: [],
        qualifier: null,
      });
      continue;
    }
    if (recordedParentIds(node.record).has(graph.rootId)) {
      resolved.set(id, {
        kind: "stored-child",
        label: "Dependant",
        sharedParentIds: [],
        qualifier: null,
      });
      continue;
    }
    if (graph.partnerOf.get(graph.rootId) === id) {
      resolved.set(id, {
        kind: "stored-partner",
        label: "Partner",
        sharedParentIds: [],
        qualifier: null,
      });
      continue;
    }

    const blood = bloodRelation(graph, depthsById, graph.rootId, id);
    if (blood) {
      resolved.set(id, {
        kind: "blood",
        label: blood.label,
        sharedParentIds: blood.sharedParentIds,
        qualifier: incompleteParentQualifier(graph, blood),
      });
    }
  }

  // Affinity passes, repeated until no node gains a label. Each rule may
  // reference labels resolved by earlier passes, which is what lets a chain
  // like "sibling's partner's parent" resolve step by step.
  const affinity = (id: string): ResolvedRelationship | null => {
    const node = graph.nodes.get(id)!;

    // Co-parent: shares a recorded child with the viewed member.
    for (const other of ordered) {
      const parents = recordedParentIds(other.record);
      if (parents.has(id) && parents.has(graph.rootId)) {
        return {
          kind: "affinity",
          label: `Co-parent of ${other.record.firstName}`,
          sharedParentIds: [],
          qualifier: null,
        };
      }
    }

    // Partner of an already-labelled member.
    const partnerId = graph.partnerOf.get(id);
    if (partnerId && resolved.has(partnerId) && graph.nodes.has(partnerId)) {
      const partner = graph.nodes.get(partnerId)!;
      return {
        kind: "affinity",
        label: `${displayName(partner.record)}'s partner`,
        sharedParentIds: [],
        qualifier: null,
      };
    }

    // Blood relative of the root's confirmed partner.
    const rootPartnerId = graph.partnerOf.get(graph.rootId);
    if (rootPartnerId && graph.nodes.has(rootPartnerId)) {
      const viaPartner = bloodRelation(
        graph,
        depthsById,
        rootPartnerId,
        id,
      );
      if (viaPartner && viaPartner.label !== "Self") {
        const partner = graph.nodes.get(rootPartnerId)!;
        return {
          kind: "affinity",
          label: `${displayName(partner.record)}'s ${viaPartner.label.toLowerCase()}`,
          sharedParentIds: [],
          qualifier: incompleteParentQualifier(graph, viaPartner),
        };
      }
    }

    // Recorded parent or child of an already-labelled member.
    for (const other of ordered) {
      if (!resolved.has(other.record.id)) continue;
      if (recordedParentIds(other.record).has(id)) {
        return {
          kind: "affinity",
          label: `${displayName(other.record)}'s parent`,
          sharedParentIds: [],
          qualifier: null,
        };
      }
      if (recordedParentIds(node.record).has(other.record.id)) {
        return {
          kind: "affinity",
          label: `${displayName(other.record)}'s child`,
          sharedParentIds: [],
          qualifier: null,
        };
      }
    }

    return null;
  };

  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const node of ordered) {
      if (resolved.has(node.record.id)) continue;
      const result = affinity(node.record.id);
      if (result) {
        resolved.set(node.record.id, result);
        progressed = true;
      }
    }
  }

  for (const node of ordered) {
    if (!resolved.has(node.record.id)) {
      resolved.set(node.record.id, {
        kind: "unknown",
        label: "Extended family",
        sharedParentIds: [],
        qualifier: null,
      });
    }
  }

  return resolved;
}

/**
 * The VISIBLE caveat for a "Half-sibling" that comes out of a one-sided parent
 * record. It names the member whose record is incomplete, because "one parent
 * not recorded" is meaningless without knowing whose — and with optional
 * second-parent records this is the likely real-data reading of the label, not
 * an edge case.
 */
function incompleteParentQualifier(
  graph: FamilyGraph,
  blood: BloodRelation,
): string | null {
  const id = blood.incompleteParentRecordFor;
  if (!id) return null;
  const node = graph.nodes.get(id);
  if (!node) return null;
  return `one parent not recorded for ${displayName(node.record)}`;
}

function describeRelationship(
  graph: FamilyGraph,
  relationship: ResolvedRelationship,
  node: GraphNode,
  extras: string[],
): string {
  const root = graph.nodes.get(graph.rootId)!;
  const rootName = displayName(root.record);
  const name = displayName(node.record);

  let base: string;
  switch (relationship.kind) {
    case "self":
      base = `${name} — the member you are viewing.`;
      break;
    case "stored-parent":
      base = `${name} is ${rootName}'s recorded ${relationship.label.toLowerCase()}.`;
      break;
    case "stored-child":
      base = `${name} is a recorded dependant of ${rootName}.`;
      break;
    case "stored-partner":
      base = `${name} is ${rootName}'s confirmed partner.`;
      break;
    case "blood": {
      base = `${name} is ${rootName}'s ${relationship.label.toLowerCase()} — worked out from the recorded parent links, not stored.`;
      break;
    }
    default:
      base = `${name} is connected to ${rootName}'s family as ${relationship.label.toLowerCase()} — worked out from the recorded links, not stored.`;
      break;
  }

  const sharedNames = relationship.sharedParentIds
    .map((id) => graph.nodes.get(id))
    .filter((shared): shared is GraphNode => Boolean(shared))
    .map((shared) => displayName(shared.record));
  if (sharedNames.length > 0) {
    base += ` Shares ${sharedNames.length === 1 ? "parent" : "parents"} ${sharedNames.join(" and ")}.`;
  }
  if (relationship.qualifier) {
    base += ` ${relationship.qualifier.charAt(0).toUpperCase()}${relationship.qualifier.slice(1)}.`;
  }

  return [base, ...extras].join(" ");
}

/**
 * Position every member in a render forest. Each member appears exactly once:
 * nested under its primary parent when that parent is in the tree (second
 * parent named inline, per the mockup), else under its secondary parent, else
 * attached beside its confirmed partner (the married-in case), else as a
 * forest root. Display cycles from corrupt parent data are broken by
 * promoting the first unreachable member (discovery order) to a root and
 * detaching it from its parent, repeated until everyone is reachable — so a
 * parent loop renders both members once instead of recursing or vanishing.
 */
function buildForest(graph: FamilyGraph): {
  rootIds: string[];
  displayParentOf: Map<string, { parentId: string; link: ParentLinkKind }>;
  attachedTo: Map<string, string>;
  /**
   * Members promoted to forest roots by the cycle break — i.e. members that DO
   * have a recorded in-tree parent which the display deliberately ignores. The
   * caller needs this: without it, "the recorded parent that is not this node's
   * display parent" reads a promoted node's genuine PRIMARY parent as its
   * "Second parent", which is a confident lie told on already-corrupt data.
   */
  cyclePromoted: Set<string>;
} {
  const displayParentOf = new Map<
    string,
    { parentId: string; link: ParentLinkKind }
  >();
  const attachedTo = new Map<string, string>();
  const cyclePromoted = new Set<string>();
  const ordered = [...graph.nodes.values()].sort((a, b) => a.index - b.index);

  for (const node of ordered) {
    const { record } = node;
    if (record.parentMemberId && graph.nodes.has(record.parentMemberId)) {
      displayParentOf.set(record.id, {
        parentId: record.parentMemberId,
        link: "PRIMARY",
      });
    } else if (
      record.secondaryParentId &&
      graph.nodes.has(record.secondaryParentId)
    ) {
      displayParentOf.set(record.id, {
        parentId: record.secondaryParentId,
        link: "SECONDARY",
      });
    }
  }

  for (const node of ordered) {
    const id = node.record.id;
    if (displayParentOf.has(id)) continue;
    const partnerId = graph.partnerOf.get(id);
    if (!partnerId || !graph.nodes.has(partnerId)) continue;
    if (id === graph.rootId) continue; // the viewed member anchors, never attaches
    const partner = graph.nodes.get(partnerId)!;
    const partnerAnchors =
      displayParentOf.has(partnerId) ||
      partnerId === graph.rootId ||
      (!displayParentOf.has(partnerId) && partner.index < node.index);
    if (partnerAnchors && !attachedTo.has(partnerId)) {
      attachedTo.set(id, partnerId);
    }
  }

  const computeRoots = () =>
    ordered
      .map((node) => node.record.id)
      .filter((id) => !displayParentOf.has(id) && !attachedTo.has(id));

  const childrenOf = new Map<string, string[]>();
  const rebuildChildren = () => {
    childrenOf.clear();
    for (const node of ordered) {
      const parent = displayParentOf.get(node.record.id);
      if (!parent) continue;
      const list = childrenOf.get(parent.parentId) ?? [];
      list.push(node.record.id);
      childrenOf.set(parent.parentId, list);
    }
  };

  // Cycle-break loop: bounded by the member count because every pass either
  // reaches everyone or permanently promotes one member to a root.
  for (let pass = 0; pass < graph.nodes.size; pass += 1) {
    rebuildChildren();
    const reachable = new Set<string>();
    const stack = computeRoots();
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const childId of childrenOf.get(id) ?? []) stack.push(childId);
      for (const [attachedId, anchorId] of attachedTo) {
        if (anchorId === id) stack.push(attachedId);
      }
    }
    const unreached = ordered.find((node) => !reachable.has(node.record.id));
    if (!unreached) break;
    if (displayParentOf.has(unreached.record.id)) {
      cyclePromoted.add(unreached.record.id);
    }
    displayParentOf.delete(unreached.record.id);
    attachedTo.delete(unreached.record.id);
  }

  const roots = computeRoots().sort((a, b) => {
    const nodeA = graph.nodes.get(a)!;
    const nodeB = graph.nodes.get(b)!;
    if (nodeA.generation !== nodeB.generation) {
      return nodeA.generation - nodeB.generation;
    }
    return nodeA.index - nodeB.index;
  });

  return { rootIds: roots, displayParentOf, attachedTo, cyclePromoted };
}

/**
 * The read-only family tree for one member, or null when the member does not
 * exist. Admin-only (decision 1): the caller gates on membership:view, and the
 * tree returns no field beyond what `membership:view` already exposes — the
 * same names, badges, family groups and email addresses that the member pages
 * and `/api/admin/members` already return at that permission. What it changes
 * is convenience and reach, not the field set: one call assembles a picture an
 * admin previously assembled by navigating member pages one at a time.
 */
export async function getMemberFamilyTree(
  db: FamilyTreeClient,
  memberId: string,
): Promise<MemberFamilyTree | null> {
  const collected = await collectFamilyGraph(db, memberId);
  if (!collected) return null;
  // Alias after the null-guard: `serialize` below is a hoisted declaration, so
  // TypeScript will not carry the narrowing into it.
  const graph: FamilyGraph = collected;

  const relationships = resolveRelationships(graph);
  const { rootIds, displayParentOf, attachedTo, cyclePromoted } =
    buildForest(graph);
  const depthsById = new Map<string, Map<string, number>>();
  for (const id of graph.nodes.keys()) {
    depthsById.set(id, ancestorDepths(graph, id));
  }

  const recipientCounts = new Map<string, number>();
  for (const node of graph.nodes.values()) {
    const sourceId = node.record.inheritEmailFromId;
    if (!sourceId || sourceId === node.record.id) continue;
    recipientCounts.set(sourceId, (recipientCounts.get(sourceId) ?? 0) + 1);
  }

  const attachedByAnchor = new Map<string, string>();
  for (const [attachedId, anchorId] of attachedTo) {
    attachedByAnchor.set(anchorId, attachedId);
  }

  const childrenOf = new Map<string, Array<{ id: string; link: ParentLinkKind }>>();
  const orderedNodes = [...graph.nodes.values()].sort((a, b) => a.index - b.index);
  for (const node of orderedNodes) {
    const parent = displayParentOf.get(node.record.id);
    if (!parent) continue;
    const list = childrenOf.get(parent.parentId) ?? [];
    list.push({ id: node.record.id, link: parent.link });
    childrenOf.set(parent.parentId, list);
  }

  const serialized = new Set<string>();

  function serialize(id: string, linkToDisplayParent: ParentLinkKind | null): FamilyTreeNode | null {
    if (serialized.has(id)) return null; // defensive: forest building precludes this
    serialized.add(id);
    const node = graph.nodes.get(id)!;
    const { record } = node;
    const relationship = relationships.get(id)!;
    const archived = Boolean(record.archivedAt);
    const name = displayName(record);

    // The STORED resolver answer (#2255), reported verbatim — never re-derived.
    const source = record.inheritEmailFrom;
    let notificationEmail: FamilyTreeNode["notificationEmail"] = null;
    if (source && record.inheritEmailFromId) {
      const beyondDirectParent = !recordedParentIds(record).has(source.id);
      // #2255 lets an admin point a member's club email at ANY member, so the
      // mailbox holder is not necessarily part of this family at all. Identify
      // them only when they are in this tree; otherwise the payload carries the
      // fact without the person, and the card says the mail leaves the tree.
      const inTree = graph.nodes.has(source.id);
      let sourceRelationship: string | null = null;
      if (inTree) {
        const relation = bloodRelation(graph, depthsById, id, source.id);
        if (relation && relation.label !== "Self") {
          sourceRelationship = relation.label.toLowerCase();
        }
      }
      notificationEmail = {
        sourceId: inTree ? source.id : null,
        sourceName: inTree ? displayName(source) : null,
        sourceRelationship,
        beyondDirectParent,
        inTree,
      };
    }

    // Second parent named inline (mockup): the recorded parent that is NOT the
    // node's position in the list, when that parent is in the tree.
    // Suppressed entirely for a member the cycle break promoted to a root: it
    // has NO display parent by construction, so "the recorded parent that is
    // not the display parent" would name its genuine primary parent as its
    // second parent — a confident falsehood layered on top of corrupt data.
    const displayParent = displayParentOf.get(id);
    let secondParentInline: FamilyTreeNode["secondParentInline"] = null;
    const inlineParentId = cyclePromoted.has(id)
      ? undefined
      : [record.parentMemberId, record.secondaryParentId].find(
          (candidate) =>
            candidate &&
            candidate !== displayParent?.parentId &&
            graph.nodes.has(candidate),
        );
    if (inlineParentId) {
      secondParentInline = {
        id: inlineParentId,
        name: displayName(graph.nodes.get(inlineParentId)!.record),
      };
    }

    const partnerId = graph.partnerOf.get(id);
    const partnerNode =
      partnerId && graph.nodes.has(partnerId)
        ? graph.nodes.get(partnerId)!
        : null;
    const attachedPartnerId = attachedByAnchor.get(id) ?? null;

    const extras: string[] = [];
    if (archived) extras.push("Archived member — contact details hidden.");
    if (secondParentInline) {
      extras.push(`Second parent: ${secondParentInline.name}.`);
    }
    if (partnerNode) {
      extras.push(`Confirmed partner of ${displayName(partnerNode.record)}.`);
    }
    if (notificationEmail) {
      extras.push(
        notificationEmail.inTree && notificationEmail.sourceName
          ? `Club email goes to ${notificationEmail.sourceName}${
              notificationEmail.sourceRelationship
                ? ` (${notificationEmail.sourceRelationship})`
                : ""
            }.`
          : "Club email goes to a member outside this family tree.",
      );
    }

    const children = (childrenOf.get(id) ?? [])
      .map((child) => serialize(child.id, child.link))
      .filter((child): child is FamilyTreeNode => Boolean(child));

    const attachedPartner = attachedPartnerId
      ? serialize(attachedPartnerId, null)
      : null;

    return {
      id,
      name,
      ageTier: record.ageTier,
      active: record.active,
      canLogin: record.canLogin,
      archived,
      cancelled: Boolean(record.cancelledAt),
      isRoot: id === graph.rootId,
      generation: node.generation,
      relationship: {
        label: relationship.label,
        derived:
          relationship.kind === "blood" ||
          relationship.kind === "affinity" ||
          relationship.kind === "unknown",
        qualifier: relationship.qualifier,
        description: describeRelationship(graph, relationship, node, extras),
      },
      linkToDisplayParent,
      email: archived ? null : record.email || null,
      emailRecipientCount: recipientCounts.get(id) ?? 0,
      notificationEmail,
      secondParentInline,
      partner: partnerNode
        ? {
            id: partnerNode.record.id,
            name: displayName(partnerNode.record),
            attachedHere: attachedPartnerId === partnerNode.record.id,
          }
        : null,
      attachedPartner,
      familyGroups: (record.familyGroupMemberships ?? []).map((membership) => ({
        id: membership.familyGroupId,
        name: membership.familyGroup?.name ?? null,
        billing: membership.familyGroupId === record.billingFamilyGroupId,
      })),
      children,
    };
  }

  const roots = rootIds
    .map((id) => serialize(id, null))
    .filter((node): node is FamilyTreeNode => Boolean(node));

  let minGeneration = 0;
  let maxGeneration = 0;
  for (const node of graph.nodes.values()) {
    if (node.generation < minGeneration) minGeneration = node.generation;
    if (node.generation > maxGeneration) maxGeneration = node.generation;
  }

  const rootRecord = graph.nodes.get(graph.rootId)!.record;
  let hasDerived = false;
  for (const relationship of relationships.values()) {
    if (
      relationship.kind === "blood" ||
      relationship.kind === "affinity" ||
      relationship.kind === "unknown"
    ) {
      hasDerived = true;
      break;
    }
  }

  return {
    root: { id: graph.rootId, name: displayName(rootRecord) },
    roots,
    memberCount: graph.nodes.size,
    generationSpan: maxGeneration - minGeneration + 1,
    truncated: graph.truncated,
    truncatedReason: graph.truncatedReason,
    hasDerivedRelationships: hasDerived,
  };
}
