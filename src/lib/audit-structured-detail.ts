/**
 * KEEPING A STRUCTURED AUDIT PAYLOAD READABLE WHEN IT DOES NOT FIT (#2704).
 *
 * WHAT WAS WRONG. 104 production write sites store their evidence as
 * `details: JSON.stringify({ … })`, and the `details` column is sanitised by
 * one text rule that clips at 1000 characters and appends `...[TRUNCATED]`.
 * Clipping a JSON document at a character offset lands wherever it lands, so an
 * over-budget payload was stored as a string that still begins with `{` and no
 * longer parses. Two consequences, both measured on this branch:
 *
 *   - `audit-query.ts` reads the column with `parseJsonObject`, which returns
 *     null for it — so the officer who needs the evidence most, on the biggest
 *     event, is the one shown a broken blob instead of named fields, with no
 *     metadata panel and no drill-down links.
 *   - Worse, the clip can land mid-value. A payload padded to the boundary
 *     stores `…,"amountCents":1...[TRUNCATED]` for a recorded 1234567. Nothing
 *     on the screen says the number is a fragment, so the row reads as evidence
 *     of a figure six orders of magnitude out. That is the "malformed or
 *     misleading structured evidence" this issue forbids, and it is the reason
 *     the fix is not merely cosmetic.
 *
 * THE RULE THIS MODULE APPLIES, and it is one sentence: **a value is kept
 * whole, or dropped by name, or — for a string only — clipped behind the
 * visible marker. Never partially rendered.** A clipped string ending
 * `...[TRUNCATED]` tells the reader it is short. A clipped number, identifier,
 * boolean or object does not; it just lies quietly. So strings may be shortened
 * and nothing else may be, which is what makes every field on the screen either
 * true or visibly incomplete.
 *
 * TWO ENTRY POINTS, BECAUSE THERE ARE TWO POPULATIONS.
 *
 *   - `reduceStructuredDetail` is the WRITE side, for rows written from here on.
 *     It reduces the parsed, already-sanitised value and re-serialises it, so
 *     validity holds by construction rather than by inspection.
 *   - `recoverTruncatedStructuredDetail` is the READ side, for the rows ALREADY
 *     IN THE DATABASE. Every one of those was clipped by the old rule and no
 *     write-time change can reach them, which is why this issue asks for
 *     "large *and legacy*" events. It works on the stored TEXT, because the text
 *     is all that survives, and recovers only the whole key/value pairs that
 *     precede the cut.
 *
 * Both keep whole pairs and neither invents a value, so the two can never
 * disagree about a field: anything either one shows is a byte-identical copy of
 * what the writer recorded, and anything it could not show is absent rather
 * than approximated. `audit-structured-detail.test.ts` pins that as a property
 * over every cut position of a representative payload, which is the form the
 * claim has to take — one worked example proves nothing about the offsets the
 * example did not land on.
 *
 * WHAT THE READ SIDE DELIBERATELY DOES NOT FEED. `audit-query.ts` uses recovery
 * for the row's metadata panel and its one-line description, and NOT for
 * `getSummary`, which reaches into a clean parse for two actions'
 * `recipientEmail`. That asymmetry is unreachable rather than tolerated: both
 * writers store `{recipientEmail, recipientName, kind, expiryLabel}` — an email,
 * a name, `"invite"` and `"14 days"` — which cannot approach the limit, so no
 * row of those two actions is ever clipped. Said here because it is the first
 * thing a reader notices and the last thing the code explains.
 *
 * RECOVERY IS A DERIVED VIEW AND NEVER REPLACES THE RECORD. A recovered row
 * keeps its raw stored text on screen alongside the recovered fields, so the
 * officer reads the club's actual history and a convenience rendering of it,
 * not a rendering standing in for it (`INV-OPS-012`: a code change never moves
 * the rows already written). The reserved marker below is what keeps the two
 * distinguishable on the screen.
 *
 * NO AUDIENCE DECISION LIVES HERE, AND THAT IS DELIBERATE. #2695 made what a
 * member reads an explicit declaration at the write site, read by one function
 * for both audiences, so nothing a member sees depends any more on whether a
 * payload parses or how long it is. This module therefore changes what an
 * AUTHORISED reader is shown and cannot widen a readership even in principle —
 * `details` reaches no member timeline and no data export. Keep it that way: if
 * a future change makes a member read anything derived here, the decision is
 * `INV-PRIV-017`'s and it belongs at the write site, not in this file.
 *
 * This module holds no `server-only` marker on purpose. `audit-query.ts` is
 * reached from a client component's import graph and `audit.ts` is not, and
 * both need the same vocabulary — the same reason `audit-member-disclosure.ts`
 * is structured this way.
 */

