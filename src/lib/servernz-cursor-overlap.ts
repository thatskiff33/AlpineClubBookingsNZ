import { parseInstant } from "@/lib/club-time";
import logger from "@/lib/logger";

/**
 * The bounded commit-order overlap every ServerNZ incremental pull applies to
 * its stored cursor (#2995 for the Other Clubs pull, #3449 for the shared-post
 * mirror). THE ONE HOME for the window and for the cursor arithmetic — both
 * syncs import from here, and `INV-SSOT-001` is why a second copy is a defect
 * rather than a convenience: the two halves of a rule that has two homes drift
 * apart in both directions before anybody compares them, which is exactly
 * what happened to the "is this a timestamp" test that lived in one sync.
 *
 * WHY THE OVERLAP EXISTS. A cursor pull asks "everything changed since C" and
 * stores the cursor the server returns. Two rows committed at the central
 * server at nearly the same moment are not guaranteed to become visible in the
 * order they were stamped: a row stamped C−1 that commits after the read that
 * returned cursor C is behind the watermark on its first visible read and is
 * never asked for again. Not late — never. Re-asking one bounded window before
 * the stored cursor on every pull closes that gap. The repeated rows cost
 * nothing, because each sync's apply path is idempotent and an older remote
 * row loses to a newer local one — evidence each sync owes in its own tests.
 *
 * THIS APPLIES TO THE REQUEST ONLY. The durable watermark still advances only
 * to the cursor the server returned on a successful pass, never to the
 * overlapped value and never backwards — see {@link advancedDownloadCursor},
 * which is what stops the widened question from slowly moving the answer.
 *
 * IT HOLDS ONLY FOR A CURSOR THIS CODE CAN DO ARITHMETIC ON. Every ServerNZ
 * cursor is contractually opaque, so a server issuing ids or tokens gets no
 * overlap and keeps the defect; {@link overlappedRequestCursor} says so in the
 * log when that is the case, because an inert overlap is otherwise
 * indistinguishable from a working one.
 */
export const PULL_CURSOR_OVERLAP_MS = 60_000;

/**
 * The `Z` or `±HH:MM` an ACCEPTED instant cursor ends with.
 *
 * Read positionally rather than re-matched, and only ever called on a value
 * `parseInstant` has already vouched for. A second regular expression restating
 * the instant shape here is precisely the duplicated rule its caller exists to
 * remove (`INV-SSOT-001`).
 */
function cursorOffsetDesignator(instantCursor: string): string {
  const last = instantCursor.slice(-1);
  if (last === "Z" || last === "z") return last;
  // The offset's sign is the last `+` or `-` in the string; the date's own
  // hyphens are all earlier, so `lastIndexOf` cannot pick one of those.
  return instantCursor.slice(
    Math.max(instantCursor.lastIndexOf("+"), instantCursor.lastIndexOf("-")),
  );
}

/** That designator read as a UTC offset in milliseconds. */
function designatorOffsetMs(designator: string): number {
  if (designator === "Z" || designator === "z") return 0;
  // Both `+13:00` and the basic-format `+1300` are legal and both arrive here.
  const digits = designator.slice(1).replace(":", "");
  const minutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2));
  return (designator.startsWith("-") ? -minutes : minutes) * 60_000;
}

/**
 * The cursor value to REQUEST, given the stored one: one overlap earlier when
 * the stored cursor is an instant, unchanged otherwise, and `null` when there is
 * no stored cursor at all — so an initial/full sync is untouched.
 *
 * `sync` names the caller in the log line an un-steppable cursor produces, so
 * an operator reading it knows WHICH pull is unprotected.
 *
 * THE PARSE IS THE KERNEL'S, not a local regular expression. A local one lived
 * in the Other Clubs sync first and was both narrower and wronger than
 * `parseInstant` in both directions. It missed four legal spellings a central
 * server is free to send — seconds omitted (`…T10:05Z`), a basic-format offset
 * (`+1300`), a lowercase `t`, and a space separator — which are between them
 * what Python's `isoformat()`, .NET and a Postgres `timestamptz` render, so
 * against such a server the overlap was silently inert and the whole fix did
 * nothing. And it ACCEPTED `2026-02-30T00:00:00Z`, which `Date.parse` rolls
 * forward to 2 March: the "step back" then handed the server a cursor two days
 * LATER than the stored one and skipped every row in between — the defect this
 * exists to close, amplified. `parseInstant` refuses that date, and names it.
 *
 * WHATEVER REPLACES THE PARSE MUST STILL DEMAND `Z` OR AN OFFSET. A zone-less
 * `2026-06-20T10:05:30` is not refused by `Date` — it is read in the HOST's
 * zone, so on a New Zealand deployment the requested cursor moves twelve or
 * thirteen hours, silently and plausibly. `parseInstant` is the home of that
 * rule; the note is here because widening the accepted shape is exactly the
 * helpful-looking change that would undo it.
 *
 * IT RE-EMITS IN THE OFFSET IT WAS GIVEN rather than normalising to `Z`, which
 * is not cosmetic either. A server comparing the `since` parameter as TEXT
 * rather than as an instant sees `2026-06-20T10:05:30-05:00` normalise to
 * `2026-06-20T15:04:30.000Z` — a value that sorts AFTER the stored one, turning
 * the overlap into a five-hour jump FORWARD that skips rows. Keeping the
 * original offset, and the original separator, leaves only the date and time
 * digits changed, so the requested value is strictly earlier under both a text
 * comparison and an instant comparison.
 */
