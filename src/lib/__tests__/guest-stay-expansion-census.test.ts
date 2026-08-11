import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Census: every place a stay becomes nights is declared here (#2628).
 *
 * `BookingGuestNight` is the canonical night set. `BookingGuest.stayStart` /
 * `stayEnd` is a DERIVED half-open envelope whose `stayEnd` is the morning
 * after the last night (INV-DATE-012). They agree for a contiguous stay; for a
 * SPARSE one the envelope silently fills the internal gaps. Six sites expanded
 * a stay into nights and three of them read the envelope, so a guest booked on
 * nights {1, 3} was reported as awaiting a bed forever, could never reach
 * `"complete"`, and could only ever be checked out once.
 *
 * The fix routed those three at one helper module. The failure mode that comes
 * BACK is a seventh copy: somebody needs a night list, writes
 * `eachDateOnlyInRange(guest.stayStart, guest.stayEnd)` because it is two
 * imports away, and the sparse case is wrong again in a new place. The
 * inventory lived in reviewers' heads, so this file makes it mechanical, in the
 * style of `night-occupancy-census.test.ts` and `api-route-boundaries.test.ts`:
 * a new expansion site has to be classified here or the build fails.
 *
 * ## What this census does and does not guarantee
 *
 * It is a SOURCE-TEXT census over `src/`. It guarantees that no expansion
 * written with `eachDateOnlyInRange` over a `stay*` bound can appear without
 * being declared — and it counts them PER SITE, not per file, so a SECOND
 * expansion added to an already-declared file fails too. That distinction is the
 * whole guard for `src/lib/admin-bed-allocation.ts`, which is declared for an
 * unrelated whole-lodge booking envelope and is also the file the original
 * `countGuestsAwaitingBed` defect lived in. It matches across line breaks, so
 * wrapping the call over several lines does not hide it, and it treats
 * `clampGuestToRange` as a stay bound by another name.
 *
 * What it still cannot see: an expansion that inlines its own day loop, one that
 * reaches the envelope through locals named nothing like a stay bound
 * (`const { start, end } = somethingElse(guest); eachDateOnlyInRange(start, end)`
 * — the `clampGuestToRange` clause closes today's only such route, not the
 * general shape), and anything outside `src/`, so `scripts/` and `prisma/` are
 * out of scope. That residue is stated rather than implied — every expansion in
 * the tree today is written the declared way, so the census covers the whole
 * current inventory.
 */

const SRC_ROOT = path.resolve(process.cwd(), "src");

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

function allSourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : allSourceFiles(absolute);
    }
    return /\.(ts|tsx)$/.test(entry.name) ? [absolute] : [];
  });
}

/**
 * `eachDateOnlyInRange(<anything mentioning a guest stay bound>, …)`.
 *
 * `[^)]*` deliberately spans line breaks, so a call Prettier has wrapped over
 * four lines still matches — the per-line form this replaced could see neither
 * half of one. It still cannot run past the call's own first `)`, so it cannot
 * reach forward into unrelated code. `clampGuestToRange` counts as a stay bound:
 * it RETURNS one, under whatever local name the caller picks, which is the only
 * way in the tree today to hold an envelope without naming it.
 */
const ENVELOPE_EXPANSION =
  /eachDateOnlyInRange\([^)]*(?:stay(?:Start|End)|clampGuestToRange)/gi;

/**
 * The code of a file with whole-line comments removed.
 *
 * Line-based on purpose. A whole-file comment strip is not safe here: `src/`
 * holds regex literals and JSX strings containing `/*`, and one of them will
 * happily swallow a real call site and make this census silently pass. Skipping
 * lines that are themselves a comment costs nothing and cannot misfire — the
 * only thing it lets through would be a call sharing a line with a trailing
 * `//`, which is a call, not a comment. Blank-lining rather than deleting them
 * keeps a comment from joining two unrelated statements into one apparent call.
 */
function codeOnly(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      return trimmed.startsWith("//") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*")
        ? ""
        : line;
    })
    .join("\n");
}

/** How many stay-envelope expansions this file's code contains. */
function countStayEnvelopeExpansions(source: string): number {
  return [...codeOnly(source).matchAll(ENVELOPE_EXPANSION)].length;
}

