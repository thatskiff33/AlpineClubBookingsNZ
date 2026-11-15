import { mergeFieldValueKind, type MergeFieldValueKind } from "@/lib/member-merge-field-kinds";

type FieldMergeRow = {
  field: string;
  master: unknown;
  loser: unknown;
  result: unknown;
  source: string;
  // The server stamps this on every row (#2860). Optional here only so a page
  // served by a newer build can still render a preview built by an older one
  // mid-deploy; `rowValueKind` re-derives it from the same declaration.
  kind?: MergeFieldValueKind;
};

export type MergePreview = {
  masterId: string;
  loserId: string;
  masterName: string;
  loserName: string;
  confirmationPhrase: string;
  previewToken: string;
  fieldMerge: FieldMergeRow[];
  relationMoves: { model: string; count: number }[];
  collisions: { model: string; resolution: string; count: number }[];
  blockers: { code: string; label: string; count?: number }[];
  warnings: string[];
};

/**
 * What this row's values mean (#2860). The row carries it; the field-name
 * lookup is the mid-deploy fallback described on `FieldMergeRow.kind`. This
 * screen never infers a date's meaning from its runtime type — an instant and a
 * calendar day are the same `Date`, and reading one as the other dates it a day
 * early for half of every New Zealand day, immediately before an irreversible
 * merge.
 *
 * This REPLACES the `display()` helper that used to live here. #2684 had just
 * moved its `value instanceof Date` arm off a hand-written truncation and onto
 * `formatDateOnly`, which fixed the spelling; the arm itself is the defect,
 * because no runtime type can tell the two kinds apart. The canonical encoder is
 * still what renders a calendar day — one module across, in
 * `formatMergeFieldValue` — so nothing #2684 centralised is given back.
 */
export function rowValueKind(row: FieldMergeRow): MergeFieldValueKind {
  return row.kind ?? mergeFieldValueKind(row.field);
}
