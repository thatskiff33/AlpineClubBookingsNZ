/**
 * Rows still naming the duplicate once member merge holds its Member rows
 * (#4855): the one check that refuses the merge for them.
 *
 * Merge re-points the duplicate's relations (`applyMoves`, the collision
 * resolvers) BEFORE its sorted `Member … FOR UPDATE`, and an UPDATE sees only
 * committed rows. A write naming the duplicate that was still in flight then —
 * an officer who is the duplicate approving a change request, say — commits
 * after the move skipped it, and the loser delete's `onDelete` then clears it
 * (`SetNull`: the reviewer silently gone), deletes it (`Cascade`) or fails the
 * merge with an unmapped FK error (`Restrict`).
 *
 * Under the Member rows the set cannot grow: naming the duplicate is an FK
 * write, which needs `FOR KEY SHARE` on its row. So one read per relation, right
 * after that lock, sees every such row, and any row refuses the whole merge with
 * the same 409 (`merge_drift_in_transaction`) the operator already re-runs the
 * preview for. Refusing, not moving: a late move would lock those rows after the
 * Member rows, the order #4840 forbids, and would absorb rows the preview never
 * showed (#2437's rule). Reads take no row locks.
 *
 * The relations come from `MEMBER_MERGE_RELATION_SPECS`, so a new relation is
 * checked unless the table marks it as handled another way (`cascade`,
 * `movedLast`, `selfRelation`, `sweptLate`), each with its reason.
 * `member-merge-residual-references.test.ts` pins that list (`INV-SSOT`).
 */
import { MEMBER_MERGE_RELATION_SPECS, mergeDelegate, type MemberMergeRelationSpec } from "@/lib/member-merge-relations";

export type MemberMergeResidualReferenceEntry =
  | { readonly key: string; readonly checked: true; readonly spec: MemberMergeRelationSpec }
  | { readonly key: string; readonly checked: false; readonly reason: string };

function planFor(spec: MemberMergeRelationSpec): MemberMergeResidualReferenceEntry {
  if (spec.bucket === "cascade") {
    return { key: spec.key, checked: false, reason: "cascade: the row is the duplicate's own and dies with it by design" };
  }
  if (spec.movedLast) {
    return { key: spec.key, checked: false, reason: "moved last, NOWAIT, under the Member rows (#4823, member-merge-payment-attribution.ts)" };
  }
  if (spec.selfRelation) {
    return { key: spec.key, checked: false, reason: "a Member self-relation: the step-5 inbound re-check refuses a late link (#2437)" };
  }
  if (spec.sweptLate) {
    return { key: spec.key, checked: false, reason: "sweptLate: moved again by applyLateHostingCoverageMoves under the Member rows (#2597)" };
  }
  return { key: spec.key, checked: true, spec };
}

/** Every relation spec, in table order: checked, or excluded with its reason. */
export const MEMBER_MERGE_RESIDUAL_REFERENCE_PLAN: readonly MemberMergeResidualReferenceEntry[] = Object.freeze(
  MEMBER_MERGE_RELATION_SPECS.map(planFor),
);

/** How many row ids per relation a refusal carries. */
const RESIDUAL_ROW_SAMPLE = 20;

type IdReadingDelegate = {
  findMany: (args: unknown) => Promise<Array<{ id: string }>>;
};

export type MemberMergeResidualReferences = {
  /** The relation keys that still name the duplicate, in table order; empty when none does. */
  driftFields: string[];
  /** Up to `RESIDUAL_ROW_SAMPLE` row ids per relation, sorted. */
  residualRowIds: Record<string, string[]>;
};

/**
 * Read every checked relation for rows naming `loserId`. Call it only while
 * the Member rows are held `FOR UPDATE`; before that the answer can go stale.
 */
export async function findMemberMergeResidualReferences(
  db: unknown,
  loserId: string,
): Promise<MemberMergeResidualReferences> {
  const found: MemberMergeResidualReferences = { driftFields: [], residualRowIds: {} };
  for (const entry of MEMBER_MERGE_RESIDUAL_REFERENCE_PLAN) {
    if (!entry.checked) continue;
    const rows = await mergeDelegate<IdReadingDelegate>(db, entry.spec.delegate).findMany({
      where: { [entry.spec.column]: loserId },
      select: { id: true },
      orderBy: { id: "asc" },
      take: RESIDUAL_ROW_SAMPLE,
    });
    if (rows.length === 0) continue;
    found.driftFields.push(entry.key);
    found.residualRowIds[entry.key] = rows.map((row) => row.id);
  }
  return found;
}