export function overlappedRequestCursor(
  stored: string | null,
  sync: string,
): string | null {
  if (!stored) return null;
  const instant = parseInstant(stored);
  if (!instant) {
    // Contractually OPAQUE, so an id, a token or a sequence number is passed
    // through untouched rather than guessed at — and the overlap simply does
    // not apply to that server. SAY SO. Nothing else distinguishes a working
    // overlap from one that has protected nothing since the day it shipped:
    // each sync's summary is identical either way, and widening it to carry a
    // diagnostic nobody reads on a good day would push the noise out to the
    // API response and the admin screen.
    logger.warn(
      { cursor: stored },
      `ServerNZ ${sync}: the stored cursor is not an ISO instant, so the commit-order overlap (#2995) is NOT being applied to this pull`,
    );
    return stored;
  }
  const designator = cursorOffsetDesignator(stored);
  // The date/time separator, which is a `T` in nearly every cursor and a
  // lowercase `t` or a space in the two other legal spellings. Put back for the
  // same reason the offset is: an emitted `T` sorts AFTER a stored space.
  const separator = stored.slice(10, 11);
  const wall = new Date(
    instant.getTime() - PULL_CURSOR_OVERLAP_MS + designatorOffsetMs(designator),
  );
  // `toISOString` renders the shifted wall clock, always as
  // `YYYY-MM-DDTHH:MM:SS.mmmZ`; the cursor's own separator and designator then
  // take the place of that `T` and that `Z`, so only the date and time DIGITS
  // come from the arithmetic. Written as two replacements rather than by cutting
  // the string up, because a ten-character cut of a `toISOString` result is the
  // hand-rolled date-only encoding `INV-DATE-019` bans — a different rule, but
  // this would be indistinguishable from it at a glance and to the linter.
  const requested = wall
    .toISOString()
    .replace("T", separator)
    .replace("Z", designator);
  // Re-checked through the same parser that vouched for the input, so a value
  // this arithmetic cannot express — a year outside four digits — falls back to
  // the stored cursor instead of being sent as a malformed one.
  return parseInstant(requested) ? requested : stored;
}

/**
 * The cursor to PERSIST, given the stored one and the one this pull returned:
 * the later of the two when both are instants, the server's answer otherwise.
 *
 * THE DURABLE WATERMARK MUST NEVER MOVE BACKWARDS — an acceptance criterion of
 * both #2995 and #3449 — and until the overlap existed nothing could push it
 * there, because the request never looked backwards. Now something can. Take
 * the ordinary way a cursor endpoint computes its answer: the newest row it
 * returned, or an echo of `since` when the page is empty. A quiet night then
 * goes stored `C` → request `C − 60s` → no rows → echo `C − 60s` → and the
 * stored watermark BECOMES `C − 60s`. The next quiet run rewinds another
 * minute, an admin pressing Download repeatedly accelerates it, and the
 * re-fetch grows without bound — during exactly the quiet spells that are a
 * sync's normal state. A run that returns rows restores it, which is what
 * would make the symptom intermittent and hard to attribute.
 *
 * An opaque cursor keeps its previous behaviour exactly: nothing here can order
 * two tokens, so the server's answer stands.
 *
 * IT IS NOT ATOMIC against a second runner at the same time — two passes that
 * both read the same stored value can still write in either order. Each sync
 * closes that race with its own single-flight claim; what this comparison
 * stops is the single-runner rewind the overlap introduced.
 */
export function advancedDownloadCursor(
  stored: string | null,
  returned: string | null,
): string | null {
  if (!returned || !stored) return returned;
  const from = parseInstant(stored);
  const to = parseInstant(returned);
  if (!from || !to) return returned;
  return to.getTime() < from.getTime() ? stored : returned;
}
