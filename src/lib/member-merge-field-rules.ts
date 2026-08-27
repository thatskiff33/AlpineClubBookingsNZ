/**
 * How a merge combines the two members' own scalar fields: master wins, and the
 * loser fills the blanks.
 *
 * Split verbatim out of `member-merge.ts` (#3128). This is a pure decision over
 * two Member rows -- no database, no transaction, no lock -- which is why it
 * could leave the engine at all. `member-merge.ts` imports it; it imports
 * nothing back.
 */
import {
  mergeFieldValueKind,
  type MergeFieldValueKind,
} from "@/lib/member-merge-field-kinds";

/**
 * Independent optional scalars filled from the loser only when master is blank.
 *
 * `postLoginLanding` (#2090) is intentionally NOT listed: the post-login landing
 * preference is a per-account UI choice, not shared personal data, so a losing
 * member's preference is dropped on merge and the master keeps its own (null =
 * role default). Do not add it here.
 */
const FILL_IF_BLANK_FIELDS = [
  "title",
  "gender",
  "dateOfBirth",
  "occupation",
  "lifeMemberDate",
  "comments",
  "familyGroupId",
] as const;

/** Grouped fills: the whole group comes from the loser only when master's key field is blank. */
const GROUP_FILL_SPECS: { name: string; key: string; fields: string[] }[] = [
  {
    name: "phone",
    key: "phoneNumber",
    fields: ["phoneCountryCode", "phoneAreaCode", "phoneNumber"],
  },
  {
    // Member profile photo (MP1, #189). photoImageId is an OUTBOUND scalar FK
    // (Member -> MediaImage), so it is merged here, master-wins: the master
    // keeps its own photo (and photoUpdatedAt/photoUpdatedByMemberId audit
    // snapshot); the loser's whole group is absorbed ONLY when the master has no
    // photo. The loser's now-unreferenced MEMBER_PHOTO blob is cleaned up at
    // execute time (reconcileLoserMemberPhotos) so it can never survive as a
    // dangling public asset.
    name: "photo",
    key: "photoImageId",
    fields: ["photoImageId", "photoUpdatedAt", "photoUpdatedByMemberId"],
  },
  {
    name: "streetAddress",
    key: "streetAddressLine1",
    fields: [
      "streetAddressLine1",
      "streetAddressLine2",
      "streetCity",
      "streetRegion",
      "streetPostalCode",
      "streetCountry",
    ],
  },
  {
    name: "postalAddress",
    key: "postalAddressLine1",
    fields: [
      "postalAddressLine1",
      "postalAddressLine2",
      "postalCity",
      "postalRegion",
      "postalPostalCode",
      "postalCountry",
    ],
  },
];

/** Booleans where either record's `true` wins. */
const OR_BOOLEAN_FIELDS = ["requiresInduction", "hutLeaderEligible"] as const;

/**
 * Every field `mergeMemberFields` emits on EVERY call, assembled from the lists
 * it actually loops over (#2860).
 *
 * Exported for `member-merge-field-kinds.test.ts`, which uses it to prove the
 * value-kind declaration is exhaustive WITHOUT trusting a hand-built fixture to
 * trigger each row. A hand-built fixture only tests the rows someone remembered
 * to populate; adding a field to `FILL_IF_BLANK_FIELDS` or to a group would
 * otherwise pass unclassified until someone extended the fixture too.
 *
 * The two CONDITIONAL rows (`hutLeaderEligibleAt`, `joinedDate`) are not here —
 * they are pushed by hand rather than by a loop. That test finds them by
 * scanning this file for the literal field names handed to `fieldMergeRow`,
 * which is exhaustive for the same reason the constructor exists: it is the
 * single place a diff row can be built.
 */
export const UNCONDITIONALLY_MERGED_FIELDS: readonly string[] = [
  ...FILL_IF_BLANK_FIELDS,
  ...GROUP_FILL_SPECS.flatMap((group) => group.fields),
  ...OR_BOOLEAN_FIELDS,
];

export type FieldMergeRow = {
  field: string;
  master: unknown;
  loser: unknown;
  result: unknown;
  source: "master" | "loser" | "or" | "earliest";
  /**
   * What this field's values MEAN, so the merge screen can render them without
   * inferring it from the runtime type (#2860). Declared once per field in
   * `member-merge-field-kinds.ts`, stamped here so the row and its meaning
   * travel together and the browser cannot classify a value differently from
   * the server that produced it.
   *
   * Deliberately NOT part of the preview token: `outcomeDigest` hashes only
   * `field`/`result`/`source`, so how a value is DISPLAYED can never invalidate
   * a preview an admin is holding. It does appear in the `MEMBER_MERGED` audit
   * metadata, which records the diff verbatim — an addition to that record's
   * shape, and no change to any merged value.
   */
  kind: MergeFieldValueKind;
};

export type FieldMergeOutcome = {
  patch: Record<string, unknown>;
  diff: FieldMergeRow[];
};

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  return false;
}

function toTime(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" && value) return new Date(value).getTime();
  return null;
}

/**
 * The single constructor for a diff row, so no branch below can emit one
 * without its declared value kind (#2860).
 */
