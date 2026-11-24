/**
 * WHO OWNS THIS BOOKING IS READ IN ONE PLACE — the guard (#3368, `INV-SSOT-005`).
 *
 * Stage 3 of programme #2912 replaced every direct read of a booking's member
 * with `bookingOwner()`. This census is what keeps that true: it reads every
 * non-test source file from disk and fails when a direct read comes back.
 *
 * `pnpm run test:related` CANNOT SELECT THIS FILE. It has no import edge to the
 * tree it scans, so the module graph cannot reach it from a changed file — the
 * same blind spot `AGENTS.md` names for the other disk-scanning censuses in
 * this directory. It is CI-caught by design; run it by name.
 *
 * ## What it looks for, and what it deliberately cannot see
 *
 * A read is `X.member` or `X.memberId` where `X` is a booking. Three ways of
 * knowing that `X` is a booking, in descending order of how much of the tree
 * they cover:
 *
 * 1. **Its NAME ends in "booking"** — `booking`, `fullBooking`,
 *    `payment.booking`, `reviewedBooking`. This is most of the tree and it is
 *    also the shape a new reader is overwhelmingly likely to be written in.
 * 2. **It was BOUND from the booking delegate in the same file** —
 *    `const fresh = await tx.booking.findUnique(...)`. This is the one that
 *    earns its keep: it is how the sweep found `fresh`, `held`, `key`,
 *    `lockTarget` and `entry`, five aliases that a name-based scan cannot see
 *    and that a TYPE-based census missed as well, because each of them selects
 *    two or three columns and nothing in that selection says "booking".
 * 3. **It is the callback parameter of an iteration over something named for
 *    bookings** — `bookings.map((b) => …)`.
 *
 * **Stated limits, because a census that hides its blind spots is worse than no
 * census.** A booking reached through a parameter typed elsewhere, through
 * `for (const child of children)`, through a bracket access, or through a
 * destructure is not seen — though the destructure is separately asserted to be
 * absent below, so that one is a closed door rather than an open blind spot.
 * What makes those limits tolerable is that the accessor is the ONLY import a
 * new reader would reach for; a reader who has gone to the trouble of aliasing
 * a booking through an untyped parameter has gone past several signposts.
 *
 * ## The lists this publishes, and why they are lists rather than counts
 *
 * Stage 4 (#3369) makes the member link optional. The three families below are
 * where a missing member is a correctness problem rather than a display one, so
 * this census keeps them enumerated and current — for the next stage to work
 * from, and so nobody re-derives them by hand at the moment they matter.
 * **Re-measure by running this test; never edit a list by incrementing it.**
 * Each entry is keyed by its file and its own source line, not by a line
 * number (#5232, see `siteKey`), so an edit elsewhere in the file leaves the
 * lists alone.
 *
 * ## The blind spot this census has NOT closed, stated rather than implied
 *
 * Everything here scans for a property READ. Two #3369 defect shapes have no
 * read to find, and a reader who takes this census as covering them will be
 * wrong:
 *
 * - **A Prisma `select` that omits `organisation`.** The accessor can only
 *   build the owner projection when both relations were loaded. The compiler
 *   catches most of it — `Booking.member` is optional now, so reading through
 *   it without the projection is a type error — but an OPTIONAL CHAIN
 *   type-checks and renders a blank. That is the third family below, which is
 *   why it is enumerated.
 * - **A `where` clause that filters THROUGH the relation.** `member: { is: … }`
 *   on a nullable to-one silently excludes every organisation-owned booking
 *   from a page, its pagination window and its count. There is no read and no
 *   type error, and nothing distinguishes a deliberate member-only scope from
 *   an accidental one. This census does not see it and cannot be made to.
 *
 * ## The half of that blind spot that turned out to be closable
 *
 * The paragraphs above were written believing the compiler held the WRITING
 * side while only the READING side needed a census. It does not, and the fourth
 * family below exists because of what that cost.
 *
 * A `select` or `include` is checked against the model only at the TOP level of
 * a Prisma call. A nested one is inferred from the literal itself and then
 * compared with itself, so a relation key the model does not declare compiles
 * silently and raises `PrismaClientValidationError` on the first real call:
 * "Unknown field `organisation` for select statement on model `BookingGuest`".
 * A `select` written where a FILTER belongs fails the same way. Neither shape
 * reaches a test that does not execute the query, and `pnpm run typecheck` is
 * green for both — measured, not assumed.
 *
 * #3369's ownership sweep added `organisation` beside `member` in several
 * hundred selections, textually, because `member:` is the shape it was looking
 * for. Thirteen of those landed where no such relation exists — on
 * `BookingGuest` (the guest's OWN member link, which has nothing to do with who
 * owns the booking), on `HutLeaderAssignment`, on `MemberSubscription`, on
 * `MembershipCancellationRequestParticipant` — and two landed inside a `where`.
 * Every one of them was a crash: the lodge kiosk's guest list, the bed
 * allocation board, the lodge wall's custodian panel, the member-night conflict
 * check on the booking-create path, hut-leader eligibility, and three Xero
 * record pages. They would have shipped.
 *
 * So the fourth family does not scan for a read at all. It resolves each
 * `organisation` selection key back to the model it is written against, through
 * this repository's own datamodel, and fails when there is no such relation
 * there. That is a fact about the schema rather than a judgement about intent,
 * which is exactly why it can be a guard where "is this member-only scope
 * deliberate?" cannot.
 */
import { readFileSync } from "node:fs";
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  relativeSource,
  sourceFiles,
} from "@/lib/__tests__/support/booking-guest-night-writer-scan";
import { stripCommentsAndStrings } from "@/lib/__tests__/support/strip-comments";
import { CENSUS_TIMEOUT_MS } from "@/test/census-timeout";

/**
 * The ONE file allowed to read the column directly: the accessor's own body,
 * which is what every other reader now goes through.
 */
const ACCESSOR = "src/lib/booking-owner.ts";

/** `X.member` / `X.memberId`, with `X` captured as prefix plus last segment. */
const READ =
  /(?<![\w$])((?:[A-Za-z_$][\w$]*\s*\??\.\s*)*)([A-Za-z_$][\w$]*)\s*\??\.\s*(member|memberId)\b/g;