/**
 * The single spelling of the marker that says a value was shortened.
 *
 * It lives here rather than in `audit.ts` because the read side has to
 * recognise exactly what the write side produced, and two spellings of one
 * sentinel is the drift `INV-SSOT-001` exists to prevent. `audit.ts` imports it.
 */
export const AUDIT_TRUNCATION_MARKER = "[TRUNCATED]";

/** What a shortened string ends with, everywhere in the audit trail. */
export const AUDIT_TRUNCATION_SUFFIX = `...${AUDIT_TRUNCATION_MARKER}`;

/**
 * Reserved keys this module MINTS. Underscore-prefixed, matching the
 * `_truncated` / `_truncatedKeys` vocabulary `audit.ts` already stores, and
 * always re-written from scratch so a caller's payload cannot forge one.
 */
export const REDUCED_DETAIL_KEYS = {
  /** The payload did not fit and was reduced rather than clipped. */
  truncated: "_truncated",
  /** Characters in the full serialisation, so the reader knows the scale. */
  originalLength: "_originalLength",
  /** The names of the fields that did not fit — shape, never values. */
  droppedKeys: "_droppedKeys",
  /**
   * How many fields were dropped ALTOGETHER, written only when `_droppedKeys`
   * could not name them all (#2704 review). The one thing this module adds to
   * a row was breaking its own headline rule: the name list was shed from the
   * end until the block fitted, and nothing said so — measured at the column's
   * budget, thirty-seven fields dropped and two named. A list that has been
   * shortened now says it has, which is the same rule every other value here
   * obeys.
   */
  droppedKeyCount: "_droppedKeyCount",
  /** Set by the READ side only: these fields were rebuilt from clipped text. */
  recovered: "_recoveredFromTruncatedText",
} as const;

/**
 * The sanitiser's own "there were more keys than I kept" flag, spelled here
 * because two spellings of one sentinel is the drift `INV-SSOT-001` prevents —
 * `audit.ts` writes it and this module has to recognise it. It is NOT minted
 * here, so the reduction passes it through as an ordinary field rather than
 * re-writing it; what this module owes it is the two READER behaviours below.
 */
export const AUDIT_TRUNCATED_KEYS_FLAG = "_truncatedKeys";

const MINTED_KEY_VALUES: readonly string[] = Object.values(REDUCED_DETAIL_KEYS);

/**
 * Every bookkeeping key a READER should not quote back as evidence: the ones
 * minted above plus the sanitiser's flag. Wider than the minted set on purpose.
 * The reduction strips only what it mints, because stripping the sanitiser's
 * flag on the write side would delete a true marker; a reader filters both,
 * because neither is a field the writer recorded.
 */
const RESERVED_KEY_VALUES: readonly string[] = [
  ...MINTED_KEY_VALUES,
  AUDIT_TRUNCATED_KEYS_FLAG,
];

/**
 * Room set aside for the reserved block before any field is measured.
 *
 * `{"_truncated":true,"_originalLength":<n>,"_droppedKeys":[…]}` with a
 * generous number, a few names, and room for `_droppedKeyCount` if the names
 * have to be shed. Names are shed afterwards if the real block still overruns,
 * so this is a starting reservation and not an assumption — the empty-list
 * floor is 84 characters, which is what makes the shedding loop terminate with
 * room spare.
 */
const RESERVED_BLOCK_RESERVE = 120;

/** Below this a clipped string is all marker and no evidence, so drop it. */
const MIN_USEFUL_CLIP = 24;

export type PlainJsonObject = Record<string, unknown>;

export function isPlainJsonObject(value: unknown): value is PlainJsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

/**
 * The parsed object a stored `details` string holds, or null when it holds
 * anything else — prose, an array, a scalar, or text that does not parse.
 *
 * The `{` test in front of `JSON.parse` is not an optimisation: without it a
 * bare `"123"` or `"null"` parses successfully and would be mistaken for a
 * payload.
 */
export function parseStructuredDetail(value: string | null | undefined): PlainJsonObject | null {
  if (typeof value !== "string" || !value.trim().startsWith("{")) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return isPlainJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function without(value: PlainJsonObject, keys: readonly string[]): PlainJsonObject {
  const copy: PlainJsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!keys.includes(key)) {
      copy[key] = entry;
    }
  }
  return copy;
}

/**
 * The cost in characters of adding one more pair to a non-empty object.
 *
 * Safe for every value the callers hand it because they drop the ones
 * `JSON.stringify` writes NOTHING for first — see `serialisableFields`.
 */
function pairCost(key: string, value: unknown): number {
  // `,"key":value` — the leading comma is what an added pair actually costs
  // inside an object that already has one.
  return JSON.stringify(key).length + 1 + JSON.stringify(value).length + 1;
}

