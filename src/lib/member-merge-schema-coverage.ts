/**
 * The checks that keep the merge's two hand-written lists honest against the
 * schema they describe.
 *
 * Split verbatim out of `member-merge.ts` (#3128). These read `schema.prisma`
 * and the Prisma DMMF and diff them against the relation table and the snapshot
 * column list, so a model or column added later cannot be quietly missed by a
 * merge. They belong beside the lists rather than inside the engine: nothing
 * here runs during a merge.
 */
/**
 * Parse a prisma schema for every Member FK-owning relation field, i.e. every
 * `<field> Member[?] @relation(..., fields: [<col>], ...)` line. Returns the
 * stable `Model.field` keys. This is the authoritative universe the spec table
 * must cover exactly. (Prisma 7's runtime DMMF is trimmed and no longer exposes
 * relationFromFields, so the FK-owner side is read from the schema text; see
 * `memberRelationNamesFromDmmf` for the DMMF cross-check.)
 */
export function parseMemberRelationOwnerKeys(schemaText: string): string[] {
  const lines = schemaText.split(/\r?\n/);
  const keys: string[] = [];
  let model: string | null = null;
  const modelRe = /^model\s+(\w+)\s*\{/;
  // Any singular Member-typed field carrying attributes. The `@relation(...)`
  // is extracted from the attribute tail separately so an attribute BEFORE
  // `@relation(` (e.g. `@ignore @relation(...)`) can never silently exclude a
  // field from the universe (fail-open would let an onDelete:Cascade relation
  // die with the loser unclassified). The runtime-DMMF test additionally
  // asserts every singular Member field maps to a parsed key (fail-closed).
  const fieldRe = /^\s*(\w+)\s+Member\??\s+(@.*)$/;
  for (const line of lines) {
    const mm = line.match(modelRe);
    if (mm) {
      model = mm[1];
      continue;
    }
    if (line.trim() === "}") {
      model = null;
      continue;
    }
    const rm = line.match(fieldRe);
    if (!rm || !model) continue;
    const rel = rm[2].match(/@relation\(([^)]*)\)/);
    if (rel && /fields:\s*\[/.test(rel[1])) {
      keys.push(`${model}.${rm[1]}`);
    }
  }
  return keys;
}

export function diffRelationSpecCoverage(
  ownerKeys: readonly string[],
  specKeys: readonly string[],
): { missing: string[]; extra: string[] } {
  const specSet = new Set(specKeys);
  const ownerSet = new Set(ownerKeys);
  return {
    missing: ownerKeys.filter((k) => !specSet.has(k)).sort(),
    extra: specKeys.filter((k) => !ownerSet.has(k)).sort(),
  };
}

/**
 * Drop a prisma `//` (or `///`) line comment, ignoring `//` inside a quoted
 * string so a `@default("https://…")` survives intact.
 *
 * Comments are not decoration to a schema scanner: a trailing
 * `// was: @relation(fields: [memberId], references: [id])` on a bare column
 * registers a PHANTOM foreign key and silently removes that column from
 * `parseFkLessMemberIdColumns`' output — the exact silent escape the detector
 * exists to prevent (#2243).
 */
function stripPrismaLineComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (!inString && ch === "/" && line[i + 1] === "/") return line.slice(0, i);
  }
  return line;
}