function fieldMergeRow(
  field: string,
  master: unknown,
  loser: unknown,
  result: unknown,
  source: FieldMergeRow["source"],
): FieldMergeRow {
  return {
    field,
    master,
    loser,
    result,
    source,
    kind: mergeFieldValueKind(field),
  };
}

/**
 * Pure additive field merge. Returns the write patch (only the fields that
 * actually change) plus a full diff for the preview. Auth / login / privilege /
 * Xero identity and onboarding/state fields are NEVER merged — they stay the
 * master's and are not represented in the patch.
 */
export function mergeMemberFields(
  master: Record<string, unknown>,
  loser: Record<string, unknown>,
): FieldMergeOutcome {
  const patch: Record<string, unknown> = {};
  const diff: FieldMergeRow[] = [];

  for (const field of FILL_IF_BLANK_FIELDS) {
    const m = master[field];
    const l = loser[field];
    if (isBlank(m) && !isBlank(l)) {
      patch[field] = l;
      diff.push(fieldMergeRow(field, m, l, l, "loser"));
    } else {
      diff.push(fieldMergeRow(field, m, l, m, "master"));
    }
  }

  for (const group of GROUP_FILL_SPECS) {
    const masterHasKey = !isBlank(master[group.key]);
    const loserHasKey = !isBlank(loser[group.key]);
    const takeLoser = !masterHasKey && loserHasKey;
    for (const field of group.fields) {
      const m = master[field];
      const l = loser[field];
      if (takeLoser) {
        patch[field] = l;
        diff.push(fieldMergeRow(field, m, l, l, "loser"));
      } else {
        diff.push(fieldMergeRow(field, m, l, m, "master"));
      }
    }
  }

  // OR booleans.
  for (const field of OR_BOOLEAN_FIELDS) {
    const m = Boolean(master[field]);
    const l = Boolean(loser[field]);
    const result = m || l;
    if (result !== m) patch[field] = result;
    diff.push(fieldMergeRow(field, m, l, result, "or"));
  }

  // hutLeaderEligibleAt follows hutLeaderEligible: earliest non-null when eligible.
  {
    const eligible =
      Boolean(master.hutLeaderEligible) || Boolean(loser.hutLeaderEligible);
    const mAt = toTime(master.hutLeaderEligibleAt);
    const lAt = toTime(loser.hutLeaderEligibleAt);
    if (eligible) {
      const earliest =
        mAt === null ? lAt : lAt === null ? mAt : Math.min(mAt, lAt);
      if (earliest !== null && earliest !== mAt) {
        patch.hutLeaderEligibleAt = new Date(earliest);
        diff.push(
          fieldMergeRow(
            "hutLeaderEligibleAt",
            master.hutLeaderEligibleAt,
            loser.hutLeaderEligibleAt,
            new Date(earliest),
            "earliest",
          ),
        );
      }
    }
  }

  // joinedDate: earliest membership start date.
  {
    const mAt = toTime(master.joinedDate);
    const lAt = toTime(loser.joinedDate);
    const earliest =
      mAt === null ? lAt : lAt === null ? mAt : Math.min(mAt, lAt);
    if (earliest !== null && earliest !== mAt) {
      patch.joinedDate = new Date(earliest);
    }
    diff.push(
      fieldMergeRow(
        "joinedDate",
        master.joinedDate,
        loser.joinedDate,
        earliest === null ? null : new Date(earliest),
        earliest !== null && earliest === lAt && earliest !== mAt ? "loser" : "master",
      ),
    );
  }

  return { patch, diff };
}

function samePatchValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    const at = a instanceof Date ? a.getTime() : NaN;
    const bt = b instanceof Date ? b.getTime() : NaN;
    return at === bt;
  }
  return a === b;
}

/**
 * #2243 — the sorted field names on which two derivations of the SAME merge
 * disagree.
 *
 * `executeMemberMerge` derives the field-merge patch twice: once from the
 * transaction-opening snapshot (the derivation the preview token is verified
 * against) and once from a read of both members taken immediately before the
 * write. In an ordinary uncontended merge the two are identical and this returns
 * `[]`; a non-empty result means a writer that does NOT take the
 * `member-lifecycle` advisory lock changed a merged field mid-transaction, and
 * the merge REFUSES with a 409 (`merge_drift_in_transaction`) rather than
 * applying values the operator never previewed.
 *
 * Because it compares PATCHES rather than final stored values, it can in rare
 * cases report a field whose finally-stored value would have been identical
 * anyway (a group fill re-deciding its source, say). That is the safe direction
 * for a refusal, and it is why the 409's wording says the member's details
 * changed rather than claiming a specific value would have been wrong.
 *
 * A field is "different" when the two patches disagree on its VALUE or on
 * whether it is written at all (absent versus present-and-null are different
 * writes). Dates are compared by instant, not identity, because the two
 * derivations read the same instant into two `Date` objects.
 */
export function diffFieldMergePatches(
  previewed: Record<string, unknown>,
  applied: Record<string, unknown>,
): string[] {
  const fields = new Set([...Object.keys(previewed), ...Object.keys(applied)]);
  const drifted: string[] = [];
  for (const field of fields) {
    if (!samePatchValue(previewed[field], applied[field])) drifted.push(field);
  }
  return drifted.sort();
}

// ---------------------------------------------------------------------------
// #2437 — family-link (Member self-relation) drift, re-checked under the lock
// ---------------------------------------------------------------------------