/**
 * The payload's own pairs, in its own order, minus any `JSON.stringify` writes
 * nothing for — `undefined`, a function, a symbol.
 *
 * Those are not fields: `JSON.stringify({ a: undefined })` is `{}`, so they are
 * absent from `originalLength` and from every serialisation below. Dropping
 * them here is what lets `pairCost` measure rather than throw on
 * `undefined.length`. Unreachable from the two production callers — one parses
 * its input from JSON, the other takes the sanitiser's output, and neither can
 * produce such a value — but this function is exported and takes `unknown`.
 */
function serialisableFields(value: PlainJsonObject): Array<[string, unknown]> {
  return Object.entries(value).filter(
    ([, entry]) => JSON.stringify(entry) !== undefined
  );
}

/**
 * The longest marker-terminated clip of `text` whose pair fits in `room`, or
 * null when nothing worth reading fits.
 *
 * Binary search rather than a shrink loop: JSON escaping makes the serialised
 * length non-linear in the character count (a quote costs two, a control
 * character six), so the only honest way to pick a length is to measure the
 * candidate. Deterministic — the same text and room always return the same clip.
 */
function clipStringValueToFit(key: string, text: string, room: number): string | null {
  const fits = (length: number): boolean =>
    pairCost(key, `${text.slice(0, length)}${AUDIT_TRUNCATION_SUFFIX}`) <= room;

  if (!fits(MIN_USEFUL_CLIP)) {
    return null;
  }

  let low = MIN_USEFUL_CLIP;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid)) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return `${text.slice(0, low)}${AUDIT_TRUNCATION_SUFFIX}`;
}

export type StructuredDetailReduction = {
  /** Valid JSON object text, within budget. */
  text: string;
  /**
   * Names of the fields that did not fit, in the payload's own order — ALL of
   * them, even when `text` had room to name only some. The stored row says so
   * with `_droppedKeyCount`; this list never needs to.
   */
  droppedKeys: readonly string[];
};

/**
 * Reduce an already-sanitised payload to a VALID JSON object within `budget`.
 *
 * Two passes, and the order is the point. The first takes every field that fits
 * whole, CHEAPEST FIRST; the second goes back for the skipped ones and clips
 * those whose value is a string. Done in one pass instead, a single long value
 * at the front — `issue.reported` carries a page URL the schema caps at 2048
 * characters — would eat the whole budget and starve the three short fields
 * behind it. This way the short fields are never lost to a long neighbour, and
 * the long neighbour still contributes what it can.
 *
 * CHEAPEST FIRST rather than the payload's own key order, and the difference is
 * not a refinement (#2704 review). Admitting in key order left a band in which a
 * LONGER value preserved more evidence than a shorter one: measured at this
 * column's budget on a note plus five identifiers, an 865-character note stored
 * ONE field of six — dropping the amount, the booking, the payment and the
 * invoice — while an 870-character note stored all six, because at 870 the note
 * no longer fitted whole and the short fields got in ahead of it. The fields
 * that band destroyed are exactly the identifiers the drill-down links are built
 * from and the money figure the description leads with. Ordering by cost makes a
 * cheap field's survival independent of what sits in front of it.
 *
 * The STORED key order does not move: the output is rebuilt from the payload's
 * own entries below, never from the order the passes admitted them.
 *
 * Returns null when the caller's own value is not a plain object, and when the
 * budget is too small to hold even the reserved block (about sixty characters);
 * the caller then keeps whatever it already had, because this module never
 * invents a shape and never hands back text over the budget it was given.
 */