/**
 * #2243 — the FK-less member-id scalar columns a schema scan can actually FIND,
 * as sorted `Model.column` keys.
 *
 * The relation walk above is exact but structurally blind to columns that carry
 * no `@relation`: `CalendarEvent.createdById` and `CalendarEventSeries.createdById`
 * hold a Member id in a bare `String` and escaped both the walk and the
 * documented snapshot list entirely, so nothing in CI would have noticed the
 * next one either. This closes that by naming the detectable class mechanically
 * instead of by hand.
 *
 * The rule: a `String`/`String?` scalar that owns NO relation on its own model,
 * whose column NAME is used somewhere else in the schema as a Member FK column
 * (`memberId`, `createdById`, `updatedByMemberId`, ...). The repo names actor
 * columns consistently, so a new FK-less member-id column almost always reuses
 * one of those names and is caught. It is a DETECTOR, not a decision: everything
 * it returns must appear in `MEMBER_MERGE_SNAPSHOT_SCALAR_COLUMNS`, which is
 * where the "keep the loser's id as immutable history" classification is
 * recorded (the test in member-merge-dmmf.test.ts enforces that).
 *
 * It is deliberately a SUBSET of the FK-less member-id universe: bespoke names
 * that appear nowhere as a Member FK column (`MemberApplication.nominator1Id`,
 * `IssueReport.resolvedById`, `FamilyGroupJoinRequest.reviewedBy`, ...) are
 * invisible to it and stay hand-documented in that list. Deriving membership
 * from a name is the only signal the schema offers for a bare column, so a
 * detector that is right about a large, self-maintaining slice beats a promise
 * of exhaustiveness nothing can enforce.
 *
 * The name rule can in principle over-reach — a future `String` column called
 * `memberId` that holds someone ELSE's member number, say. Nothing in the schema
 * today does, and the remedy when one appears is to document it here with a note
 * saying why it is not a member id, not to loosen the detector: a false positive
 * costs one line, a false negative is the bug this exists to prevent.
 *
 * KNOWN PARSE ASSUMPTIONS (all true of `prisma/schema.prisma` today; re-check
 * them if the schema's shape ever changes):
 *   * ONE FIELD PER LINE, and `@relation(...)` entirely on that line. A
 *     multi-line `@relation` attribute would not be parsed, and its FK column
 *     would be mistaken for a bare scalar (a false POSITIVE, which costs one
 *     documented line, not a silent miss). No relation in this schema wraps, and
 *     `prisma format` does not wrap attributes — but we hand-edit the schema
 *     (AGENTS.md), so this is an assumption rather than a guarantee.
 *   * `//` COMMENTS ARE STRIPPED before matching, outside quoted strings.
 *     Without that a trailing comment such as
 *     `memberId String // was: @relation(fields: [memberId], ...)` registers a
 *     PHANTOM FK and hides the column from the detector entirely — a false
 *     negative, exactly the failure mode this exists to prevent.
 *   * `String[]` COLUMNS ARE EXCLUDED. The live instance is
 *     `HiddenFamilySuggestion.memberIds`, an array of member ids identifying a
 *     dismissed family suggestion. The merge does not rewrite it, so a
 *     merged-away loser's id stays in the array; the signature it was hidden
 *     under no longer matches the surviving membership, so a hidden suggestion
 *     can reappear for an admin to dismiss again. That is cosmetic and
 *     deliberate — array rewriting is a separate decision — but it is a real
 *     consequence, not an oversight.
 *   * `view` AND `type` BLOCKS ARE SKIPPED (only `model` opens a scan). There
 *     are none in this schema today; a member-id column added inside one would
 *     be invisible here.
 */
export function parseFkLessMemberIdColumns(schemaText: string): string[] {
  type ModelScan = {
    name: string;
    scalarStrings: string[];
    /** FK column -> the model type of the relation that owns it. */
    relationFkColumns: Map<string, string>;
  };
  const models: ModelScan[] = [];
  let current: ModelScan | null = null;

  for (const rawLine of schemaText.split(/\r?\n/)) {
    const line = stripPrismaLineComment(rawLine);
    const mm = line.match(/^model\s+(\w+)\s*\{/);
    if (mm) {
      current = { name: mm[1], scalarStrings: [], relationFkColumns: new Map() };
      models.push(current);
      continue;
    }
    if (line.trim() === "}") {
      current = null;
      continue;
    }
    if (!current) continue;
    const fm = line.match(/^\s*(\w+)\s+(\w+)(\[\]|\?)?(\s.*)?$/);
    if (!fm) continue;
    const [, fieldName, fieldType, listOrOptional, tail] = fm;
    const relation = (tail ?? "").match(/@relation\(([^)]*)\)/);
    const fkFields = relation?.[1].match(/fields:\s*\[([^\]]*)\]/);
    if (fkFields) {
      for (const column of fkFields[1].split(",").map((c) => c.trim())) {
        if (column) current.relationFkColumns.set(column, fieldType);
      }
    }
    if (fieldType === "String" && listOrOptional !== "[]") {
      current.scalarStrings.push(fieldName);
    }
  }

  const memberFkColumnNames = new Set<string>();
  for (const model of models) {
    for (const [column, relatedType] of model.relationFkColumns) {
      if (relatedType === "Member") memberFkColumnNames.add(column);
    }
  }

  const found: string[] = [];
  for (const model of models) {
    for (const column of model.scalarStrings) {
      if (model.relationFkColumns.has(column)) continue;
      if (!memberFkColumnNames.has(column)) continue;
      found.push(`${model.name}.${column}`);
    }
  }
  return found.sort();
}

/** All relation names touching Member, from the trimmed runtime DMMF. */
export function memberRelationNamesFromDmmf(
  models: readonly { name: string; fields: readonly { type: string; relationName?: string }[] }[],
): Set<string> {
  const names = new Set<string>();
  for (const model of models) {
    for (const field of model.fields) {
      if (field.type === "Member" && field.relationName) {
        names.add(field.relationName);
      }
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Field-merge policy (master's populated scalars win; blanks filled from loser)
// ---------------------------------------------------------------------------