/**
 * Every declared site, with the evidence that proves what it is.
 *
 * `expansions` is how many expansions that file is allowed to contain. It is
 * declared rather than inferred so that adding a SECOND one to a file already on
 * this list fails the census instead of hiding behind the first.
 *
 * `kind` is the classification and it is the whole point of the table:
 *
 *  - `canonical`   — the one definition. Exactly one of these.
 *  - `booking`     — expands a BOOKING's own `[checkIn, checkOut)`, not a
 *                    guest's stay. A booking has no night set, so there is
 *                    nothing sparse to get wrong.
 *  - `night-set-first` — expands the envelope only as a fallback for a guest
 *                    carrying no `BookingGuestNight` rows, which is exactly
 *                    `getGuestBedNightKeys`'s own rule. Correct as written;
 *                    each one is a local copy that could be routed at the
 *                    helper later, and none may lose its night-set branch.
 *  - `plan-range`  — expanded a PLAN's own `[stayStart, stayEnd)` window, on the
 *                    argument that the window was contiguous by construction
 *                    because the shape it came from had no night field at all.
 *                    #2736 gave that shape a night field, so the one site of
 *                    this kind is gone and the classification is RETIRED. Do not
 *                    revive it: "the plan flattened it before this point" is a
 *                    reason to go and look at the plan, which is what #2736 was.
 */
const EXPANSION_SITES = [
  {
    file: "src/lib/booking-guest-stay-ranges.ts",
    kind: "canonical",
    expansions: 0,
    what: "expandStayEnvelopeToNightKeys — the one definition, half-open by contract",
    evidence: ["export function expandStayEnvelopeToNightKeys("],
  },
  {
    file: "src/lib/admin-bed-allocation.ts",
    kind: "booking",
    expansions: 1,
    what: "an exclusive whole-lodge hold's own booking envelope, clamped to the board window",
    evidence: ["{ stayStart: booking.checkIn, stayEnd: booking.checkOut }"],
  },
  {
    file: "src/app/(authenticated)/bookings/[id]/page.tsx",
    kind: "night-set-first",
    expansions: 1,
    what: "the nights quoted on a member's own consent card",
    evidence: ["viewerConsentGuest.nights.length > 0"],
  },
  {
    file: "src/lib/adult-member-hosting-review.ts",
    kind: "night-set-first",
    expansions: 1,
    what: "hosting participants' nights (INV-HOST-005 states this fallback)",
    evidence: ["guest.nights.length > 0"],
  },
  {
    file: "src/lib/member-guest-consent-notifications.ts",
    kind: "night-set-first",
    expansions: 1,
    what: "the nights named in a member-guest consent email",
    evidence: ["guest.nights.length > 0"],
  },
  {
    file: "src/lib/member-guest-delegate-page.ts",
    kind: "night-set-first",
    expansions: 1,
    what: "the nights shown on the delegate consent page",
    evidence: ["guest.nights.length > 0"],
  },
  // `src/lib/booking-modify-plan.ts` used to be the eighth entry, and the only
  // `plan-range` one. THIS CENSUS FOUND IT — the call was wrapped over three
  // lines, so the per-line regex the census shipped with could not see it — and
  // the pricing question it raised was filed as #2736 and is now fixed:
  // `ProposedExistingGuestRange` carries the guest's canonical `nights`, and the
  // per-night amounts are computed over that LIST instead of by re-expanding an
  // envelope (#2744 then made them each night's real rate rather than an even
  // split of the guest's total, still over the same list). There is no expansion
  // left in the file, so it is gone from the table rather than sitting here at
  // zero — the first test below derives the found set from the source, and a
  // declared file with nothing in it fails it.
  // `booking-edit-guest-ranges.ts` does not replace it: the plan now calls the
  // canonical `expandStayEnvelopeToNightKeys`, which is what a routed caller
  // looks like (INV-DATE-020) and is deliberately not a census site.
  //
  // Nor does `src/lib/diagnostics/tools/packs/booking-evidence.ts`, and it is worth
  // recording why, because it is this census's stated residue caught in the wild.
  // That module shipped a hand-rolled `Date.UTC`/day-millisecond loop feeding two
  // registry entries' night sets: correct night for night, and INVISIBLE here — no
  // `eachDateOnlyInRange` call to match. #2679's review found it by reading, not by
  // running this file. It now calls `getExplicitGuestBedNightKeys` then
  // `expandStayEnvelopeToNightKeys`, so it is a routed caller like the plan above,
  // and `booking-membership-pack.test.ts` bans the day-loop shape inside it by
  // source assertion — which is the shape of guard this census cannot provide and
  // the reason the residue paragraph in the header is not merely theoretical.
] as const;

