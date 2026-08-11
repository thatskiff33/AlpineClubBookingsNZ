/**
 * THE ONE RESOLVER FOR "WHICH COLUMN DOES THIS DIAGNOSTICS STATEMENT READ?".
 *
 * Two suites reconcile the AI Diagnostics SELECT-only grant allowlist against the
 * statements that justify it, and they do it from opposite ends:
 *
 *  - `src/lib/diagnostics/tools/__tests__/provision-role.test.ts` compares the
 *    reads against `SELECT_GRANTS` — the declaration — on every pull request.
 *  - `src/lib/__tests__/ai-diagnostics-select-only-role.realdb.test.ts` compares
 *    them against what PostgreSQL itself will hand the provisioned role, in the
 *    Migration drift check's dedicated-database step.
 *
 * They must resolve `alias."column"` IDENTICALLY or the two halves stop being
 * halves of one property: a relation the parser silently missed would look
 * "granted and unread" to one suite and "readable and unread" to the other, and a
 * reviewer comparing them would be comparing two different questions. So the
 * resolution lives here once, and both suites fail together when it drifts.
 *
 * It is a parser for the SHIPPED statement text, not a general SQL parser, and its
 * blind spots fail LOUD rather than silent by construction: a read it cannot
 * attribute is reported through `unattributed` (which the declaration-side suite
 * asserts is empty but for named derived-table labels), and a read it misses
 * entirely surfaces as a granted-but-unread column in the reverse direction.
 */

/**
 * The aliases a statement binds to a BASE relation.
 *
 * Per statement, and that is load-bearing rather than tidy: `r` is `LodgeRoom` in
 * the bed-allocation statement, `BookingChangeRequest` in the exception statement
 * and `PaymentRefund` in the refund statement; `m` is `Member` in the member search
 * and `ManualRefundTask` in the refund state; `l` is `Lodge` in two statements and
 * `WebhookLog` in a third. One global alias map would mis-attribute a column to a
 * relation that never carried it — in both directions at once.
 */
export function baseRelationAliases(sql: string): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const match of sql.matchAll(
    /\b(?:FROM|JOIN)\s+public\."([A-Za-z]+)"(?:\s+(?:AS\s+)?([A-Za-z_][A-Za-z_0-9]*))?/g,
  )) {
    const relation = match[1];
    // An un-aliased `FROM public."X"` is referenced as `X."col"`, so bind the
    // relation name to itself rather than skipping the clause.
    aliases.set(match[2] ?? relation, relation);
  }
  return aliases;
}

/**
 * Every `alias."column"` reference a statement makes, as `Relation.column`.
 *
 * `[A-Za-z_][A-Za-z_0-9]*` on BOTH sides, not `[A-Za-z]+`: `Booking."checkIn"` and
 * `BookingGuestNight."stayDate"` are fine either way, but a column carrying a digit
 * or an underscore would be invisible to the narrower pattern, and invisible in the
 * forward direction means an ungranted column that fails with 42501 on a real
 * database and passes every mock.
 */
export function statementColumnReads(sql: string): {
  reads: Set<string>;
  unattributed: Set<string>;
} {
  const aliases = baseRelationAliases(sql);
  const reads = new Set<string>();
  const unattributed = new Set<string>();
  for (const match of sql.matchAll(
    /\b([A-Za-z_][A-Za-z_0-9]*)\."([A-Za-z_][A-Za-z_0-9]*)"/g,
  )) {
    const [, alias, column] = match;
    // `public."Relation"` matches the same shape; it is a relation, not a read.
    if (alias === "public") continue;
    const relation = aliases.get(alias);
    if (relation === undefined) {
      unattributed.add(`${alias}."${column}"`);
      continue;
    }
    reads.add(`${relation}.${column}`);
  }
  return { reads, unattributed };
}

/**
 * The union of `Relation.column` reads across a set of statements — the whole of
 * what the SELECT-only credential is asked to read anywhere in the product.
 *
 * The union is the right shape because the role is ONE credential shared by every
 * pack: a column granted for AID-6C is readable by an AID-6B statement, so
 * "does anything read this?" is the only question a per-column grant can be
 * justified against.
 */
export function collectStatementColumnReads(
  statements: Iterable<string>,
): Set<string> {
  const reads = new Set<string>();
  for (const sql of statements) {
    for (const pair of statementColumnReads(sql).reads) reads.add(pair);
  }
  return reads;
}
