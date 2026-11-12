import { blankLiteralsWithSpans, type BlankedSpan } from "./strip-comments";

/** Shared raw transaction-lock spelling for inventories and isolation checks. */
export const ADVISORY_LOCK_CALL = /pg_(?:try_)?advisory_xact_lock\s*\(/g;

/**
 * Does this blanked run hold a RAW STATEMENT the census must be able to read,
 * rather than prose about one?
 *
 * A QUOTED LITERAL IS NOT CODE for this purpose, and #2623 T9(d) is where that
 * started to matter: `adult-member-hosting-queue-participants.ts` names its own
 * protocol inside an error message ("… must never be issued without its FOR KEY
 * SHARE NOWAIT lock"), which is prose about a statement, not a statement. A
 * counter that scored it would put a number in the inventory below that no reader
 * could reconcile against the file, and would fail the census when somebody
 * reworded a sentence. Every raw statement in this repository is written as a
 * BACKTICK template, so template text is always restored.
 *
 * QUOTED MEANS EITHER QUOTE, and that is deliberate rather than an oversight of
 * the double-quoted spelling this rule was written against.
 * `blankLiteralsWithSpans` reports `"` and `'` alike as `kind: "string"`, so the
 * test below is quote-agnostic and every clause here applies to both. Nothing
 * would be gained by narrowing it to one quote: a single-quoted sentence is as
 * much prose as a double-quoted one.
 *
 * BUT ONLY PROSE, NOT SQL (#2623 F7). Suppressing every quoted literal opened the
 * same hole T9(d) exists to close, one level down: `$executeRawUnsafe` takes a
 * plain string, so `const SQL = "SELECT … FOR UPDATE"; await
 * tx.$executeRawUnsafe(SQL)` would score ZERO and drop out of the census
 * silently. A literal containing `SELECT` is therefore restored and counted —
 * prose about the protocol does not contain it (the one live case, quoted above,
 * does not), and a raw statement always does. The narrower rule keeps the false
 * positive suppressed while refusing to suppress a real statement. **Both
 * spellings are counted**: `tx.$executeRawUnsafe('SELECT … FOR UPDATE')` scores
 * exactly as its double-quoted twin does, which the cases below pin so nobody
 * reads the paragraph above as a double-quote-only carve-out.
 *
 * A `comment` run is never restored, which is the whole point of masking, and a
 * `regex` run is never restored because a pattern is not a statement.
 */
function holdsRawStatement(source: string, span: BlankedSpan): boolean {
  if (span.kind === "template") return true;
  if (span.kind !== "string") return false;
  return /SELECT/i.test(source.slice(span.start, span.end));
}

/**
 * The one masking rule, shared by the per-site scan and the count inventories:
 * the file with every comment and every prose literal blanked to spaces, and the
 * raw SQL put back where {@link holdsRawStatement} recognises it.
 *
 * THE SCANNER IS THE SHARED ONE (#3196, `INV-SSOT-004`). Until then this census
 * carried the last private comment scanner in the tree, and it worked a LINE at a
 * time: a whole-line comment was dropped by its leading `//` or `*`, and
 * double-quoted literals were blanked with a regex. Both halves were wrong in
 * ways nothing here could see. A TRAILING comment was never dropped at all, nor
 * was a block-comment body line that did not begin with `*`, so prose in either
 * shape counted as code. And a line-local quote regex has no idea what a REGEX
 * LITERAL is: `.replace(/"/g, "")` reads as a string opener, which is the exact
 * defect #3155 removed from the shared scanner and #3180 then found LIVE in a
 * sibling census, where it hid a real database write five hundred lines further
 * down. The remedy is not a better local regex; it is not having a second
 * scanner. `blankLiteralsWithSpans` blanks with every offset preserved and hands
 * back the runs it blanked, so the SQL carve-out lives HERE — where a policy
 * about SQL belongs — and the lexing lives in the module that owns it.
 *
 * OFFSETS SURVIVE THE RESTORE, because every span is exactly as long as the
 * spaces standing in for it. That is what lets the scan below keep using the
 * masked text as a coordinate system for line numbers.
 */
export function maskedSource(source: string): string {
  const { code, spans } = blankLiteralsWithSpans(source);
  const pieces: string[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (!holdsRawStatement(source, span)) continue;
    pieces.push(code.slice(cursor, span.start), source.slice(span.start, span.end));
    cursor = span.end;
  }
  pieces.push(code.slice(cursor));
  return pieces.join("");
}