describe("guest stay expansion census (#2628)", () => {
  it("declares every expansion site in the tree", () => {
    const found = allSourceFiles(SRC_ROOT)
      .filter(
        (absolute) =>
          countStayEnvelopeExpansions(fs.readFileSync(absolute, "utf8")) > 0,
      )
      .map((absolute) => path.relative(process.cwd(), absolute).replaceAll("\\", "/"))
      .sort();

    expect(found).toEqual(
      EXPANSION_SITES.filter((site) => site.kind !== "canonical")
        .map((site) => site.file)
        .sort(),
    );
  });

  it("counts them per SITE, so a second copy in a declared file fails too", () => {
    // The gap this closes: the first test compares a SET of file paths, so a
    // brand-new envelope expansion dropped into `admin-bed-allocation.ts` — the
    // very file `countGuestsAwaitingBed`'s defect lived in, and one that is
    // legitimately on the list for an unrelated BOOKING envelope — used to walk
    // straight back in undetected.
    const perFile = EXPANSION_SITES.map((site) => ({
      file: site.file,
      expansions: countStayEnvelopeExpansions(readRepoFile(site.file)),
    }));

    expect(perFile).toEqual(
      EXPANSION_SITES.map((site) => ({
        file: site.file,
        expansions: site.expansions,
      })),
    );
  });

  it("MUTATION PROBE: the census sees a wrapped call and a clamped one", () => {
    // Both shapes escaped the per-line, name-shaped regex this replaced: the
    // first has the callee and the stay bound on different lines, the second
    // never names a stay bound at all.
    const wrapped = [
      "const nights = eachDateOnlyInRange(",
      "  clampedGuest.stayStart,",
      "  clampedGuest.stayEnd,",
      ");",
    ].join("\n");
    const clamped =
      "const nights = eachDateOnlyInRange(clampGuestToRange(guest, range).from, end);";
    const innocent = [
      "// eachDateOnlyInRange(guest.stayStart, guest.stayEnd) is banned here",
      "const days = eachDateOnlyInRange(",
      "  booking.checkIn,",
      "  booking.checkOut,",
      ");",
    ].join("\n");

    expect(countStayEnvelopeExpansions(wrapped)).toBe(1);
    expect(countStayEnvelopeExpansions(clamped)).toBe(1);
    expect(countStayEnvelopeExpansions(innocent)).toBe(0);
  });

  it("keeps each declared site doing what it says it does", () => {
    for (const site of EXPANSION_SITES) {
      const source = readRepoFile(site.file);
      for (const evidence of site.evidence) {
        expect(source, `${site.file} — ${site.what}`).toContain(evidence);
      }
    }
  });

  it("has exactly ONE canonical definition, and it is half-open", () => {
    // The pseudo-guest hazard. Both bed-allocation planners are fed one
    // pseudo-guest per night carrying `stayEnd = night + 1`; an inclusive
    // expansion gives each a phantom second night and the planner claims the
    // morning-after bed. `bed-allocation.test.ts` → "pseudo-guest envelope
    // (#2628)" pins the consequence; this pins the definition.
    const canonical = readRepoFile("src/lib/booking-guest-stay-ranges.ts");
    expect(canonical.split("export function expandStayEnvelopeToNightKeys(")).toHaveLength(2);
    expect(canonical).toContain("key < endKey;");
    expect(canonical).not.toContain("key <= endKey;");
  });

  it("keeps the two deliberate NON-callers of the canonical guest expander", () => {
    // Both feed bed allocation, and both mean something narrower than
    // `getGuestBedNightKeys`. Routing either at it would change behaviour, so
    // they are recorded here rather than left to look like stragglers.
    //
    // The lifecycle reads the explicit rows with NO envelope fallback: its
    // output feeds placement AND the prune diff, so a fallback would place rows
    // the next reconcile sweeps straight off.
    const lifecycle = readRepoFile("src/lib/bed-allocation-lifecycle.ts");
    expect(lifecycle).toContain("function getGuestNightDatesInRange(");
    expect(lifecycle).toContain("return (guest.nights ?? [])");

    // The planner treats an explicitly EMPTY night list as "no demand", which
    // `getGuestBedNightKeys` would read as "use the envelope".
    const planner = readRepoFile("src/lib/bed-allocation.ts");
    expect(planner).toContain("if (guest.nights !== undefined) {");
    expect(planner).toContain(
      "expandStayEnvelopeToNightKeys(guest.stayStart, guest.stayEnd)",
    );
  });

  it("keeps the three repaired surfaces on the canonical helpers", () => {
    // The three that read the envelope and got sparse stays wrong. If any of
    // them re-grows a local expansion, the first test above catches the new
    // call site and this one catches the lost import.
    expect(readRepoFile("src/lib/admin-bed-allocation.ts")).toContain(
      "getExplicitGuestBedNightKeys(guest) ?? []",
    );
    expect(readRepoFile("src/lib/admin-bookings-service.ts")).toContain(
      "getGuestBedNightKeys(guest, booking)",
    );
    expect(readRepoFile("src/lib/lodge-date-scoping.ts")).toContain(
      "isGuestDepartureMorning(guest, date, guest.booking)",
    );
  });
});