/** `const fresh = await tx.booking.findUnique(` and its assignment form. */
const DELEGATE_BINDING =
  /([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?[A-Za-z_$][\w$.]*\.booking\s*\.\s*(?:findUnique|findUniqueOrThrow|findFirst|findFirstOrThrow|findMany|create|update|upsert)\b/g;

/**
 * `bookings.map((b) => …)` — the callback's parameter is a booking.
 *
 * The name ends in "ookings" after at least one character, which is how
 * `bookings`, `allBookings` and `payment.bookings` are all one pattern.
 * Requiring a leading character AND then an upper- or lower-case B — the
 * obvious way, and how this was first written — silently excluded the bare
 * `bookings`, the commonest spelling in the tree. The fixture below caught it.
 */
const ITERATION_BINDING =
  /[A-Za-z_$][\w$.]*ookings\s*\??\.\s*(?:map|flatMap|filter|forEach|find|findIndex|some|every|reduce)\s*\(\s*\(?\s*([A-Za-z_$][\w$]*)/g;

/**
 * A destructure of the owner off a booking, which would walk around the READ.
 * Ends in "ooking" for the same reason the iteration rule ends in "ookings":
 * the bare `= booking` is the spelling that matters most, and a leading
 * character class could not see it.
 */
const DESTRUCTURE =
  /(?:const|let|var)\s*\{[^}]*\b(?:member|memberId)\b[^}]*\}\s*=\s*[A-Za-z_$][\w$.]*ooking\b/g;

/**
 * `row.booking` — whatever `row` is, it is not itself a booking.
 *
 * The one exclusion the alias rules need, and a STRUCTURAL fact rather than an
 * allowlist, which is why it is written as a rule. The admin work-parties
 * table iterates `detail.attendingBookings`, whose rows are ATTENDANCE
 * records: each carries both the attendee (`row.member`) and the booking
 * (`row.booking`). The iteration rule cannot tell a list of bookings from a
 * list of rows ABOUT bookings by the name alone — but a value with a booking
 * hanging off it has answered the question itself.
 *
 * Scoped to the two ALIAS rules and deliberately not to the name rule: it must
 * never be able to excuse `payment.booking.member`, where the value named for
 * a booking IS the booking.
 */
const CARRIES_A_BOOKING =
  /(?<![\w$])([A-Za-z_$][\w$]*)\s*\??\.\s*booking(?![\w$])/g;

type Hit = { file: string; line: number; via: string; text: string };

function scan(): {
  hits: Hit[];
  destructures: Hit[];
  files: number;
  code: Map<string, string>;
  lines: Map<string, string[]>;
} {
  const hits: Hit[] = [];
  const destructures: Hit[] = [];
  const code = new Map<string, string>();
  const lines = new Map<string, string[]>();
  const files = sourceFiles()
    .map(relativeSource)
    .filter((file) => /^(?:src|scripts)\//.test(file) && file !== ACCESSOR);

  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    const source = stripCommentsAndStrings(raw);
    code.set(file, source);
    lines.set(file, raw.split("\n"));

    const aliases = new Set<string>();
    for (const [, name] of source.matchAll(DELEGATE_BINDING)) aliases.add(name);
    for (const [, name] of source.matchAll(ITERATION_BINDING)) aliases.add(name);
    for (const [, name] of source.matchAll(CARRIES_A_BOOKING)) aliases.delete(name);

    source.split("\n").forEach((text, index) => {
      for (const match of text.matchAll(READ)) {
        const prefix = (match[1] ?? "").replace(/\s/g, "");
        const last = match[2];
        const via = /booking$/i.test(last)
          ? "named for a booking"
          : !prefix && aliases.has(last)
            ? "bound from the booking delegate, or iterated from bookings"
            : null;
        if (!via) continue;
        hits.push({ file, line: index + 1, via, text: text.trim() });
      }
      for (const _ of text.matchAll(DESTRUCTURE)) {
        destructures.push({ file, line: index + 1, via: "destructure", text: text.trim() });
      }
    });
  }
  return { hits, destructures, files: files.length, code, lines };
}

/**
 * A reviewed site's key: `file::<its trimmed source line>#<ordinal>` (#5232).
 *
 * The ordinal counts the lines ABOVE it in the same file whose trimmed text is
 * identical, so two copies of one statement stay distinct. A line number would
 * be shorter, and it is what these lists used until #5232 — but adding or
 * removing any line above a site moved it, so the census failed on edits that
 * never touched a reviewed site and two branches shifting the same file
 * conflicted here. This key moves only when the site's own line changes, or
 * an identical line is added or removed above it.
 *
 * The limit that buys: the key names the code, not where it sits, so deleting
 * a reviewed site and pasting the identical line elsewhere in the same file
 * still passes — a line pin would have caught that move; a reviewer now must.
 *
 * The text is the RAW line, not the comment-and-string-stripped one the rules
 * scan: a key has to read as the code it names. The stripper keeps every
 * newline, so the same index addresses both.
 */
function siteKey(file: string, lines: readonly string[], index: number): string {
  const text = lines[index].trim();
  let ordinal = 0;
  for (let above = 0; above < index; above++) {
    if (lines[above].trim() === text) ordinal++;
  }
  return `${file}::${text}#${ordinal}`;
}

const scanned = scan();

const describeHit = (hit: Hit) =>
  `${hit.file}:${hit.line} (${hit.via}) — ${hit.text.slice(0, 120)}`;

describe("#3368: a booking's owner is read in exactly one place", { timeout: CENSUS_TIMEOUT_MS }, () => {
  it("scans a meaningful number of source files", () => {
    // A walker that silently found nothing would make every assertion below
    // vacuous, which is how a census fails without failing.
    expect(scanned.files).toBeGreaterThan(1500);
  });

  it("finds no direct read of a booking's member outside the accessor", () => {
    expect(
      scanned.hits.map(describeHit),
      "A booking's member is being read directly again. `INV-SSOT-005`: who " +
        "owns a booking is answered by `bookingOwner()` in " +
        "`src/lib/booking-owner.ts` and nowhere else, because stage 4 (#3369) " +
        "makes the member link optional and every one of these sites would " +
        "otherwise need its own answer to what a missing member means. Route " +
        "the read through the accessor; if this really is not a booking, say " +
        "so here with the reason.",
    ).toEqual([]);
  });

  it("finds no destructure of the owner off a booking", () => {
    // The READ pattern is a property access. A destructure would produce a
    // bare `memberId` that no scanner in this tree can attribute to a booking,
    // so the census closes that door rather than living with it: there were
    // none before this stage and there are none now.
    expect(
      scanned.destructures.map(describeHit),
      "`const { memberId } = booking` walks around this census entirely — the " +
        "binding it produces is indistinguishable from any other `memberId`. " +
        "Read it through `bookingOwner()` instead (`INV-SSOT-005`).",
    ).toEqual([]);
  });

  it("FAILS when a new direct read appears (fixture proof)", () => {
    const injected = [
      "const owner = booking.memberId;",
      "sendEmail(reviewedBooking.member.email);",
      "const fresh = await tx.booking.findUnique({});\nnotify(fresh.memberId);",
      "bookings.map((b) => b.member.firstName);",
    ];
    for (const code of injected) {
      const aliases = new Set<string>();
      for (const [, name] of code.matchAll(DELEGATE_BINDING)) aliases.add(name);
      for (const [, name] of code.matchAll(ITERATION_BINDING)) aliases.add(name);
      for (const [, name] of code.matchAll(CARRIES_A_BOOKING)) aliases.delete(name);
      const found = [...code.matchAll(READ)].filter(([, prefix, last]) => {
        const bare = (prefix ?? "").replace(/\s/g, "") === "";
        return /booking$/i.test(last) || (bare && aliases.has(last));
      });
      expect(found.length, `no hit for: ${code}`).toBeGreaterThan(0);
    }
  });

  it("does NOT fire on a read that already goes through the accessor", () => {
    // Without this the census could be "passing" because the sweep deleted the
    // reads rather than routing them, and a reviewer could not tell.
    const routed = "const id = bookingOwner(booking).memberId;";
    const found = [...routed.matchAll(READ)].filter(([, , last]) =>
      /booking$/i.test(last),
    );
    expect(found).toEqual([]);
  });

  it("does NOT fire on a row that merely CARRIES a booking", () => {
    // `detail.attendingBookings.map((row) => row.member.firstName)` in the
    // admin work-parties table: `row` is an attendance record, and its
    // `member` is the ATTENDEE, not a booking's owner. Without this rule the
    // census could only pass by carrying an allowlist.
    const code =
      "attendingBookings.map((row) => row.member.firstName + row.booking.status);";
    const aliases = new Set<string>();
    for (const [, name] of code.matchAll(ITERATION_BINDING)) aliases.add(name);
    expect(aliases.has("row"), "the iteration rule should bind it").toBe(true);
    for (const [, name] of code.matchAll(CARRIES_A_BOOKING)) aliases.delete(name);
    const found = [...code.matchAll(READ)].filter(([, prefix, last]) => {
      const bare = (prefix ?? "").replace(/\s/g, "") === "";
      return /booking$/i.test(last) || (bare && aliases.has(last));
    });
    expect(found).toEqual([]);
  });

  it("does NOT fire on another model's own member link", () => {
    // `BookingGuest.memberId` is the GUEST's member, not the booking's owner,
    // and it is not this rule's business. The name test ends on "booking", so
    // `bookingGuest` is outside it — and that has to stay true, because the
    // tree is full of those reads.
    const guest = "recordGuest(row.bookingGuest.memberId);";
    const found = [...guest.matchAll(READ)].filter(([, , last]) =>
      /booking$/i.test(last),
    );
    expect(found).toEqual([]);
  });
});

/**
 * The three families stage 4 (#3369) HAS NOW DECIDED, site by site.
 *
 * Both are asserted as sorted lists rather than counts: when one changes, the
 * failure shows WHICH site arrived. The #2912 census put the first family at
 * ten and the second at three; both were floors measured on an older tree.
 *
 * WHAT EACH LIST MEANS NOW THAT STAGE 4 HAS LANDED:
 *
 * - The **ownership comparisons** are unchanged in behaviour and deliberately
 *   so. Each is still `bookingOwner(x).memberId !== session.user.id`, still
 *   unconditionally true for an organisation-owned booking, and still means
 *   "not the actor's own" — which is correct, because an organisation never
 *   signs in. The decision is recorded in `src/lib/booking-owner.ts`. The list
 *   stays because entitling a named school liaison to act is a product change
 *   somebody will one day make, and this is the list they will need.
 * - The **member-keyed helpers** have collapsed from seventeen to ONE, and the
 *   collapse is the evidence. Every other site now binds the owner to a local
 *   and branches on it — no member, no ledger — so it no longer matches a
 *   pattern that looks for the owner passed straight in. The one that remains
 *   is a ternary in the diagnostics finance pack, where the branch and the call
 *   are on the same line; it is guarded exactly like the rest.
 */
const COMPARISON =
  /bookingOwner\([^()]*\)\.memberId\s*(?:!==|===|!=|==)|(?:!==|===|!=|==)\s*bookingOwner\([^()]*\)\.memberId/;

const MEMBER_KEYED_HELPER =
  /\b(?:lockMemberCreditLedger|getMemberCreditBalance|findOrCreateXeroContact|restoreCreditFromBooking|createBookingModificationCredit)\(\s*\n?\s*bookingOwner\(/;

/**
 * THE PARTIAL SELECT, seen from the only side a text scan can see it (#3369).
 *
 * The census above scans for a property READ. It cannot see a Prisma `select`
 * that simply OMITS `organisation` — there is no read there to find — and that
 * omission is the third #3369 defect class: `bookingOwner()` can only build the
 * owner projection when the caller loaded BOTH relations, so a query that takes
 * `member` alone hands a school booking's `member` back as `null` and the screen
 * says "Unknown member". Two capacity conflict queries shipped exactly that.
 *
 * WHAT ACTUALLY CATCHES IT is the compiler, in every case but one.
 * `Booking.member` is optional since #3369, so a caller that selected the member
 * alone gets `member: M | null` straight through
 * {@link BookingOwnerView} — and `bookingOwner(x).member.firstName` on that is a
 * type error. The one escape is an OPTIONAL CHAIN, which type-checks, renders a
 * blank, and looks like ordinary defensiveness. That is precisely how both
 * capacity queries passed review.
 *
 * So this family is ENUMERATED rather than banned, because the chain has a
 * legitimate reason too — and, measured across all ten sites, the legitimate
 * reason is the commoner one. The accessor's own docblock records it: a booking
 * that NAMES a member whose row could not be read hands back what the caller
 * has, which is nothing. A caller guarding that documented state loads the
 * organisation AND writes a chain, and its chain is correct even though the
 * TYPE says non-null.
 *
 * The point of the list, therefore, is not that a chain is wrong. It is that
 * the two cases are indistinguishable from the chain alone, so each site has to
 * be TRACED to the query that produced it — and a list is what makes an
 * untraced new one visible. That tracing found one real defect among ten:
 * `roster-eligibility.ts` selected the member without the organisation, so a
 * school's chore group lost its name and degraded to "Booking group 3".
 *
 * STILL NOT SEEN, and saying so is the point of writing it down: a `where`
 * clause that filters THROUGH the relation. `where: { member: { is: … } }` on a
 * nullable to-one excludes every organisation-owned booking from the page, the
 * pagination window and the count, with no property read and no type error
 * anywhere — which is how the admin bookings list search dropped every school
 * booking. Nothing here can see that shape, and no scanner in this tree can tell
 * a deliberate member-only scope from an accidental one. It is a reviewer's job.
 */
const OPTIONAL_OWNER_READ =
  /bookingOwner\([^()]*(?:\([^()]*\))?[^()]*\)\s*\?\.|bookingOwner\([^()]*(?:\([^()]*\))?[^()]*\)\.(?:member|memberId)\s*\?\./;

/**
 * Every key whose stripped line matches `pattern`. `code` and `lines` default
 * to the real tree; the fixture proofs below hand in a small one instead, so
 * the census's own failure modes stay proven rather than probed once (#5232).
 */
function sitesMatching(
  pattern: RegExp,
  code: ReadonlyMap<string, string> = scanned.code,
  rawLines: ReadonlyMap<string, readonly string[]> = scanned.lines,
): string[] {
  const out: string[] = [];
  for (const [file, source] of code) {
    const lines = rawLines.get(file)!;
    source.split("\n").forEach((text, index) => {
      if (pattern.test(text)) out.push(siteKey(file, lines, index));
    });
  }
  return out.sort();
}

describe("#5232: a reviewed site's key survives edits around it", { timeout: CENSUS_TIMEOUT_MS }, () => {
  it("addresses the raw line the rules scanned, in every scanned file", () => {
    // `siteKey` reads the raw line at the index the stripped text matched on.
    // A stripper that dropped or added a newline would key every site below
    // it to the wrong code, and the lists would then review the wrong lines.
    const drifted = [...scanned.code]
      .filter(([file, code]) => code.split("\n").length !== scanned.lines.get(file)!.length)
      .map(([file]) => file);
    expect(drifted).toEqual([]);
  });

  it("keys a site the same way after lines are added or removed above it", () => {
    const site = "  if (bookingOwner(booking).memberId !== session.user.id) {";
    const before = ["import x;", site, "}"];
    const after = ["import x;", "", "// a new comment", "const y = 1;", site, "}"];
    expect(siteKey("f.ts", after, 4)).toBe(siteKey("f.ts", before, 1));
    expect(siteKey("f.ts", before, 1)).toBe(
      "f.ts::if (bookingOwner(booking).memberId !== session.user.id) {#0",
    );
  });

  it("tells identical lines apart by their order in the file", () => {
    const line = "memberId: bookingOwner(booking).member?.id ?? null,";
    const lines = [line, "other();", `    ${line}`];
    expect(siteKey("f.ts", lines, 0)).toBe(`f.ts::${line}#0`);
    expect(siteKey("f.ts", lines, 2)).toBe(`f.ts::${line}#1`);
  });

  // A one-file tree, stripped exactly as `scan()` strips the real one.
  const tree = (raw: string) => ({
    code: new Map([["f.ts", stripCommentsAndStrings(raw)]]),
    lines: new Map([["f.ts", raw.split("\n")]]),
  });
  const census = (raw: string) => {
    const { code, lines } = tree(raw);
    return sitesMatching(COMPARISON, code, lines);
  };
  const reviewedFile = [
    "export function a(booking, session) {",
    "  if (bookingOwner(booking).memberId !== session.user.id) return;",
    "}",
    "export function b(booking, session) {",
    "  return bookingOwner(booking).memberId === session.user.id;",
    "}",
  ];
  const reviewed = census(reviewedFile.join("\n"));

  it("reviews the fixture's two comparisons (fixture baseline)", () => {
    expect(reviewed).toEqual([
      "f.ts::if (bookingOwner(booking).memberId !== session.user.id) return;#0",
      "f.ts::return bookingOwner(booking).memberId === session.user.id;#0",
    ]);
  });

  it("does NOT move when lines are added or removed around a reviewed site (fixture proof)", () => {
    const shifted = [
      "import { bookingOwner } from './booking-owner';",
      "",
      "// a new comment",
      ...reviewedFile.slice(0, 3),
      "const unrelated = 1;",
      ...reviewedFile.slice(3),
    ];
    expect(census(shifted.join("\n"))).toEqual(reviewed);
  });

  it("FAILS by name when a new site appears (fixture proof)", () => {
    const added = [
      ...reviewedFile,
      "export const c = (booking, actor) => bookingOwner(booking).memberId != actor.id;",
    ];
    const sites = census(added.join("\n"));
    expect(sites).not.toEqual(reviewed);
    expect(sites.filter((site) => !reviewed.includes(site))).toEqual([
      "f.ts::export const c = (booking, actor) => bookingOwner(booking).memberId != actor.id;#0",
    ]);
  });

  it("FAILS by name when a reviewed site is removed (fixture proof)", () => {
    const removed = reviewedFile.filter((_, index) => index !== 4);
    const sites = census(removed.join("\n"));
    expect(sites).not.toEqual(reviewed);
    expect(reviewed.filter((site) => !sites.includes(site))).toEqual([
      "f.ts::return bookingOwner(booking).memberId === session.user.id;#0",
    ]);
  });

  it("FAILS by name when a reviewed site's own line is edited (fixture proof)", () => {
    const edited = reviewedFile.map((line, index) =>
      index === 1
        ? "  if (bookingOwner(booking).memberId !== session.user.memberId) return;"
        : line,
    );
    const sites = census(edited.join("\n"));
    expect(sites).not.toEqual(reviewed);
    expect(reviewed.filter((site) => !sites.includes(site))).toEqual([
      "f.ts::if (bookingOwner(booking).memberId !== session.user.id) return;#0",
    ]);
  });

  it("does NOT see a reviewed line deleted and pasted identically elsewhere (the key's stated limit)", () => {
    // Pinned so the docblock on `siteKey` stays true: the key names the code,
    // not its position, so moving an unchanged line within its file is
    // invisible here. A reviewer sees the move in the diff; this census
    // cannot.
    const moved = [
      ...reviewedFile.slice(0, 1),
      ...reviewedFile.slice(2),
      "export function moved(booking, session) {",
      reviewedFile[1],
      "}",
    ];
    expect(census(moved.join("\n"))).toEqual(reviewed);
  });

  it("FAILS by name when a new unrooted selection appears (fixture proof)", () => {
    const before = "export const OWNER = { member: true } as const;";
    const after = `${before}\nexport const ORG = { organisation: { select: { name: true } } } as const;`;
    const unrooted = (raw: string) =>
      selectionsIn("f.ts", raw).filter((s) => !s.rooted).map((s) => s.site);
    expect(unrooted(before)).toEqual([]);
    expect(unrooted(after)).toEqual([
      "f.ts::export const ORG = { organisation: { select: { name: true } } } as const;#0",
    ]);
  });

  it("keys a selection by its raw line, not the string-blanked one", () => {
    const code = `const rows = await prisma.booking.findMany({
  select: { organisation: { select: { name: true } } }, // "the owner"
});`;
    expect(selectionsIn("f.ts", code).map((s) => s.site)).toEqual([
      'f.ts::select: { organisation: { select: { name: true } } }, // "the owner"#0',
    ]);
  });
});

describe("#3368: the three families stage 4 (#3369) has to answer for", { timeout: CENSUS_TIMEOUT_MS }, () => {
  it("enumerates every ownership comparison against an actor", () => {
    const sites = sitesMatching(COMPARISON);
    expect(
      sites,
      "The set of `is this booking the actor's own?` comparisons has moved. " +
        "Every one of them becomes unconditionally true once a booking can be " +
        "owned by an organisation, so stage 4 (#3369) works from this list. " +
        "RE-MEASURE BY RUNNING THIS TEST and paste the result — a list edited " +
        "by hand is a list that has already drifted. The decision about what " +
        "these comparisons mean is in `src/lib/booking-owner.ts` " +
        "(`INV-SSOT-005`).",
    ).toEqual(OWNERSHIP_COMPARISON_SITES);
  });

  it("enumerates every member-keyed helper handed the owner's id", () => {
    const sites = sitesMatching(MEMBER_KEYED_HELPER);
    expect(
      sites,
      "The set of member-keyed credit, ledger and Xero calls taking a " +
        "booking's owner has moved. A null member id either throws inside the " +
        "helper or degenerates to a shared advisory key, which is an " +
        "`INV-LOCK` hazard that only appears under concurrency — so stage 4 " +
        "(#3369) branches at each of these rather than passing an empty key. " +
        "RE-MEASURE BY RUNNING THIS TEST rather than editing the list.",
    ).toEqual(MEMBER_KEYED_HELPER_SITES);
  });

  it("enumerates every owner read that survives a missing projection", () => {
    const sites = sitesMatching(OPTIONAL_OWNER_READ);
    expect(
      sites,
      "The set of optional-chained owner reads has moved. A chain on " +
        "`bookingOwner(...)` is the ONE spelling of the partial-select defect " +
        "that type-checks: if the query behind it selected `member` without " +
        "`organisation`, the accessor cannot build the owner projection, an " +
        "organisation-owned booking reads back as `null`, and the screen says " +
        "'Unknown member' or nothing at all. Three queries shipped exactly " +
        "that in #3369 — two capacity conflict lists and the chore roster. " +
        "A chain can ALSO be a correct guard against the named-but-unreadable " +
        "member the accessor documents, and the two are indistinguishable " +
        "from here. So TRACE a new site to the query that produced it before " +
        "adding it: if the organisation belongs in that selection, add it and " +
        "drop the chain. RE-MEASURE BY RUNNING THIS TEST rather than editing " +
        "the list (`INV-SSOT-005`).",
    ).toEqual(OPTIONAL_OWNER_READ_SITES);
  });

  it("FAILS when a new optional-chained owner read appears (fixture proof)", () => {
    // Both spellings, and the nested-call form the capacity queries used.
    for (const code of [
      "const name = bookingOwner(row).member?.firstName;",
      "const id = bookingOwner(payment.booking)?.memberId;",
      "if (bookingOwner(booking).member?.email) return;",
    ]) {
      expect(OPTIONAL_OWNER_READ.test(code), `no hit for: ${code}`).toBe(true);
    }
  });

  it("does NOT fire on an owner read that loaded the whole projection", () => {
    // The fixed shape. Without this the rule could be "passing" because it
    // matches every `bookingOwner(` call, which would make the list above a
    // list of every reader in the tree rather than of the ones at risk.
    for (const code of [
      "const name = bookingOwner(row).member.firstName;",
      "const id = bookingOwner(booking).memberId;",
      "return bookingOwner(payment.booking).member.email ?? '';",
    ]) {
      expect(OPTIONAL_OWNER_READ.test(code), `false hit for: ${code}`).toBe(
        false,
      );
    }
  });
});

/** Measured, not counted by hand. Re-measure by running this test. */
const OWNERSHIP_COMPARISON_SITES: readonly string[] = [
  "src/app/(authenticated)/bookings/[id]/_lib/booking-detail-editor-data.ts::viewerIsBookingOwner: bookingOwner(booking).memberId === session.user.id,#0",
  "src/app/(authenticated)/bookings/[id]/_lib/booking-detail-viewer.ts::const isBookingOwner = bookingOwner(booking).memberId === session.user.id;#0",
  "src/app/(authenticated)/bookings/[id]/page.tsx::(isAdmin || bookingOwner(booking).memberId === session.user.id);#0",
  "src/app/(authenticated)/bookings/page.tsx::bookingOwner(booking).memberId !== session.user.id#0",
  "src/app/api/bookings/[id]/additional-payment-secret/route.ts::bookingOwner(payment.booking).memberId !== session.user.id &&#0",
  "src/app/api/bookings/[id]/arrival-time/route.ts::bookingOwner(booking).memberId !== user.id &&#0",
  "src/app/api/bookings/[id]/arrival-time/route.ts::bookingOwner(booking).memberId !== user.id &&#1",
  "src/app/api/bookings/[id]/arrival-time/route.ts::onBehalf: bookingOwner(booking).memberId !== session.user.id,#0",
  "src/app/api/bookings/[id]/arrival-time/route.ts::onBehalf: bookingOwner(booking).memberId !== session.user.id,#1",
  "src/app/api/bookings/[id]/cancel-preview/route.ts::if (bookingOwner(booking).memberId !== session.user.id && !officerReach) {#0",
  "src/app/api/bookings/[id]/change-requests/quote/route.ts::if (bookingOwner(booking).memberId !== session.user.id && !isAdmin) {#0",
  "src/app/api/bookings/[id]/change-requests/route.ts::if (bookingOwner(booking).memberId !== session.user.id && !isAdmin) {#0",
  "src/app/api/bookings/[id]/change-requests/route.ts::if (bookingOwner(booking).memberId !== session.user.id && !isAdmin) {#1",
  "src/app/api/bookings/[id]/confirm-draft/route.ts::bookingOwner(booking).memberId !== null &&#0",
  "src/app/api/bookings/[id]/confirm-draft/route.ts::if (bookingOwner(booking).memberId !== session.user.id && !isAdmin) {#0",
  "src/app/api/bookings/[id]/confirm-modification-payment/route.ts::bookingOwner(payment.booking).memberId !== session.user.id &&#0",
  "src/app/api/bookings/[id]/confirm-payment/route.ts::bookingOwner(payment.booking).memberId !== session.user.id &&#0",
  "src/app/api/bookings/[id]/exception-requests/route.ts::if (bookingOwner(booking).memberId !== session.user.id && !isAdmin) {#0",
  "src/app/api/bookings/[id]/guests/route.ts::bookingOwner(booking).memberId !== session.user.id &&#0",
  "src/app/api/bookings/[id]/modify-quote/route.ts::if (bookingOwner(booking).memberId !== session.user.id && !isAdmin) {#0",
  "src/app/api/bookings/[id]/notes/route.ts::bookingOwner(booking).memberId !== user.id &&#0",
  "src/app/api/bookings/[id]/refund-request/route.ts::if (bookingOwner(booking).memberId !== session.user.id && !hasAdminAccess(memberOnlySessionUser(req, session.user))) {#0",
  "src/app/api/bookings/[id]/refund-request/route.ts::if (bookingOwner(booking).memberId !== session.user.id && !hasAdminAccess(memberOnlySessionUser(req, session.user))) {#1",
  "src/app/api/bookings/[id]/requested-room/options/route.ts::bookingOwner(booking).memberId !== user.id &&#0",
  "src/app/api/bookings/[id]/send-guest-payment-link/route.ts::if (bookingOwner(booking).memberId !== session.user.id && !isAdmin) {#0",
  "src/app/api/payments/create-payment-intent/route.ts::if (bookingOwner(booking).memberId !== session.user.id && !hasAdminAccess(session.user)) {#0",
  "src/app/api/payments/create-setup-intent/route.ts::if (bookingOwner(booking).memberId !== session.user.id && !hasAdminAccess(session.user)) {#0",
  "src/app/api/payments/switch-to-internet-banking/route.ts::if (bookingOwner(booking).memberId !== session.user.id && !hasAdminAccess(session.user)) {#0",
  "src/lib/adult-member-hosting-review.ts::return actorMemberId !== null && actorMemberId === bookingOwner(booking).memberId#0",
  "src/lib/booking-batch-modification-service.ts::!(actor.role !== \"ADMIN\" && bookingOwner(booking).memberId !== actor.id)#0",
  "src/lib/booking-cancel.ts::? `Booking cancelled. ${refundPercentage}% refund of ${formatCents(refundAmountCents, format)}: ${ownCardRefundWithShortfallSentence(plannedCardRefundCents, { ...shortfallParts, formatAmount: (cents) => formatCents(cents, format) }, !refundMade, sessionUserId === bookingOwner(fresh).memberId ? \"your\" : \"the member's\")}`#0",
  "src/lib/booking-cancel.ts::bookingOwner(booking).memberId !== sessionUserId &&#0",
  "src/lib/booking-date-modification-service.ts::if (bookingOwner(booking).memberId !== actor.id && actor.role !== \"ADMIN\") {#0",
  "src/lib/booking-delete.ts::bookingOwner(booking).memberId !== input.actor.memberId &&#0",
  "src/lib/booking-delete.ts::if (bookingOwner(booking).memberId !== actor.memberId && actor.role !== \"ADMIN\") {#0",
  "src/lib/booking-email-authority.ts::bookingOwner(booking).memberId === recipientMemberId#0",
  "src/lib/booking-guest-removal-service.ts::(bookingOwner(booking).memberId === actorMemberId || actorRole === \"ADMIN\");#0",
  "src/lib/booking-guest-removal-service.ts::bookingOwner(booking).memberId === actorMemberId ? \"BOOKER\" : \"OTHER_PARTY_MEMBER\",#0",
  "src/lib/booking-linked-date-move-service.ts::if (args.actor.id !== bookingOwner(before).memberId) {#0",
  "src/lib/booking-member-night-conflicts.ts::const isOwnBooking = bookingOwner(guest.booking).memberId === actorMemberId;#0",
  "src/lib/booking-modify-validation.ts::if (bookingOwner(booking).memberId !== actorId && role !== \"ADMIN\") {#0",
  "src/lib/diagnostics/tools/packs/booking-evidence.ts::bookingOwner(booking).memberId === null#0",
  "src/lib/group-booking.ts::if (bookingOwner(booking).memberId !== sessionUserId) {#0",
  "src/lib/kiosk-access.ts::bookingOwner(b).memberId === user.id#0",
  "src/lib/manual-refund-task-queue-payload.ts::bookingOwner(task.booking).memberId === viewerMemberId,#0",
  "src/lib/member-self-read.ts::const madeByMe = bookingOwner(row).memberId === memberId;#0",
  "src/lib/requested-room-write.ts::if (!input.actorIsAdmin && bookingOwner(booking).memberId !== input.actorMemberId) {#0",
  "src/lib/waitlist-cross-lodge.ts::bookingOwner(preflight).memberId === memberId &&#0",
  "src/lib/waitlist-cross-lodge.ts::if (bookingOwner(entry).memberId !== memberId) {#0",
  "src/lib/waitlist.ts::bookingOwner(offerKind).memberId === memberId &&#0",
  "src/lib/waitlist.ts::if (bookingOwner(booking).memberId !== memberId) {#0",
  "src/lib/waitlist.ts::if (options.crossLodgeOnWebsiteOnly && bookingOwner(offerKind).memberId === memberId) {#0",
  "src/lib/xero-applied-credit-spent-outside-app.ts::if (!current?.payment || current.payment.id !== paymentId || bookingOwner(current).memberId !== lockedOwnerId) {#0",
  "src/lib/xero-period-lock-guard.ts::bookingOwner(booking).memberId !== options?.actorMemberId#0",
];

/** Measured, not counted by hand. Re-measure by running this test. */
const OPTIONAL_OWNER_READ_SITES: readonly string[] = [
  // Ten were traced. One — `roster-eligibility.ts` — really had the missing
  // projection and is fixed. Four were the same question spelled by hand,
  // "is there an address to send to?", and now ask `bookingOwnerEmail()`,
  // which is where that chain belongs. Four remain (the fifth, the owner's age
  // tier as a predicate input, went with #5190's settlement loader), each
  // loading the organisation and each guarding the named-but-unreadable member:
  // the booker's display NAME, two durable records that store the owner's
  // member id (null for a school), and one admin health snapshot that renders
  // the address with its own `?? ""`.
  "src/lib/member-guest-consent-service.ts::[bookingOwner(booking).member?.firstName, bookingOwner(booking).member?.lastName]#0",
  "src/lib/payment-recovery.ts::memberId: bookingOwner(booking).member?.id ?? null,#0",
  "src/lib/payment-recovery.ts::memberId: bookingOwner(booking).member?.id ?? null,#1",
  "src/lib/xero-admin-health.ts::? (bookingOwner(payment.booking).member?.email ?? \"\")#0",
];

/** Measured, not counted by hand. Re-measure by running this test. */
const MEMBER_KEYED_HELPER_SITES: readonly string[] = [
  "src/lib/diagnostics/tools/packs/finance-evidence.ts::? getMemberCreditBalance(bookingOwner(booking).memberId as string, tx)#0",
];

/* -------------------------------------------------------------------------- */
/* The fourth family: a selection key resolved against the datamodel.          */
/* -------------------------------------------------------------------------- */

/**
 * Keys that structure a Prisma argument rather than name a relation.
 *
 * Walking outward from an `organisation` key, these are stepped over; anything
 * else is a relation field and has to resolve on the model reached so far.
 */
const STRUCTURAL_KEYS = new Set([
  "select", "include", "omit", "data", "where", "is", "isNot", "some",
  "every", "none", "AND", "OR", "NOT", "create", "update", "connect",
  "connectOrCreate", "upsert", "orderBy", "_count", "args",
]);

/** Every model in this repository's datamodel, by name, with its fields. */
const MODEL_FIELDS = new Map(
  Prisma.dmmf.datamodel.models.map((model) => [
    model.name,
    new Map(model.fields.map((field) => [field.name, field])),
  ]),
);

/** `prisma.bookingGuest` -> `BookingGuest`. The delegate naming is mechanical. */
const MODEL_BY_DELEGATE = new Map(
  [...MODEL_FIELDS.keys()].map((name) => [
    name[0].toLowerCase() + name.slice(1),
    name,
  ]),
);

/**
 * An `organisation` key written as a Prisma SELECTION: `{ select: … }`,
 * `{ include: … }` or `true`.
 *
 * Deliberately not every `organisation: {`. A hand-written TypeScript type
 * (`organisation: { name: string; email: string | null } | null`) and a
 * relation FILTER (`organisation: { is: … }`) are both correct and neither is a
 * selection. The filter is also already checked by the compiler, because a
 * `where` is typed from the top of the call rather than inferred from its own
 * literal.
 */
const SELECTION_KEY =
  /(?<![\w$])organisation\s*:\s*(?:true\b|\{\s*(?:select|include)\b)/g;

type Selection = {
  site: string;
  /** The model the key is written against, where the walk could reach one. */
  model: string | undefined;
  /** Did the walk reach a rooted Prisma call? */
  rooted: boolean;
  /** Does that model actually declare an `organisation` relation? */
  declared: boolean | null;
  /** Is the key a `select`/`include` sitting inside a `where`? */
  inFilter: boolean;
};

/**
 * Walk outward from each selection key, collecting the key that opened every
 * enclosing brace, until a dotted callee (`prisma.booking.findMany`) names the
 * root model — then walk that path back DOWN the datamodel.
 */
function selectionsIn(file: string, rawSource: string): Selection[] {
  const source = stripCommentsAndStrings(rawSource);
  const rawLines = rawSource.split("\n");
  const found: Selection[] = [];
  for (const match of source.matchAll(SELECTION_KEY)) {
    const at = match.index ?? 0;
    const path: string[] = [];
    let rootModel: string | undefined;
    let cursor = at;
    for (let hop = 0; hop < 40; hop++) {
      let depth = 0;
      let open = cursor - 1;
      for (; open >= 0; open--) {
        const char = source[open];
        if (char === "}") depth++;
        else if (char === "{") {
          if (depth === 0) break;
          depth--;
        }
      }
      if (open < 0) break;
      const before = source
        .slice(Math.max(0, open - 240), open)
        .match(/([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*(?::|\()\s*$/);
      if (!before) break;
      const key = before[1].replace(/\s+/g, "");
      if (key.includes(".")) {
        rootModel = MODEL_BY_DELEGATE.get(key.split(".").slice(-2)[0]);
        break;
      }
      path.unshift(key);
      cursor = open;
    }

    let model = rootModel;
    let rooted = Boolean(rootModel);
    for (const key of path) {
      if (STRUCTURAL_KEYS.has(key)) continue;
      const field = model ? MODEL_FIELDS.get(model)?.get(key) : undefined;
      if (!field || field.kind !== "object") {
        rooted = false;
        model = undefined;
        break;
      }
      model = field.type;
    }

    found.push({
      site: siteKey(file, rawLines, source.slice(0, at).split("\n").length - 1),
      model,
      rooted,
      declared: model ? MODEL_FIELDS.get(model)!.has("organisation") : null,
      inFilter: path.includes("where") && !match[0].trimEnd().endsWith("true"),
    });
  }
  return found;
}

const selections = [...scanned.code.keys()].flatMap((file) =>
  selectionsIn(file, readFileSync(file, "utf8")),
);

describe("#3369: an `organisation` selection names a relation that exists", { timeout: CENSUS_TIMEOUT_MS }, () => {
  it("scans a meaningful number of selections", () => {
    // Without this the assertions below pass on an empty walk, which is
    // exactly how the sweep's thirteen crashes survived a green suite.
    expect(selections.length).toBeGreaterThan(80);
    expect(selections.filter((s) => s.rooted).length).toBeGreaterThan(80);
  });

  it("finds no selection on a model with no organisation relation", () => {
    expect(
      selections
        .filter((s) => s.rooted && s.declared === false)
        .map((s) => `${s.site} (model ${s.model})`)
        .sort(),
      "A Prisma `select`/`include` names `organisation` on a model that has " +
        "no such relation. This COMPILES — a nested selection is inferred " +
        "from its own literal rather than checked against the model — and it " +
        "throws `PrismaClientValidationError` on the first real call, taking " +
        "the whole screen with it. Only `Booking`, `BookingRequest` and " +
        "`OrganisationContact` declare the relation. A guest's `member` is the " +
        "GUEST's own member link and never the booking's owner, so the owner " +
        "belongs on the enclosing booking selection rather than beside it.",
    ).toEqual([]);
  });

  it("finds no select written where a filter belongs", () => {
    expect(
      selections.filter((s) => s.inFilter).map((s) => s.site).sort(),
      "A `where` clause carries `organisation: { select: … }`. A select is " +
        "not a filter operator, so this throws `Unknown argument select` — " +
        "and even spelled correctly as `organisation: { is: … }` it would be " +
        "ANDed with any sibling `member` filter, which " +
        "`Booking_owner_exactly_one` makes unsatisfiable, so the search would " +
        "return nothing for every name. Give the organisation its own OR arm, " +
        "the way `admin-bookings-service.ts` and `admin-payments-service.ts` " +
        "do.",
    ).toEqual([]);
  });

  it("publishes the selections this walk cannot root", () => {
    expect(
      selections.filter((s) => !s.rooted).map((s) => s.site).sort(),
      "The set of `organisation` selections whose model this walk cannot " +
        "reach has moved. These are standalone selection constants and Prisma " +
        "type computations: the literal names no delegate, so nothing here " +
        "can say which model it is for. Four of them are compile-checked " +
        "anyway, by `Prisma.validator<Prisma.…Select>()` or by sitting in a " +
        "type position; the bare `const … = { … } as const` ones are not, and " +
        "wrapping one in `Prisma.validator` is how it comes off this list. A " +
        "NEW entry here is a site nothing checks — verify by hand which model " +
        "it is written against. RE-MEASURE BY RUNNING THIS TEST.",
    ).toEqual(UNROOTED_ORGANISATION_SELECTIONS);
  });

  it("FAILS on each shape the #3369 sweep actually shipped (fixture proof)", () => {
    const guestSelect = `
      const rows = await prisma.bookingGuest.findMany({
        select: {
          member: { select: { id: true } },
          organisation: { select: { name: true, email: true } },
        },
      });`;
    const nestedGuest = `
      const rows = await prisma.booking.findMany({
        select: {
          organisation: { select: { name: true } },
          guests: {
            select: {
              member: { select: { ageTier: true } },
              organisation: { select: { name: true } },
            },
          },
        },
      });`;
    const filter = `
      const rows = await prisma.booking.findMany({
        where: {
          member: { active: true },
          organisation: { select: { name: true, email: true } },
        },
        select: { id: true },
      });`;

    const bad = (code: string) =>
      selectionsIn("fixture.ts", code).filter(
        (s) => (s.rooted && s.declared === false) || s.inFilter,
      );
    expect(bad(guestSelect), "guest select").toHaveLength(1);
    // The booking's own selection is correct; only the guest's is not.
    expect(selectionsIn("fixture.ts", nestedGuest)).toHaveLength(2);
    expect(bad(nestedGuest), "nested guest select").toHaveLength(1);
    expect(bad(filter), "select used as a filter").toHaveLength(1);
  });

  it("does NOT fire on the shapes that are correct (fixture proof)", () => {
    const correct = `
      const one = await prisma.booking.findUnique({
        select: { member: { select: { id: true } }, organisation: { select: { name: true } } },
      });
      const two = await prisma.payment.findMany({
        select: { booking: { select: { organisation: { select: { name: true } } } } },
      });
      const three = await prisma.bookingRequest.findMany({
        select: { organisation: { select: { name: true } } },
      });
      const four = await prisma.booking.findMany({
        where: { organisation: { is: { name: { contains: term } } } },
        select: { id: true },
      });
      type Row = { organisation: { name: string; email: string | null } | null };`;
    const found = selectionsIn("fixture.ts", correct);
    // The `where` filter spelled `is` and the type declaration are not
    // SELECTIONS at all, so the pattern must not pick them up: three hits.
    expect(found).toHaveLength(3);
    expect(found.filter((s) => !s.rooted)).toEqual([]);
    expect(found.filter((s) => s.declared === false)).toEqual([]);
    expect(found.filter((s) => s.inFilter)).toEqual([]);
  });
});

/** Measured, not counted by hand. Re-measure by running this test. */
const UNROOTED_ORGANISATION_SELECTIONS: readonly string[] = [
  "src/app/api/admin/payments/manual-refund-tasks/route.ts::organisation: { select: { name: true, email: true } },#0",
  "src/lib/bed-allocation-removal.ts::organisation: { select: { name: true, email: true } },#0",
  // #5407: `BUMP_NOTICE_BOOKING_SELECT`, what the bump-notice sweep reads
  // again. Verified by hand: written through
  // `Prisma.validator<Prisma.BookingSelect>()`, read back through
  // `Prisma.BookingGetPayload<{ select: typeof … }>`, and passed as `select` to
  // `booking.findUnique`; Booking declares `organisation`.
  "src/lib/booking-bump-notice-owed.ts::organisation: { select: { name: true, email: true } },#0",
  // #3750: the change-request decision route's `includeRequestDetail`, moved
  // out of the route file to keep it in budget. Verified by hand: it is passed
  // as `include` to `bookingChangeRequest.findUnique`, and `organisation` sits
  // under its `booking` relation, which declares it.
  "src/lib/booking-change-request-admin-decision.ts::organisation: { select: { name: true, email: true } },#0",
  // #4925: `EDIT_DOOR_BOOKING_INCLUDE`, the one include every edit door
  // re-reads its booking with. Verified by hand: written
  // `satisfies Prisma.BookingInclude` and read back through
  // `Prisma.BookingGetPayload<{ include: typeof … }>`, so it is compile-checked
  // against Booking, which declares `organisation`.
  "src/lib/booking-modify-validation.ts::organisation: { select: { name: true, email: true } },#0",
  // #4042, #3949: the owner-name select, moved out of the organiser hand-back to
  // be shared with the joiner cancel's organiser name. Verified by hand: written
  // through `Prisma.validator<Prisma.BookingSelect>()` and spread into
  // `booking.findUniqueOrThrow`/`findMany` selects, and Booking declares
  // `organisation`.
  "src/lib/booking-owner-name.ts::organisation: { select: { name: true, email: true } },#0",
  // #5398: the two hold-conflict readers' select, written once as
  // `HOLD_CONFLICT_BOOKING_SELECT` (both copies were rooted `booking.findMany`
  // selects before). Verified by hand: written `satisfies Prisma.BookingSelect`,
  // read back through `Prisma.BookingGetPayload<{ select: typeof … }>`, passed as
  // `select` to both `booking.findMany` calls; Booking declares `organisation`.
  "src/lib/capacity.ts::organisation: { select: { name: true, email: true } },#0",
  "src/lib/cron-additional-payment-reminders.ts::organisation: { select: { name: true, email: true } },#0",
  "src/lib/cron-confirm-pending.ts::organisation: { select: { name: true, email: true } },#0",
  "src/lib/diagnostics/tools/packs/booking-evidence.ts::organisation: { select: { name: true, email: true } },#0",
  // #3740: `resolveManualRefundTask`'s select, moved out of that module to keep
  // it in budget. Verified by hand: written through
  // `Prisma.validator<Prisma.ManualRefundTaskSelect>()`, and `organisation` sits
  // under its `booking` relation, which declares it.
  // #5197: the reopen core's select, shared by an officer's reopen and a late
  // win's. Verified by hand: written through
  // `Prisma.validator<Prisma.ManualRefundTaskSelect>()` and read back through
  // `Prisma.ManualRefundTaskGetPayload`, and `organisation` sits under its
  // `booking` relation, which declares it.
  "src/lib/manual-refund-task-reopen.ts::booking: { select: { memberId: true, status: true, organiserSettled: true, parentBookingId: true, payment: { select: { source: true } }, organisation: { select: { name: true, email: true } } } },#0",
  "src/lib/manual-refund-task-resolution-select.ts::organisation: { select: { name: true, email: true } },#0",
  // Added when the member lodge roster (#2942, from `main`) was routed through
  // `bookingOwner()` on the eighth epic sync. Verified by hand, which is what
  // this list asks for: `MEMBER_ROSTER_BOOKING_SELECT` is written
  // `satisfies Prisma.BookingSelect` and is read back through
  // `Prisma.BookingGetPayload<{ select: typeof … }>`, so the model IS
  // compile-checked and a relation this model did not declare would fail to
  // build. The walk cannot root it only because the literal names no delegate.
  "src/lib/member-lodge-roster.ts::organisation: { select: { name: true } },#0",
  "src/lib/payment-link.ts::organisation: { select: { name: true; email: true } };#0",
  "src/lib/payment-reconciliation.ts::organisation: { select: { name: true; email: true } };#0",
  // The pre-arrival reminder's include, moved out of the daily cron so the
  // officer's fresh-copy action reads the booking the same way. Verified by
  // hand: written `satisfies Prisma.BookingInclude`, read back through
  // `Prisma.BookingGetPayload`, and passed as `include` to `booking.findMany`
  // and `booking.findUnique`; Booking declares `organisation`.
  "src/lib/pre-arrival-reminder-email.ts::organisation: { select: { name: true, email: true } },#0",
  "src/lib/stuck-state-dashboard.ts::organisation: { select: { name: true, email: true } },#0",
  // #5433: `EXPIRED_NOTICE_SELECT` and `OFFER_NOTICE_SELECT`, what the
  // waitlist offer-expired and offer notices' sweeps read again. Verified by
  // hand: each written through `Prisma.validator<Prisma.BookingSelect>()` and
  // passed as `select` to `booking.findUnique`; Booking declares `organisation`.
  "src/lib/waitlist-offer-expired-notice.ts::organisation: { select: { name: true, email: true } },#0",
  "src/lib/waitlist-offer-notices.ts::organisation: { select: { name: true, email: true } },#0",
  // #5433 review: `RESTART_SELECT`, what the window restart re-reads under its
  // locks to decide whether an email can go. Verified by hand: written through
  // `Prisma.validator<Prisma.BookingSelect>()` and passed as `select` to
  // `booking.findUnique`; Booking declares `organisation`.
  "src/lib/waitlist-offer-window-restart.ts::organisation: { select: { name: true, email: true } },#0",
  "src/lib/xero-booking-repair-types.ts::organisation: { select: { name: true, email: true } },#0",
  "src/lib/xero-inbound/settlement-conflicts.ts::include: { booking: { include: { member: true, organisation: { select: { name: true, email: true } } } } };#0",
];