export function reduceStructuredDetail(
  value: unknown,
  budget: number
): StructuredDetailReduction | null {
  if (!isPlainJsonObject(value)) {
    return null;
  }

  // Only the keys this module MINTS are stripped and re-written. The
  // sanitiser's `_truncatedKeys` flag rides through as an ordinary field: it
  // records that keys beyond the object cap were dropped before this ran, and
  // deleting it here would lose a true marker to protect against forging a
  // self-deprecating one.
  const source = without(value, MINTED_KEY_VALUES);
  const entries = serialisableFields(source);
  const originalLength = JSON.stringify(source).length;

  // ALREADY FITS, so say nothing. Reachable because the caller decides to come
  // here from the length of the RAW text, while this measures the SANITISED
  // value — and sanitising can shorten a payload a long way, replacing a
  // sensitive key's value with `[REDACTED]` or clipping a long string. Marking
  // such a row `_truncated` would be a claim about it that is not true, which
  // is the one thing this module exists not to do.
  if (originalLength <= budget) {
    return { text: JSON.stringify(source), droppedKeys: [] };
  }

  const kept = new Map<string, unknown>();
  // `{}` is two characters; each pair adds its own cost on top.
  let used = 2;
  const room = Math.max(0, budget - RESERVED_BLOCK_RESERVE);

  // Ties broken by the payload's own position, so the result stays a function
  // of the payload rather than of the sort's stability.
  const byCost = entries
    .map(([key, entry], index) => ({ key, entry, index, cost: pairCost(key, entry) }))
    .sort((a, b) => a.cost - b.cost || a.index - b.index);

  for (const field of byCost) {
    if (used + field.cost <= room) {
      kept.set(field.key, field.entry);
      used += field.cost;
    }
  }

  // Back in the payload's order, which is the order the dropped names report in.
  const skipped = entries.filter(([key]) => !kept.has(key));

  const dropped: string[] = [];
  for (const [key, entry] of skipped) {
    if (typeof entry !== "string") {
      dropped.push(key);
      continue;
    }
    const clipped = clipStringValueToFit(key, entry, room - used);
    if (clipped === null) {
      dropped.push(key);
      continue;
    }
    kept.set(key, clipped);
    used += pairCost(key, clipped);
  }

  // Rebuild in the payload's own key order, so the stored text is a function of
  // the payload and not of which pass admitted which field.
  const reduced: PlainJsonObject = {};
  for (const [key] of entries) {
    if (kept.has(key)) {
      reduced[key] = kept.get(key);
    }
  }
  reduced[REDUCED_DETAIL_KEYS.truncated] = true;
  reduced[REDUCED_DETAIL_KEYS.originalLength] = originalLength;
  reduced[REDUCED_DETAIL_KEYS.droppedKeys] = [...dropped];

  // The reserve is a reservation, not a proof. If the real block overruns it —
  // a payload with many long key names can do that — shed dropped NAMES. They
  // describe shape, so losing them costs the reader context, where losing a
  // field would cost them evidence. `_truncated` and `_originalLength` together
  // are well inside the reserve, so the loop always terminates with room spare.
  //
  // AND IT SAYS SO WHEN IT DOES (#2704 review). A silently shortened list is
  // the very defect this module exists to remove — a value partially rendered
  // with no marker — committed by the one field the module adds. `_droppedKeys`
  // shorter than `_droppedKeyCount` is the marker: whatever it could not name,
  // it still counts.
  let names = [...dropped];
  let text = JSON.stringify(reduced);
  while (text.length > budget && names.length > 0) {
    names = names.slice(0, -1);
    reduced[REDUCED_DETAIL_KEYS.droppedKeys] = names;
    reduced[REDUCED_DETAIL_KEYS.droppedKeyCount] = dropped.length;
    text = JSON.stringify(reduced);
  }

  if (text.length > budget) {
    // Only a budget too small for the reserved block at all reaches this; both
    // production callers pass 1000 or 24,000. Null rather than over-budget
    // text, so "within budget" in the return type is unconditional.
    return null;
  }

  return { text, droppedKeys: dropped };
}

/**
 * Rebuild the whole key/value pairs a character-clipped payload still holds.
 *
 * For the rows written BEFORE this issue, which is every row carrying an
 * over-budget payload today. Given text that opens with `{` and does not parse,
 * it scans forward for the last top-level `,` that sits outside any string,
 * closes the object there and parses what precedes it. Everything after that
 * comma is an incomplete pair and is discarded rather than guessed at — so a
 * number cut in half, an identifier cut in half, or a half-written nested object
 * never reaches the screen.
 *
 * Returns null when the text parses cleanly (the caller already has the object),
 * when it is not an object at all, or when no complete pair precedes the cut.
 * Null means "show what you were showing before"; it never means "show nothing".
 */
export function recoverTruncatedStructuredDetail(
  value: string | null | undefined
): PlainJsonObject | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  if (!text.startsWith("{") || parseStructuredDetail(text) !== null) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  let lastPairEnd = -1;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) {
        // The document closed, so it was well-formed and the clean parse above
        // should have taken it. Trailing rubbish after a closed object is not
        // something to recover from.
        return null;
      }
    } else if (char === "," && depth === 1) {
      lastPairEnd = i;
    }
  }

  if (lastPairEnd < 0) {
    return null;
  }

  const recovered = parseStructuredDetail(`${text.slice(0, lastPairEnd)}}`);
  if (recovered === null) {
    return null;
  }

  // The WIDER set here: a legacy row is stored TEXT, so every bookkeeping key
  // in it was written by whoever wrote the row. Stripping them is what stops a
  // pre-#2704 payload claiming this release produced it — or claiming the
  // sanitiser dropped keys it never saw.
  const marked = without(recovered, RESERVED_KEY_VALUES);
  marked[REDUCED_DETAIL_KEYS.recovered] = true;
  return marked;
}

/** True for the reserved keys a reader should not quote back as evidence. */
export function isReservedDetailKey(key: string): boolean {
  return RESERVED_KEY_VALUES.includes(key);
}
