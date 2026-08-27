import fs from "node:fs";
import path from "node:path";

/**
 * The reviewed record of which `DateTime` columns actually hold a CALENDAR DAY,
 * and — since #2872 — the list of columns that no longer need reviewing because
 * the schema now says so itself.
 *
 * Extracted from `date-only-encoding-guard.test.ts` (#2684) by #2860 so that
 * more than one guard can read the SAME list instead of restating it. Three now
 * do, and they cover different halves of the problem:
 *
 * - `src/lib/__tests__/date-only-encoding-guard.test.ts` classifies encoder call
 *   sites by the FIELD NAME written at the site — `formatDateOnly(m.joinedDate)`
 *   — and consults this list to decide whether a bare-`DateTime` read is a
 *   reviewed calendar day or an unreviewed instant truncation.
 * - `src/lib/__tests__/member-merge-field-kinds.test.ts` binds
 *   `MERGE_FIELD_VALUE_KINDS` (`src/lib/member-merge-field-kinds.ts`) to the two
 *   exports below, so the member-merge screen's per-field classification cannot
 *   contradict either the reviewed list or the schema.
 *
 * THE SECOND ONE EXISTS BECAUSE THE FIRST STRUCTURALLY CANNOT SEE IT. The
 * scanner resolves a field name out of the ARGUMENT EXPRESSION, so it only
 * classifies a site that names the column. The merge screen renders a generic
 * table of `unknown` values whose field is a runtime string, so no field name
 * appears at the call site, and the guard passes over it in silence — which is
 * exactly the shape of renderer that produced #2860 in the first place. Binding
 * the lists is what stops that blind spot becoming a second, divergent opinion
 * about what `joinedDate` means.
 */

/**
 * `DateTime` columns that nevertheless hold a DATE-ONLY value, with the write
 * that proves it.
 *
 * **IT IS EMPTY, AND THAT IS THE FINISHED STATE — not a list nobody has filled
 * in.** #2872 (CT-3, epic #2988) migrated all ten of its entries to `@db.Date`,
 * so every column that used to need a reviewed exception now declares its own
 * meaning in `prisma/schema.prisma` and is covered by
 * {@link DATE_ONLY_COLUMN_FIELDS} instead. The staleness assertion in
 * `date-only-encoding-guard.test.ts` is what forced the entries out: it fails
 * any key here that the schema declares `@db.Date`, so an exception cannot
 * outlive the fix that made it moot.
 *
 * WHAT WOULD PUT AN ENTRY BACK. A column that genuinely holds a calendar day but
 * cannot be `@db.Date` — a provider round-trip that has to preserve a
 * compatibility shape, say — belongs here with the write that proves it, and
 * with the reason the column cannot simply be narrowed. That is a real case and
 * this record stays for it. What does NOT belong here is a column somebody has
 * not got round to migrating: #2872's answer to that is the migration, and the
 * reviewed list exists so the difference between the two is written down rather
 * than assumed.
 *
 * IT HAS A NULL PROTOTYPE, AND THAT IS LOAD-BEARING NOW THAT IT IS EMPTY. Both
 * consumers ask `field in DATE_ONLY_IN_DATETIME_COLUMN`, and `in` walks the
 * prototype chain. On an ordinary object literal with no own keys left, that
 * disjunct is therefore a PURE prototype channel: `constructor`, `toString`,
 * `valueOf`, `hasOwnProperty` and `__proto__` are all `in` it, so a column with
 * any of those names would be silently treated as a REVIEWED calendar day by
 * both guards at once. `Object.create(null)` removes the chain, which fixes it
 * for every consumer including the ones that cannot be edited from here;
 * `member-merge-field-kinds.test.ts` additionally reads its own copy of the
 * question with `Object.hasOwn`, and pins this prototype so the two defences
 * cannot both be removed by accident.
 *
 * "The write that proves it" was always doing real work, and #2860 found out
 * why: an entry records what a field MEANS, which is not a promise that every
 * writer honours it. `parseXeroCompanyNumberDate` built SERVER-LOCAL midnight
 * for a Xero-imported `dateOfBirth` (#2859) and stored some rows a day early —
 * which did not move `dateOfBirth` off the list, because a birthday is still a
 * calendar day. Keep that distinction if an entry ever returns: a reader must
 * not infer from a listing here that the stored data is clean.
 */
export const DATE_ONLY_IN_DATETIME_COLUMN: Record<string, string> = Object.assign(
  Object.create(null) as Record<string, string>,
  {
    // Empty on purpose — see the docblock above. A returning entry goes here,
    // as `fieldName: "the write that proves it"`.
  },
);

/**
 * Every field name the Prisma schema declares `@db.Date` — a calendar day the
 * DATABASE enforces, rather than one a convention maintains.
 *
 * This is the other half of the same question `DATE_ONLY_IN_DATETIME_COLUMN`
 * answers, and after #2872 it is the half that holds nearly all the answers. A
 * consumer asking "may I read this column by truncation?" wants the union of the
 * two: a reviewed bare-`DateTime` exception, or a column the schema has already
 * settled.
 *
 * BY FIELD NAME, NOT BY MODEL, because that is what the consumers can resolve —
 * the encoder scanner reads a name out of an argument expression and the merge
 * screen holds one as a runtime string, and neither knows which model the value
 * came from. `date-only-encoding-guard.test.ts` keeps that sound with its own
 * assertion that no field name is `@db.Date` on one model and a bare `DateTime`
 * on another; if that ever fails, this set stops being answerable by name and
 * both consumers need the model.
 *
 * Read from `prisma/schema.prisma` off disk rather than from the generated
 * client, because `@db.Date` is a native database-type attribute that the
 * client's TypeScript types erase entirely: both kinds are `Date`.
 */
export const DATE_ONLY_COLUMN_FIELDS: ReadonlySet<string> =
  readDateOnlyColumnFields();

function readDateOnlyColumnFields(): ReadonlySet<string> {
  const source = fs.readFileSync(
    path.join(process.cwd(), "prisma/schema.prisma"),
    "utf8",
  );
  const fields = new Set<string>();
  let model: string | null = null;

  for (const line of source.split("\n")) {
    const opening = line.match(/^\s*model\s+(\w+)\s*\{/);
    if (opening) {
      model = opening[1];
      continue;
    }
    if (/^\s*\}/.test(line)) {
      model = null;
      continue;
    }
    if (!model) continue;

    const field = line.match(/^\s*(\w+)\s+DateTime\??(\[\])?\s*(.*)$/);
    if (!field) continue;
    if (/@db\.Date\b/.test(field[3] ?? "")) fields.add(field[1]);
  }

  return fields;
}
