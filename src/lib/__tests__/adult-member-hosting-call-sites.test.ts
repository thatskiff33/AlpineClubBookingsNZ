// #2569 — the hosting policy's call sites, read off the real source files.
//
// ENFORCES INV-HOST-020, INV-HOST-030 and INV-HOST-043
// (`docs/invariants/adult-member-hosting.md`), all of which name this file:
// INV-HOST-020 pins the school/organisation REVIEW_ONLY exemption to one site
// tree-wide, INV-HOST-030 asserts who uses each confirming seam and that no
// confirming write uses neither, and INV-HOST-043 (#3037) pins Group Trip
// identity to the two authoritative columns and keeps the container's status
// out of the coverage sets. The census assertions for those repeat the id in
// their failure message, so whoever trips one is handed the rule rather than
// having to go and find it (#2691).
//
// WHY STRUCTURAL AND NOT BEHAVIOURAL. Four of this issue's requirements are claims
// about a SET OF FILES rather than about an answer, and a behavioural test of the
// sites that exist today passes just as green when a new one is added:
//
//   * "one canonical server-side resolver" (§6) is a claim that quote calculation,
//     confirmation, payment completion, waitlist promotion, group joins,
//     modification, officer approval and member previews do NOT each carry their
//     own copy of the inheritance rule. A second copy gives identical answers right
//     up to the day a club overrides one dimension and inherits the other;
//   * "the school and organisation carve-out, and only that" (§13) is a claim that
//     exactly one call site passes `REVIEW_ONLY`. A second one, added for a reason
//     that felt local, silently exempts a member-owned flow from a refusal the club
//     switched on — and nothing in the exempted path's own tests would notice. This
//     lane found one: the MEMBER whole-lodge approval had been exempted under the
//     §13 comment, and a member booking the whole lodge for their own party is not a
//     school, an organisation, a teacher or a custodian;
//   * "every refusing surface hands back an answer the caller can act on" is
//     positional: `AdultMemberHostingRequiredError` extends `ApiError`, so a route
//     that catches it BELOW its generic branch answers a bare 409 with no code, no
//     frozen violation and no exception door, and looks fine in review;
//   * "the create path reads the policy before it opens its transaction" gives the
//     same answer wherever it sits — it just holds the per-lodge capacity lock
//     while doing it, which is the pool-starvation shape the booking rules forbid.
//
// Plus one that is not a requirement but a trap this lane walked into: Prisma's
// `select` is NOT typechecked for unknown keys through the narrow `Pick<PrismaClient,
// ...>` interface these paths use, so a renamed column in the policy loader's select
// is a runtime failure on every booking write path with a green typecheck.
//
// Mirrors the convention in subscription-lockout-call-sites.test.ts (#2543).
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { stripComments } from "./support/strip-comments";
import {
  ADULT_MEMBER_HOST_SCOPES,
  type AdultMemberHostScope,
} from "@/lib/booking-policy-exceptions";
import {
  ADULT_MEMBER_HOST_SCOPE_DESCRIPTIONS,
  ADULT_MEMBER_HOST_SCOPE_LABELS,
  DEFAULT_ADULT_MEMBER_HOST_SCOPES,
  hostScopeEnabled,
  type AdultMemberHostScopeSet,
} from "@/lib/policies/adult-member-hosting";

function readRepoFile(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

/**
 * The same source with its comments removed.
 *
 * Every sweep below is a claim about CODE, and this repository comments heavily —
 * `booking-request.ts` explains in prose that the school path passes
 * `enforcement: "REVIEW_ONLY"`, and the officer routes explain in prose that they
 * deliberately send no `exceptionRequestPath`. A plain text search reads both as
 * call sites and the assertions become the opposite of what they say.
 *
 * Block comments and whole-line `//` comments only: a trailing comment on a line of
 * code is left alone rather than risking a `//` inside a string literal.
 */
/**
 * Memoised, because the sweeps below are quadratic without it. `sourceFilesNaming`
 * walks every non-test source file under `src/` for ONE identifier, and each seam
 * or catcher inventory is its own walk — so without a cache a file is read and
 * comment-stripped once per sweep rather than once per run. Adding the fourth
 * `ENQUEUE_SEAMS` entry took the drain assertion from ~830 ms to over 9 s under
 * parallel load and blew vitest's 5 s default, while still passing when this file
 * was run alone: a timeout that only appears under load is the worst kind, because
 * CI may or may not catch it. Keyed by repo-relative path; the tree does not
 * change mid-run.
 *
 * The key is NORMALISED to forward slashes (#2623 F8). `sourceFilesNaming` builds
 * its paths with `path.relative`, which yields backslashes on Windows, while every
 * direct call site here passes a forward-slash literal — so the same file cached
 * under two keys and was read and stripped twice. Harmless but pointless, and
 * invisible on Linux CI, which is exactly the kind of divergence that makes a
 * local timing measurement disagree with CI's.
 */
const repoCodeCache = new Map<string, string>();

function readRepoCode(relativePath: string): string {
  const key = relativePath.split(path.sep).join("/");
  const cached = repoCodeCache.get(key);
  if (cached !== undefined) return cached;
  const code = stripComments(readRepoFile(relativePath));
  repoCodeCache.set(key, code);
  return code;
}

/**
 * The name this file binds the SHARED `ApiError` to, or null if it does not import
 * it. Two routes carry a LOCAL class of the same name and alias the shared one, so
 * an ordering assertion written against the bare identifier compares a typed
 * refusal against a branch that can never catch it.
 */
function sharedApiErrorName(source: string): string | null {
  const match = source.match(
    /import\s*\{[^}]*\bApiError(?:\s+as\s+(\w+))?[^}]*\}\s*from\s*"@\/lib\/api-error"/,
  );
  if (!match) return null;
  return match[1] ?? "ApiError";
}

/**
 * Every non-test source file under `src/` that names `identifier`, as sorted
 * repo-relative POSIX paths.
 *
 * For assertions of the form "this belongs to exactly these paths". A hand-listed
 * set of files is not that assertion: it passes when a NEW site starts using the
 * thing, which is the only way the claim can ever be broken. Tests are excluded
 * because they legitimately name whatever they assert about.
 */
function everySourceFile(): string[] {
  if (sourceFileList !== null) return sourceFileList;
  const root = path.resolve(process.cwd(), "src");
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__") continue;
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) {
        continue;
      }
      found.push(path.relative(process.cwd(), full).split(path.sep).join("/"));
    }
  };
  walk(root);
  sourceFileList = found.sort();
  return sourceFileList;
}

let sourceFileList: string[] | null = null;

function sourceFilesNaming(identifier: string): string[] {
  return everySourceFile().filter((file) =>
    readRepoCode(file).includes(identifier),
  );
}

/**
 * The balanced `(...)`/`{...}` run that starts at `openIndex`, as text plus the
 * index of its closing bracket.
 *
 * Bracket counting rather than a regex because the thing being matched — a Prisma
 * call's argument object — nests arbitrarily, and `/\(([\s\S]*?)\)/` stops at the
 * first `)` inside it. Comments are already gone (`readRepoCode`); string literals
 * in this repository's Prisma calls do not carry unbalanced brackets, and a file
 * that made this miscount would show up as a scope that fails the sweep rather
 * than as one that silently passes it.
 */
function balancedRun(source: string, openIndex: number): { text: string; end: number } {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    if (character === "(" || character === "{" || character === "[") depth += 1;
    else if (character === ")" || character === "}" || character === "]") {
      depth -= 1;
      if (depth === 0) return { text: source.slice(openIndex, index + 1), end: index };
    }
  }
  return { text: source.slice(openIndex), end: source.length - 1 };
}

/** A `booking.update`/`updateMany` whose `data:` sets a terminal booking status. */
interface TerminalStatusFlip {
  file: string;
  /** The enclosing TOP-LEVEL declaration, which bounds the scope searched. */
  functionName: string;
  /** That declaration's source, start to the next top-level declaration. */
  scope: string;
  /** Which terminal status this write assigns. */
  status: string;
}

const TOP_LEVEL_DECLARATION =
  /^(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*=)/gm;

/**
 * Every write in the tree that flips a Booking to CANCELLED, EXPIRED or BUMPED.
 *
 * KEYED ON THE WRITE ITSELF, not on a helper the write happens to spread. The
 * first version of this sweep looked for `RELEASE_WHOLE_LODGE_HOLD_UPDATE`,
 * because `booking-status.ts` said that constant was "spread into every terminal
 * status flip". Measured, it is spread into SEVEN of them and there are TWELVE
 * files, so ten cancelling writers — the exact omission class #3209 is about —
 * were invisible to the guard meant to catch them. The constant is kept as a
 * SECONDARY signal below instead: a file that spreads it but shows no flip here
 * is a flip written in a shape this reader missed, and has to say so.
 *
 * Both status forms are matched, `BookingStatus.CANCELLED` and the bare
 * `"CANCELLED"` string that `booking-cancel.ts` uses four times, and only inside a
 * `data:` object — a `where: { status: ... }` guard is a read of the status, not a
 * write of it, and counting it would call a re-instatement a cancellation.
 */
function terminalStatusFlips(): TerminalStatusFlip[] {
  const flips: TerminalStatusFlip[] = [];
  for (const file of everySourceFile()) {
    const source = readRepoCode(file);
    if (!source.includes("booking.update")) continue;
    const calls = /\bbooking\.(?:update|updateMany)\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = calls.exec(source)) !== null) {
      const { text: call } = balancedRun(source, match.index + match[0].length - 1);
      let status: string | null = null;
      for (const dataMatch of call.matchAll(/\bdata:\s*\{/g)) {
        const data = balancedRun(
          call,
          (dataMatch.index ?? 0) + dataMatch[0].length - 1,
        ).text;
        const terminal = data.match(
          /status:\s*(?:BookingStatus\.)?["']?(CANCELLED|EXPIRED|BUMPED)["']?\s*[,}]/,
        );
        if (terminal) status = terminal[1] as string;
      }
      if (status === null) continue;

      const before = source.slice(0, match.index);
      TOP_LEVEL_DECLARATION.lastIndex = 0;
      const declarations = [...before.matchAll(TOP_LEVEL_DECLARATION)];
      const enclosing = declarations[declarations.length - 1];
      TOP_LEVEL_DECLARATION.lastIndex = 0;
      const next = [...source.slice(match.index).matchAll(TOP_LEVEL_DECLARATION)][0];
      flips.push({
        file,
        functionName: enclosing ? (enclosing[1] ?? enclosing[2] ?? "?") : "(module)",
        scope: source.slice(
          enclosing?.index ?? 0,
          next ? match.index + (next.index ?? 0) : source.length,
        ),
        status,
      });
    }
  }
  return flips;
}

describe("one authoritative evaluator and one resolver (#2569 §6, §7)", () => {
  it("resolves the club/lodge inheritance in exactly five places, none of them a booking path", () => {
    // The pure resolver (its own definition), the loader every booking write path
    // goes through, the admin card's effective view, the policy-change reconciler,
    // and the public booking-rules sentence. A booking path appearing here would be
    // a SECOND implementation of the inheritance rule — the thing §6 forbids by name.
    expect(sourceFilesNaming("resolveAdultMemberHostingPolicy(")).toEqual([
      "src/app/api/admin/booking-policies/adult-member-hosting/route.ts",
      "src/lib/adult-member-hosting-policy-reconciliation.ts",
      "src/lib/adult-member-hosting-review.ts",
      "src/lib/policies/adult-member-hosting.ts",
      "src/lib/public-page-content-tokens.ts",
    ]);
  });

  it("calls the pure evaluator only from the review service", () => {
    // §7: extend the shared evaluator, never write a second definition of a
    // qualifying adult member. Every caller reaches it through the review service,
    // which is also the only place that loads the participants.
    //
    // THE REVIEW SERVICE IS TWO MODULES SINCE #3128, and this list was widened
    // deliberately rather than to make a red test green. The engine answers for a
    // PERSISTED booking; `adult-member-hosting-proposed.ts` answers for a party
    // that does not exist yet, on the create path. It was always a separate
    // entry point with its own participant assembly — it simply used to sit in
    // the same file, and splitting a 3,051-line module moved it without changing
    // a line of it. §7's actual rule is unweakened by the widening: both callers
    // reach the ONE evaluator in `policies/adult-member-hosting.ts`, neither
    // decides for itself who qualifies, and a fourth namer still fails here and
    // still has to argue its case.
    expect(sourceFilesNaming("evaluateAdultMemberHostingWithPolicy(")).toEqual([
      "src/lib/adult-member-hosting-proposed.ts",
      "src/lib/adult-member-hosting-review.ts",
      "src/lib/policies/adult-member-hosting.ts",
    ]);
  });

  it("keeps the engine's newly-exported loaders inside the engine", () => {
    // #3128 had to widen four private helpers to `export` so the split modules
    // could reach them. Two of them read hosting rows and are only correct under
    // the caller's lock discipline, so a new caller elsewhere is a hazard the
    // move created and nothing else would catch. Pin them the way §7 pins the
    // evaluator: the list is short on purpose, and adding to it is a decision.
    expect(sourceFilesNaming("loadSameBookingOwnerHosts(")).toEqual([
      "src/lib/adult-member-hosting-proposed.ts",
      "src/lib/adult-member-hosting-review.ts",
    ]);
    // #3038's third cross-booking loader, held to the same short list for the
    // same reason: it reads OTHER PEOPLE'S bookings as cover, so a caller
    // outside these two files is a hazard nothing else would catch. The
    // persisted engine and the pre-persist join preflight are the two legitimate
    // entry points, exactly as they are for its same-owner sibling.
    expect(sourceFilesNaming("loadSameGroupTripHosts(")).toEqual([
      "src/lib/adult-member-hosting-proposed.ts",
      "src/lib/adult-member-hosting-review.ts",
    ]);
    expect(sourceFilesNaming("withSubscriptionSettlement(")).toEqual([
      "src/lib/adult-member-hosting-proposed.ts",
      "src/lib/adult-member-hosting-review.ts",
    ]);
  });

  it("selects exactly the host-scope columns the schema declares", () => {
    // The loader's `select` is narrowed, so an omitted scope column reads as "this
    // row did not decide" and quietly widens or narrows a lodge's rule — and a
    // STALE column name is a Prisma validation error on every booking write path
    // that typecheck does not catch (the db parameter is a hand-written
    // `Pick<PrismaClient, ...>`). Read off the schema so the two cannot drift.
    const schema = readRepoFile("prisma/schema.prisma");
    const declared = [
      ...new Set(
        [...schema.matchAll(/^\s*(hostScope\w+)\s+Boolean\?/gm)].map(
          (match) => match[1],
        ),
      ),
    ].sort();
    expect(declared).toEqual([
      "hostScopeSameBooking",
      "hostScopeSameBookingOwner",
      // #3037 (epic #2943). Read off the schema and asserted here as well, so
      // adding a scope column without threading it through the loader's select
      // fails at the one place that can see both.
      "hostScopeSameGroupTrip",
    ]);

    const loader = readRepoCode("src/lib/adult-member-hosting-review.ts");
    const select = loader.slice(
      loader.indexOf("adultMemberHostingPolicy.findMany({"),
    );
    const window = select.slice(0, select.indexOf("});"));
    for (const column of declared) {
      expect(window, column).toContain(`${column}: true,`);
    }
    // And nothing that is not declared: a column deleted from the schema but left
    // here is the same runtime failure in reverse.
    const selected = [...window.matchAll(/(hostScope\w+):\s*true/g)]
      .map((match) => match[1])
      .sort();
    expect(selected).toEqual(declared);
  });

  it("selects the same host-scope columns in every other narrowed policy read", () => {
    // The assertion above pins the ONE loader every booking write path goes
    // through. It is not the only narrowed read of this table, and the other
    // three fail in quieter ways than a booking write does: a missing column in
    // the reconciliation projection makes a scope-only policy edit queue no
    // re-evaluation at all (both sides of the before/after comparison read "did
    // not decide"), one in config transfer exports a scope set that is not the
    // stored one, and one in the public booking-rules read publishes a sentence
    // describing a rule the club is not applying. None of the three is a
    // typecheck error, for the same `Pick<PrismaClient, ...>` reason.
    const schema = readRepoFile("prisma/schema.prisma");
    const declared = [
      ...new Set(
        [...schema.matchAll(/^\s*(hostScope\w+)\s+Boolean\?/gm)].map(
          (match) => match[1],
        ),
      ),
    ].sort();

    // Matched over the WHOLE comment-stripped file rather than a sliced window,
    // and de-duplicated. Each of these files holds exactly one narrowed read of
    // this table, and a window delimited by the next `},` is not robust here:
    // the public-content read carries a ternary `where` whose own braces close
    // before the select begins, so a window-based sweep silently found nothing
    // and the assertion passed on an empty list. A whole-file set states the
    // claim that matters — this file names exactly the declared scope columns,
    // no fewer (a quiet wrong answer) and none that the schema has dropped (a
    // runtime Prisma validation failure).
    for (const file of [
      "src/lib/adult-member-hosting-policy-reconciliation.ts",
      "src/lib/config-transfer/categories/adult-member-hosting.ts",
      "src/lib/public-page-content-tokens.ts",
    ]) {
      const source = readRepoCode(file);
      const selected = [
        ...new Set(
          [...source.matchAll(/(hostScope\w+):\s*true/g)].map(
            (match) => match[1],
          ),
        ),
      ].sort();
      expect(selected, file).toEqual(declared);
    }
  });
});

describe("canonical Group Trip identity (#3037, epic #2943)", () => {
  // The owner's contract names the two authoritative columns and forbids one
  // other by name, and both halves are structural claims a behavioural test of
  // today's call sites cannot make: it passes just as green the day a new site
  // resolves grouping from the wrong relationship.

  it("DEFINES Group Trip identity in exactly one module, and lets anyone call it", () => {
    // Every later child of the epic - the cross-booking evaluator (#3038), the
    // reconciliation writers (#3039) and the kiosk/admin payloads (#3040) -
    // consumes this one definition. A second resolver would give identical
    // answers right up to the day the two disagree about a joined booking whose
    // container was closed, which is the exact case the contract calls out.
    //
    // ONE DEFINITION IS THE CLAIM; one CALLER is not, and asserting the latter
    // is what this census used to do. Today `group-trip-identity.ts` is the only
    // file that names these functions simply because nothing calls them yet, so
    // the assertion was vacuous — and worse than vacuous, because #3038's first
    // legitimate call would have red-lighted a guard that had never proved
    // anything. Pinning the `export function` sites states the real rule and
    // leaves the callers free.
    for (const definition of [
      "export function groupTripIdentityOf(",
      "export function groupTripIdentityForJoin(",
      "export function groupTripMembershipWhere(",
      "export function groupTripCoverageSourceWhere(",
      "export function groupTripCoverageDependentWhere(",
    ]) {
      expect(
        sourceFilesNaming(definition),
        `INV-HOST-043 (docs/invariants/adult-member-hosting.md): ` +
          `${definition}…) belongs to src/lib/group-trip-identity.ts and ` +
          "nowhere else. A second definition gives identical answers right up " +
          "to the day the two disagree about a joined booking whose container " +
          "was closed.",
      ).toEqual(["src/lib/group-trip-identity.ts"]);
    }
    // And nowhere else builds the MEMBERSHIP FILTER by hand. Pinning the bare
    // relation names would be the wrong instrument: `group-booking.ts` and the
    // booking detail page legitimately select `groupBookingAsOrganiser` for the
    // organiser card, and neither is resolving hosting identity. What a second
    // copy would have to spell is the group-id filter on the join relation, so
    // that is what is pinned.
    expect(sourceFilesNaming("groupBookingJoin: { is: { groupBookingId:")).toEqual(
      ["src/lib/group-trip-identity.ts"],
    );
  });

  it("names relations and fields the schema really declares", () => {
    // THE CLAIM `GROUP_TRIP_IDENTITY_SELECT`'s docblock makes, which until now
    // nothing checked. Prisma does NOT typecheck `select` keys through the
    // hand-written `Pick<PrismaClient, ...>` interfaces the hosting paths use, so
    // a relation or column name that drifts from the schema is a RUNTIME
    // validation failure on a booking write path with a green typecheck — and
    // the identity test pins the constant against a copy of itself, which cannot
    // see that drift at all. This reads the schema.
    const schema = readRepoFile("prisma/schema.prisma");

    // The two relations the select traverses, on Booking.
    expect(schema).toMatch(
      /^\s*groupBookingAsOrganiser\s+GroupBooking\?/m,
    );
    expect(schema).toMatch(/^\s*groupBookingJoin\s+GroupBookingJoin\?/m);

    // The two fields it reads through them: GroupBooking.id, and the join row's
    // own groupBookingId. `GroupBookingJoin.bookingId` is what makes the join
    // side resolvable at all, so it is pinned here too even though the select
    // does not name it.
    const model = (name: string) => {
      const start = schema.indexOf(`model ${name} {`);
      expect(start, name).toBeGreaterThan(-1);
      return schema.slice(start, schema.indexOf("\n}", start));
    };
    expect(model("GroupBooking")).toMatch(/^\s*id\s+String\s+@id/m);
    expect(model("GroupBookingJoin")).toMatch(/^\s*groupBookingId\s+String/m);
    expect(model("GroupBookingJoin")).toMatch(/^\s*bookingId\s+String\?/m);

    // And the forbidden identity source really is a Booking column, so the
    // guard below is refusing something that exists rather than a typo.
    expect(model("Booking")).toMatch(/^\s*parentBookingId\s+String\?/m);
  });

  it("never resolves Group Trip identity from parentBookingId", () => {
    // `Booking.parentBookingId` is the #738 split-booking relationship. It is
    // neither necessary nor sufficient for Group Trip membership - two bookings
    // in one Group Trip have no such link, and a split pair in no Group Trip has
    // one - so reading grouping off it produces a sibling set that is wrong in
    // both directions. The module that owns group identity must not name it.
    const identity = readRepoCode("src/lib/group-trip-identity.ts");
    expect(
      identity,
      "INV-HOST-043 (docs/invariants/adult-member-hosting.md): Group Trip " +
        "identity is GroupBooking.organiserBookingId and " +
        "GroupBookingJoin.bookingId. Booking.parentBookingId is the #738 " +
        "split-booking relationship — neither necessary nor sufficient — so " +
        "reading grouping off it produces a sibling set wrong in both directions.",
    ).not.toContain("parentBookingId");
    // And the canonical columns really are the two the contract names.
    expect(identity).toContain("groupBookingAsOrganiser");
    expect(identity).toContain("groupBookingJoin");
  });

  it("keeps the group container's status out of the whole identity module", () => {
    // A CLOSED or CANCELLED GroupBooking governs JOINING, not cover: a still-live
    // individual booking can hold an adult who is genuinely travelling with the
    // party, so filtering the source or dependent set on container status would
    // silently strip cover from compliant bookings and silently drop bookings
    // that still need reconciling. Whether a booking is really happening is
    // decided on `Booking.status`, through the canonical lifecycle helper.
    //
    // TWO WAYS THIS GUARD USED TO BE A FALSE GREEN, both fixed here.
    //
    // It matched `/groupBooking\s*:\s*\{[^}]*status/`, and no relation in this
    // schema is called `groupBooking`: they are `groupBookingAsOrganiser` and
    // `groupBookingJoin`, neither of which that pattern can match, because
    // `groupBooking` is immediately followed by a letter rather than a colon. A
    // real container-status filter written the way Prisma requires passed it.
    //
    // And it sliced the file from `groupTripCoverageSourceWhere` downwards,
    // which sits BELOW `groupTripMembershipWhere` — the one builder both
    // coverage sets compose. A container-status gate added there, which would
    // have poisoned both, was not scanned at all.
    //
    // The claim is stronger and simpler than either: the identity module names
    // no status of any kind. It cannot, now that the lifecycle question belongs
    // entirely to the shared coverage envelope, so anything reintroducing one —
    // under any relation name, in any builder, in any helper — trips this.
    const containerStatusRule =
      "INV-HOST-043 (docs/invariants/adult-member-hosting.md): " +
      "GroupBooking.status governs JOINING, not cover. A still-live individual " +
      "booking can hold an adult who is genuinely travelling with the party, so " +
      "filtering either coverage set on the container's status strips cover " +
      "from compliant bookings and drops bookings that still need reconciling. " +
      "Whether a booking is really happening is decided on Booking.status, " +
      "through the shared coverage envelope.";
    const identity = readRepoCode("src/lib/group-trip-identity.ts");
    expect(identity, containerStatusRule).not.toMatch(/status/i);
    expect(identity, containerStatusRule).not.toContain("GroupBookingStatus");
    expect(identity, containerStatusRule).not.toContain("CANCELLED");
    // The lifecycle filter is delegated rather than dropped: both builders go
    // through the shared envelope, which reads `Booking.status` off the
    // canonical helper. Without this the assertion above would also pass on a
    // module that had simply stopped filtering by booking status at all.
    expect(identity).toContain("coverageEnvelopeWhere(");
    expect(identity).toContain("coverageDependentEnvelopeAcrossNightsWhere(");

    // And the envelope itself is about bookings, never about containers, so the
    // rule cannot be reintroduced one module along either.
    const envelope = readRepoCode(
      "src/lib/adult-member-hosting-coverage-envelope.ts",
    );
    expect(envelope).not.toContain("groupBooking");
    expect(envelope).not.toContain("GroupBooking");
    expect(envelope).toContain("hostingCoverageSourceBookingFilter(");
  });

  it("only ever hands the hosting rule a SERVER-RESOLVED Group Trip", () => {
    // THE WHOLE AUTHORIZATION STORY FOR `SAME_GROUP_TRIP` IS THAT NOBODY CHOOSES
    // THEIR OWN TRIP (#3038).
    //
    // `groupBookingId` decides which OTHER accounts' bookings may supply adult
    // cover for this one. A caller that forwarded a request-supplied value would
    // let anybody name any trip and borrow its adults — and nothing else in the
    // system would notice, because every clause downstream is about lodges,
    // dates and statuses, all of which the attacker's own booking satisfies. The
    // id is safe today only because it is always resolved server-side, and that
    // property lives in no type. So it lives here.
    //
    // Three producers, and each is pinned to WHAT it supplies rather than merely
    // to the fact that it supplies something.
    expect([...sourceFilesNaming("evaluateProposedAdultMemberHosting(")].sort()).toEqual([
      "src/app/api/bookings/route.ts",
      "src/lib/adult-member-hosting-proposed.ts",
      "src/lib/booking-exception-request-service.ts",
      "src/lib/group-booking.ts",
    ]);

    const suppliedRule =
      "INV-HOST-043 (docs/invariants/adult-member-hosting.md): a party's Group " +
      "Trip is resolved server-side — from the container a join code was " +
      "redeemed for, or from the live booking's own canonical relations — and " +
      "never from anything the requester sent. A request-supplied id would let " +
      "any member borrow any trip's adult cover.";

    // The ordinary create has no join path, so it says so with a literal.
    expect(
      readRepoCode("src/app/api/bookings/route.ts"),
      suppliedRule,
    ).toContain("groupBookingId: null,");

    // The member join hands over the container it already resolved from the
    // redeemed join code, never a body field.
    expect(readRepoCode("src/lib/group-booking.ts"), suppliedRule).toContain(
      "groupBookingId: group.id,",
    );

    // The exception path resolves the LIVE booking's own relations, through the
    // one select constant that owns them.
    const service = readRepoCode("src/lib/booking-exception-request-service.ts");
    expect(service, suppliedRule).toContain(
      "await resolveProposalGroupTrip(db, proposalBooking)",
    );
    expect(service, suppliedRule).toContain(
      "...GROUP_TRIP_IDENTITY_SELECT,",
    );
    // AND IT REACHES THE SPLIT-PAIR CARVE-OUT, which it structurally could not
    // while its select carried the two relations alone. A split child holds
    // neither, so identity resolved from them is `null` for exactly the booking
    // the carve-out exists for — and this path FREEZES its answer into an
    // exception request. The rule is not restated here: the shared reader in
    // `adult-member-hosting-review.ts` applies the same fence the persisted
    // evaluator does (`INV-SSOT-001`).
    expect(
      service,
      "INV-HOST-043 (docs/invariants/adult-member-hosting.md): both evaluators " +
        "apply the split-pair carve-out or they disagree about the one booking " +
        "it exists for — the half carrying the party's non-member guests.",
    ).toContain("readInheritedSplitPairGroupTrip(db, booking)");
    expect(service).toContain("parentBookingId: true,");
    // ONE definition of the carve-out, tree-wide.
    expect(
      sourceFilesNaming("inheritedSplitPairGroupTrip("),
      "INV-SSOT-001: the fence around the #738 carve-out is one rule. A second " +
        "spelling gives identical answers right up to the day one of them is " +
        "widened.",
    ).toEqual(["src/lib/adult-member-hosting-review.ts"]);

    // AND THE REQUEST LAYER NAMES IT IN EXACTLY ONE PLACE, where it is the
    // literal above. Anything parsing one off the wire — a zod field, a body
    // spread, a query parameter — adds a file here and trips this.
    //
    // A LEGITIMATE new group-booking admin or API surface trips it too, and the
    // message says so rather than accusing whoever added one of taking the id
    // off the wire. The property this guard actually cares about is the second
    // half: no route may READ a Group Trip id from the request. A new file that
    // only ever resolves one server-side is safe, and the right response is to
    // add it to this list with a note saying which.
    expect(
      sourceFilesNaming("groupBookingId").filter((file) =>
        file.startsWith("src/app/"),
      ),
      `${suppliedRule}

TWO WAYS TO REACH THIS FAILURE. Either a route now ` +
        "takes a Group Trip id from the request — which is the hazard, and must " +
        "be removed — or a new group-booking surface legitimately names the " +
        "field while resolving it server-side, in which case read that file, " +
        "confirm the id never comes from a body, query or path parameter, and " +
        "add it here.",
    ).toEqual(["src/app/api/bookings/route.ts"]);
  });

  it("writes the Group Trip roster row BEFORE the split child that depends on it", () => {
    // ORDER INSIDE ONE TRANSACTION, AND IT IS LOAD-BEARING RATHER THAN TIDY.
    //
    // `createConfirmedBooking` writes the `GroupBookingJoin` row — which IS the
    // booking's Group Trip identity (`INV-HOST-043`) — and then, for a mixed
    // party, the #738 split child. The child is reconciled against the hosting
    // rule the moment it is written. While the roster write came LAST, that
    // reconciliation ran with no roster row in existence: the parent belonged to
    // no Group Trip yet, so the child — the half carrying the party's
    // NON-MEMBER guests, the rows the rule exists to judge — inherited nothing
    // and was recorded as uncovered, and every later evaluation of the same
    // booking disagreed with the stored answer.
    //
    // Nothing else pins this. Both writes typecheck in either order, every
    // behavioural suite passes in either order, and a later tidy moving the
    // block back to sit with the other post-write steps would be green
    // everywhere. So the order is asserted here, on the source, which is the
    // cheap instrument that actually discriminates it.
    const source = readRepoCode("src/lib/booking-create.ts");
    const rosterWrite = source.indexOf("if (groupJoin) {");
    const splitChildWrite = source.indexOf("parentBookingId: newBooking.id");
    expect(rosterWrite, "the group-join block moved or was renamed").toBeGreaterThan(-1);
    expect(
      splitChildWrite,
      "the #738 split-child create moved or was renamed",
    ).toBeGreaterThan(-1);
    expect(
      rosterWrite,
      "INV-HOST-043 (docs/invariants/adult-member-hosting.md): the " +
        "GroupBookingJoin row is the booking's Group Trip identity, and the " +
        "#738 split child is reconciled against the hosting rule as soon as it " +
        "is written. Create the child first and it is judged against a party " +
        "that belongs to no Group Trip yet, and stored as uncovered while every " +
        "later evaluation finds the cover.",
    ).toBeLessThan(splitChildWrite);
  });

  it("never selects the group joinCode", () => {
    // The group's join credential. The epic's privacy contract keeps it out of
    // every payload and every tier, and identity resolution has no use for it -
    // so the module that every consumer reads group identity through must not
    // put it within reach of one.
    expect(readRepoCode("src/lib/group-trip-identity.ts")).not.toContain(
      "joinCode",
    );
  });
});

describe("combined member refusal and officer queue contracts", () => {
  it("keeps every authoritative host-qualification writer on the durable seam", () => {
    for (const file of [
      "src/app/api/admin/deletion-requests/[id]/route.ts",
      "src/app/api/admin/members/bulk-update/route.ts",
      "src/lib/admin-member-detail-service.ts",
      "src/lib/member-guest-consent-service.ts",
      "src/lib/manual-subscription-payment.ts",
      "src/lib/xero-membership-sync.ts",
    ]) {
      const source = readRepoCode(file);
      expect(source, file).toContain(
        "enqueueHostingCoverageReevaluationForMember(",
      );
      expect(source, file).toContain("settleHostingCoverageAfterCommit(");
    }
    const merge = readRepoCode("src/lib/member-merge.ts");
    expect(merge).toContain("buildMemberMergeHostingCoveragePlan(");
    expect(merge).toContain("enqueueMemberMergeHostingCoveragePlan(");
    expect(merge).toContain("settleHostingCoverageAfterCommit(");
  });

  it("returns both paid-up and hosting reasons through the redacted refusal shape", () => {
    for (const file of [
      "src/app/api/bookings/route.ts",
      "src/lib/group-booking.ts",
    ]) {
      const source = readRepoCode(file);
      expect(source, file).toContain(
        'code: "BOOKING_POLICY_REQUIREMENTS_NOT_MET"',
      );
      expect(source, file).toContain("reasonCodes:");
      expect(source, file).toMatch(
        /const hostingRefusal\s*=\s*buildAdultMemberHostingRefusalBody\(hostingViolation\)/,
      );
      expect(source, file).toContain("...hostingRefusal.violations");
      expect(source, file).toContain(
        "exceptionRequestPath: hostingRefusal.exceptionRequestPath",
      );
    }
  });

  it("puts unresolved incidents in the bookings permission area with direct rows", () => {
    const page = readRepoCode("src/app/(admin)/admin/bookings/page.tsx");
    expect(page).toContain('id="hosting-coverage-incidents"');
    expect(page).toContain("prisma.hostingCoverageIncident.count(");
    expect(page).toContain("prisma.hostingCoverageIncident.findMany(");
    expect(page.match(/resolvedAt:\s*null/g)).toHaveLength(2);
    expect(
      page.match(/\.\.\.\(query\.lodgeId \? \{ lodgeId: query\.lodgeId \} : \{\}\)/g),
    ).toHaveLength(2);
    expect(page).toContain("`/bookings/${incident.bookingId}`");

    const permissions = readRepoCode("src/lib/admin-permissions.ts");
    expect(permissions).toContain('area: "bookings"');
    expect(permissions).toContain('"/admin/bookings"');
  });
});

describe("the school and organisation carve-out, and only that (#2569 §13)", () => {
  it("passes REVIEW_ONLY from exactly one place: the school and organisation request approval", () => {
    // One site, because there is one such approval: `BookingRequestType.SCHOOL`
    // carries school groups and organisations alike, and `approveSchoolBookingRequest`
    // is the only path that approves them. The owner's exclusion names school and
    // organisation REQUEST APPROVALS and nothing else, so a second site — a
    // member-owned flow quietly exempted — would be a policy change made by a
    // one-line argument rather than by a decision.
    // THREE files, and only the last is the §13 carve-out. The other two share a
    // different reason, which each states at its call site: there is NOTHING LEFT
    // TO REFUSE, because the write a refusal exists to prevent is not being made.
    // #2576's post-commit coverage drain re-evaluates a booking that is ALREADY
    // confirmed — throwing there would abort a background sweep and roll back the
    // very incident it exists to record. #3209's system-cancellation seam
    // reconciles a booking that has ALREADY been cancelled, by an organiser cancel,
    // an expired Internet Banking hold, a capacity-failed Stripe void or a
    // price-drift unwind — throwing there would roll back a cancellation nobody
    // asked for and, on the cron, wedge it forever, because the next run reads the
    // same rows and refuses again. Neither exempts a member-owned FLOW from
    // anything: the drain lives inside the review service and the seam takes no
    // actor and is reachable only from a terminal status flip.
    expect(
      sourceFilesNaming('enforcement: "REVIEW_ONLY"'),
      "INV-HOST-020 (docs/invariants/adult-member-hosting.md): REVIEW_ONLY is " +
        "the school and organisation exclusion, plus the two positions where the " +
        "write a refusal would prevent is not being made. A FOURTH file passing " +
        "it exempts a member-owned flow from an enforcing club's rule by a " +
        "one-line argument rather than by a decision.",
    ).toEqual([
      "src/lib/adult-member-hosting-review.ts",
      "src/lib/adult-member-hosting-system-cancellation.ts",
      "src/lib/school-booking-request.ts",
    ]);
    // And the seam passes it once, from the one exported function, so it cannot
    // become a general-purpose way in.
    const seam = readRepoCode("src/lib/adult-member-hosting-system-cancellation.ts");
    expect(seam.match(/enforcement: "REVIEW_ONLY"/g) ?? []).toHaveLength(1);
    expect(
      seam.indexOf('enforcement: "REVIEW_ONLY"'),
    ).toBeGreaterThan(
      seam.indexOf(
        "export async function reconcileHostingReviewForSystemCancellation(",
      ),
    );
    const reviewService = readRepoCode("src/lib/adult-member-hosting-review.ts");
    expect(
      reviewService.match(/enforcement: "REVIEW_ONLY"/g) ?? [],
    ).toHaveLength(1);
    const incidentReconciler = reviewService.indexOf(
      "export async function reconcileSameOwnerCoverageIncident(",
    );
    expect(incidentReconciler).toBeGreaterThan(-1);
    expect(
      reviewService.indexOf('enforcement: "REVIEW_ONLY"'),
    ).toBeGreaterThan(incidentReconciler);
    const source = readRepoCode("src/lib/school-booking-request.ts");
    expect(source.match(/enforcement: "REVIEW_ONLY"/g) ?? []).toHaveLength(1);
    // And it is inside that approval rather than the MEMBER whole-lodge approval
    // further down the same file, which is deliberately not exempt (#2569 §2:
    // member-owned flows are in the first release; §13 is about teachers,
    // organisation leaders and custodians, none of which is a member booking the
    // whole lodge for their own party).
    const schoolApproval = source.indexOf(
      "export async function approveSchoolBookingRequest(",
    );
    const memberWholeLodge = source.indexOf(
      "export async function approveMemberWholeLodgeRequest(",
    );
    expect(schoolApproval).toBeGreaterThan(-1);
    expect(memberWholeLodge).toBeGreaterThan(schoolApproval);
    const site = source.indexOf('enforcement: "REVIEW_ONLY"');
    expect(site).toBeGreaterThan(schoolApproval);
    expect(site).toBeLessThan(memberWholeLodge);
    // The member whole-lodge approval still RECORDS the hazard; what changed is
    // that an enforcing lodge refuses it rather than approving into a review.
    expect(source.slice(memberWholeLodge)).toContain(
      "reconcileAdultMemberHostingReviewWithSiblings(booking.id, tx)",
    );
  });

  it("keeps the general public request approval inside the refusal", () => {
    // A public booking request is an all-non-member party owned by a non-login
    // contact, which is precisely the booking an enforcing lodge has said it will
    // not take. It reconciles with no enforcement argument, so it refuses.
    const source = readRepoCode("src/lib/booking-request.ts");
    expect(source).toContain(
      "reconcileAdultMemberHostingReviewWithSiblings(booking.id, tx)",
    );
    expect(source).not.toContain('enforcement: "REVIEW_ONLY"');
  });
});

describe("every refusing surface answers with something the caller can act on", () => {
  /**
   * Files that catch the refusal. Each must ALSO name the shape it answers with,
   * and the typed branch must come BEFORE any generic `ApiError` branch — the
   * refusal is a subclass, so below it the code, the frozen violation and the
   * exception door are all stripped.
   */
  const CATCHERS = sourceFilesNaming("instanceof AdultMemberHostingRequiredError");

  it("catches the refusal on every surface that can raise it, and nowhere else", () => {
    expect(CATCHERS).toEqual([
      "src/app/api/admin/booking-requests/[id]/approve/route.ts",
      "src/app/api/admin/booking-requests/[id]/hold/route.ts",
      // #2576 §9: confirming a DRAFT is a confirmation, and DRAFT is outside
      // `ACTIVE_BOOKING_STATUSES` — so it is invisible to the strand check that
      // guards a source cancellation, and this was the one confirming path where an
      // uncovered booking could reach PAID deterministically rather than by a race.
      "src/app/api/bookings/[id]/confirm-draft/route.ts",
      "src/app/api/bookings/[id]/guests/[guestId]/route.ts",
      "src/app/api/bookings/[id]/guests/route.ts",
      "src/app/api/bookings/[id]/modify-dates/route.ts",
      "src/app/api/bookings/[id]/modify/route.ts",
      "src/lib/group-booking.ts",
      "src/lib/waitlist-cross-lodge.ts",
      "src/lib/waitlist.ts",
    ]);
  });

  it("answers with the exception-door body, or with a deliberate exception to it", () => {
    // Three surfaces deliberately do NOT return the rich body, and each has a
    // reason in its own comment: the two officer-facing request paths ARE the
    // authority the door leads to, and the verified NON-MEMBER group join is
    // confirmed from an emailed token with no session, so a body naming the club's
    // settings would be a policy read for anyone holding a token.
    const OFFICER_PATHS = [
      "src/app/api/admin/booking-requests/[id]/approve/route.ts",
      "src/app/api/admin/booking-requests/[id]/hold/route.ts",
    ];
    for (const file of CATCHERS) {
      const source = readRepoCode(file);
      if (OFFICER_PATHS.includes(file)) {
        expect(source, file).toContain("code: err.code");
        expect(source, file).not.toContain("exceptionRequestPath");
        continue;
      }
      expect(source, file).toContain("buildAdultMemberHostingRefusalBody(");
    }
    // The public non-member join carries the generic sentence INSTEAD, on the one
    // file that also builds the redacted body for the member join beside it.
    const groupBooking = readRepoCode("src/lib/group-booking.ts");
    expect(groupBooking).toContain(
      "PUBLIC_GROUP_JOIN_ADULT_MEMBER_HOSTING_MESSAGE",
    );
  });

  it("puts the typed branch above the generic ApiError branch", () => {
    for (const file of CATCHERS) {
      const source = readRepoCode(file);
      const shared = sharedApiErrorName(source);
      if (shared === null) continue;
      const generic = source.indexOf(`instanceof ${shared}`);
      if (generic === -1) continue;
      const typed = source.indexOf("instanceof AdultMemberHostingRequiredError");
      expect(typed, file).toBeGreaterThan(-1);
      expect(typed, file).toBeLessThan(generic);
    }
  });

  it("uses the waitlist sentence on the waitlist paths and nowhere else", () => {
    // The extra fact it adds — "your offer has not been used" — is true only where
    // a claim was rolled back. On a booking path there is no offer behind it, so
    // the sentence would send the member looking for something they do not have.
    expect(
      sourceFilesNaming("formatAdultMemberHostingWaitlistRefusal"),
    ).toEqual([
      "src/lib/policies/adult-member-hosting.ts",
      "src/lib/waitlist-cross-lodge.ts",
      "src/lib/waitlist.ts",
    ]);
  });
});

describe("the same-owner refusal and the escalation seam (#2576 §6, §8, §9)", () => {
  const REFUSAL_CATCHERS = sourceFilesNaming(
    "instanceof SameOwnerCoverageWouldBreakError",
  );

  /**
   * The ONE non-route file allowed to catch the refusal, and what it must do with
   * it (#3232, `INV-HOST-050`).
   *
   * It does not answer the refusal — it UPGRADES it. Where the stranding was caused
   * by moving away from the affected booking, the member cannot fix that booking
   * (the same rule refuses THAT edit from the other end), so a refusal there is a
   * deadlock. This service prices the linked move and raises the offer instead. It
   * is exempt from the structured-body assertion below because it returns no body
   * at all, and it carries its own assertion instead.
   */
  const REFUSAL_UPGRADER = "src/lib/booking-linked-date-move-service.ts";

  it("catches the same-owner refusal on every member self-service surface", () => {
    // The five change classes §6 names that a member can reach: cancelling,
    // removing a guest, adding guests (which moves the night picture), a date
    // change and a batch edit. A path that raises it and does not catch it answers
    // a bare 409 with no list of the member's own affected bookings — which is the
    // whole content of the message.
    expect(REFUSAL_CATCHERS.filter((file) => file !== REFUSAL_UPGRADER)).toEqual([
      "src/app/api/bookings/[id]/cancel/route.ts",
      "src/app/api/bookings/[id]/confirm-draft/route.ts",
      "src/app/api/bookings/[id]/guests/[guestId]/route.ts",
      "src/app/api/bookings/[id]/guests/route.ts",
      "src/app/api/bookings/[id]/modify-dates/route.ts",
      "src/app/api/bookings/[id]/modify/route.ts",
    ]);
    // And the upgrader is really there, so removing it fails this test rather than
    // quietly reverting the member to the deadlocking refusal.
    expect(REFUSAL_CATCHERS, REFUSAL_UPGRADER).toContain(REFUSAL_UPGRADER);
  });

  it("upgrades the refusal to the linked-move offer where the member has nowhere to go", () => {
    // `INV-HOST-050`. The upgrade is conditional on the engine's own flag, so a
    // stranding the member CAN fix on the affected booking keeps today's refusal,
    // and it re-raises rather than swallowing — a refusal turned into a success
    // would strand the booking silently, which is the defect #3232 exists to fix.
    const source = readRepoCode(REFUSAL_UPGRADER);
    expect(source, REFUSAL_UPGRADER).toContain("error.linkedMoveWouldAnswer");
    expect(source, REFUSAL_UPGRADER).toContain("await offerLinkedDateMove(");
    expect(source, REFUSAL_UPGRADER).toContain("throw error;");
  });

  it("defers the hosting reconciliation from exactly one caller", () => {
    // `INV-HOST-051`. `hostingReconcile: "CALLER"` moves the supervision check to
    // the caller so a two-booking move is judged on the state that will really
    // commit; a caller that asked for it and then did not run the check would have
    // no supervision check at all. The service that owns the composition is the
    // only file permitted to ask, so a new caller cannot opt out of the rule by
    // copying a flag.
    expect(sourceFilesNaming('hostingReconcile: "CALLER"')).toEqual([
      "src/lib/booking-linked-date-move-service.ts",
    ]);
    // And it really discharges the obligation it took on, for every booking it
    // wrote rather than only the first.
    const source = readRepoCode(REFUSAL_UPGRADER);
    expect(source).toContain("await primary.pendingHostingReconcile?.()");
    expect(source).toContain("await entry.result.pendingHostingReconcile?.()");
  });

  it("waives a change fee from exactly one caller, and only on the dragged booking", () => {
    // #3232 D2. `waiveChangeFee` zeroes a member's late-notice change fee, so a
    // route that could set it from the request body would be a fee waiver any
    // member could ask for. It is a service argument rather than a field on
    // `BatchModifyInput` for that reason, and this pins the one file allowed to
    // pass it — the same shape as `hostingReconcile: "CALLER"` above.
    expect(sourceFilesNaming("waiveChangeFee: true")).toEqual([
      "src/lib/booking-linked-date-move-service.ts",
    ]);
    // It is NEVER accepted from the wire: no route schema may name it, and no
    // request-body type may carry it.
    expect(sourceFilesNaming("waiveChangeFee")).toEqual([
      "src/lib/booking-batch-modification-service.ts",
      "src/lib/booking-linked-date-move-service.ts",
    ]);
    // And the waiver really is the CLUB's answer rather than a constant: it is
    // driven by the setting, whose absent-row default is to charge.
    const source = readRepoCode(REFUSAL_UPGRADER);
    expect(source).toContain(
      "...(bothChangeFeesCharged ? {} : { waiveChangeFee: true })",
    );
    expect(source).toContain(
      "defaults?.linkedMoveChargesBothChangeFees ?? true",
    );
  });

  it("offers the linked move on BOTH date-capable member surfaces", () => {
    // #3232 D1, applied consistently. Widening the dependent read
    // (`INV-HOST-049`) makes a date move NOTICE the booking it leaves behind on
    // every date writer at once — so a route that widened the read and did not
    // gain the offer would refuse a move that used to succeed, and refuse it with
    // the deadlock the owner rejected. Both doors offer all three arms or neither
    // does, and this is the assertion that fails on a third date route that
    // forgets.
    expect(
      sourceFilesNaming("buildSameOwnerCoverageLinkedMoveBody("),
    ).toEqual([
      "src/app/api/bookings/[id]/modify-dates/route.ts",
      "src/app/api/bookings/[id]/modify/route.ts",
      "src/lib/adult-member-hosting-linked-move.ts",
    ]);
    // The offer must be answerable, not merely raisable: a surface that shows the
    // three arms and cannot accept the answer refuses the member twice with the
    // same sentence.
    expect(sourceFilesNaming("hostingCoverageLinkedMoveSchema")).toEqual([
      "src/app/api/bookings/[id]/modify-dates/route.ts",
      "src/app/api/bookings/[id]/modify/route.ts",
      "src/lib/adult-member-hosting-linked-move.ts",
    ]);
    // And the answer must reach a writer that honours it — the shared arms, never
    // a second copy of the policy per route (`INV-SSOT-001`).
    for (const route of [
      "src/app/api/bookings/[id]/modify-dates/route.ts",
      "src/app/api/bookings/[id]/modify/route.ts",
    ]) {
      expect(readRepoCode(route), route).toMatch(
        /modifyBooking(Dates)?WithLinkedMoveSupport\(/,
      );
    }
  });

  it("answers with the structured body, above any generic ApiError branch", () => {
    // Same positional trap as its #2569 sibling: `SameOwnerCoverageWouldBreakError`
    // extends `ApiError`, so below a generic branch the member loses the booking
    // references, the lodge and the uncovered nights.
    for (const file of REFUSAL_CATCHERS.filter(
      (candidate) => candidate !== REFUSAL_UPGRADER,
    )) {
      const source = readRepoCode(file);
      expect(source, file).toContain("buildSameOwnerCoverageRefusalBody(");
      const shared = sharedApiErrorName(source);
      if (shared === null) continue;
      const generic = source.indexOf(`instanceof ${shared}`);
      if (generic === -1) continue;
      expect(
        source.indexOf("instanceof SameOwnerCoverageWouldBreakError"),
        file,
      ).toBeLessThan(generic);
    }
  });

  it("returns the state-bound override prompt from every officer-capable catcher", () => {
    const catchers = sourceFilesNaming(
      "instanceof SameOwnerCoverageOverrideRequiredError",
    );
    expect(catchers).toEqual([
      "src/app/api/admin/booking-exception-requests/[id]/route.ts",
      "src/app/api/bookings/[id]/cancel/route.ts",
      "src/app/api/bookings/[id]/confirm-draft/route.ts",
      "src/app/api/bookings/[id]/guests/[guestId]/route.ts",
      "src/app/api/bookings/[id]/guests/route.ts",
      "src/app/api/bookings/[id]/modify-dates/route.ts",
      "src/app/api/bookings/[id]/modify/route.ts",
    ]);
    for (const file of catchers) {
      expect(readRepoCode(file), file).toContain(
        "buildSameOwnerCoverageOverrideRequiredBody(",
      );
    }
  });

  it("threads the state-bound retry through both admin shift dispatchers", () => {
    for (const file of [
      "src/app/api/bookings/[id]/modify/route.ts",
      "src/app/api/bookings/[id]/modify-dates/route.ts",
    ]) {
      const source = readRepoCode(file);
      const shift = source.slice(source.indexOf("await adminShiftBookingDates({"));
      expect(shift, file).toMatch(
        /adminShiftBookingDates\(\{[\s\S]*?hostingCoverageOverride:\s*parsed\.data\.hostingCoverageOverride/,
      );
    }
    const service = readRepoCode("src/lib/booking-date-modification-service.ts");
    const shiftService = service.slice(
      service.indexOf("export async function adminShiftBookingDates("),
    );
    expect(shiftService).toContain("actorMemberId: actor.id");
    expect(shiftService).toContain("override: hostingCoverageOverride");
  });

  it("uses the enqueue-only seam on exactly the confirming paths that must not refuse", () => {
    // §9 requires every confirming path to re-read the hosting facts. Most do it by
    // reconciling inside their own transaction, which REFUSES an uncovered booking at
    // an enforcing club. These cannot: capacity is claimed and money is in flight or
    // settled, so §8 applies instead — allow the transition, record the bounded
    // re-evaluation with it, escalate to an urgent incident afterwards.
    //
    // THIS LIST GREW BECAUSE THE FIRST VERSION OF IT WAS WRONG. It named five files
    // and read as though that were the whole confirming set, but the assertion only
    // pins who USES the seam — it cannot see a confirming path that uses NEITHER
    // seam, and five of them did not: the single payment settle door (whose payable
    // set includes DRAFT), the fully-credit-covered settlement, the inbound Xero
    // PAID, the admin waitlist force-confirm, and the group-settlement reaper's
    // CONFIRMED -> PAYMENT_PENDING revert, which de-confirms a coverage SOURCE.
    // `confirmingPathsUseAHostingSeam` below is the assertion that actually closes
    // that hole.
    expect(sourceFilesNaming("enqueueOwnHostingCoverageReevaluation(")).toEqual([
      "src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts",
      "src/app/api/admin/bookings/[id]/force-confirm/route.ts",
      "src/app/api/bookings/[id]/waitlist-confirm/route.ts",
      "src/app/api/payments/switch-to-internet-banking/route.ts",
      "src/lib/adult-member-hosting-review.ts",
      "src/lib/booking-credit-election.ts",
      "src/lib/cron-confirm-pending.ts",
      "src/lib/cron-group-settlement-reaper.ts",
      "src/lib/group-settlement.ts",
      "src/lib/payment-reconciliation.ts",
      "src/lib/xero-inbound/invoice-paid-effects.ts",
    ]);
  });

  it("leaves no confirming write without a hosting seam at all (#2576 §9)", () => {
    // The assertion the census above could not make. Every file that claims a
    // booking into a confirmed-or-paid state must reach the hosting rule by one of
    // the two seams — reconcile (refuse) or enqueue (escalate) — because §9 forbids
    // relying on a quote-time answer, and the statuses these writes come FROM
    // (DRAFT, WAITLISTED, WAITLIST_OFFERED, PAYMENT_PENDING) are all outside
    // `ACTIVE_BOOKING_STATUSES` and therefore invisible to the strand check that
    // guards a source cancellation. A booking could be created while cover existed,
    // have that cover cancelled with nothing stranded and nothing queued, and then
    // confirm here with no refusal, no incident, no owner email and nothing in the
    // officer queue.
    const CONFIRMING_WRITES = [
      "src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts",
      "src/app/api/admin/bookings/[id]/force-confirm/route.ts",
      "src/app/api/bookings/[id]/confirm-draft/route.ts",
      "src/app/api/bookings/[id]/waitlist-confirm/route.ts",
      "src/app/api/payments/switch-to-internet-banking/route.ts",
      "src/lib/booking-credit-election.ts",
      "src/lib/cron-confirm-pending.ts",
      "src/lib/group-settlement.ts",
      "src/lib/payment-reconciliation.ts",
      "src/lib/waitlist.ts",
      "src/lib/xero-inbound/invoice-paid-effects.ts",
    ];
    for (const file of CONFIRMING_WRITES) {
      const source = readRepoCode(file);
      const usesASeam =
        source.includes("enqueueOwnHostingCoverageReevaluation(") ||
        source.includes("reconcileAdultMemberHostingReviewWithSiblings(");
      expect(
        usesASeam,
        `INV-HOST-030 (docs/invariants/adult-member-hosting.md): ${file} claims a ` +
          "booking into a confirmed-or-paid state without reaching the hosting rule " +
          "by either seam — reconcile (refuse) or enqueue (escalate).",
      ).toBe(true);
    }
  });

  it("leaves no terminal status flip without a hosting seam at all (#3209)", () => {
    // THE CANCELLING COUNTERPART of the confirming assertion above, and it exists
    // because two writers passed every other check while never reaching the rule.
    // `group-cancel.ts` and `internet-banking-payment-cron.ts` both freed the BEDS
    // correctly — the cancellation read as fully reconciled — while CONFIRMED and
    // PAID, the two statuses they flip out of, are precisely the statuses that
    // qualify a booking as a coverage source. So each could remove the qualifying
    // adult covering another booking of the same owner with no incident, no owner
    // email and nothing in the officer queue.
    //
    // FOUND BY THE WRITE, not by a hand-kept list of cancel paths and not by the
    // hold-release constant. A hand-kept list is what failed here: both files
    // predate the rule and nothing ever added them. The constant was the first fix
    // attempted and it is not good enough either — measured, ten terminal writers
    // never spread it, so that guard would have certified the very omission class
    // it was written for. `terminalStatusFlips()` reads the `data:` object instead.
    //
    // SCOPED TO THE ENCLOSING FUNCTION, not the file. A whole-file search certifies
    // nothing about the branch doing the flip: `payment-reconciliation.ts` passed
    // one while its capacity-failed void reached no seam at all, because a seam
    // existed on the mutually exclusive settle path further down the same file.
    // What this CANNOT do is prove the seam is on the same control-flow branch as
    // the flip — that needs reachability analysis, not text — so it is a floor.
    // Deciding a branch really is covered stays a reviewer's job.
    //
    // THE EXEMPTIONS ARE TRANSITIONS THAT CANNOT REMOVE A SOURCE, keyed by
    // `file::function` so exempting one writer never exempts its neighbours. A
    // booking only supplies cover from CONFIRMED or PAID, and each reason below was
    // read off that writer's own `where` clause rather than assumed.
    const NOT_A_SOURCE_REMOVING_FLIP: Record<string, string> = {
      // `legacyDraft` only: the reject branch flips a DRAFT, and the claim's
      // `status: current.status` pins it to the status it read.
      "src/app/api/admin/bookings/[id]/review/route.ts::PATCH":
        "cancels a DRAFT on review rejection; a paid or confirmed booking keeps its status",
      // `where: { status: BookingStatus.PENDING }`.
      "src/lib/booking-cancel.ts::cancelLinkedProvisionalChildBookings":
        "cancels linked PENDING provisional children, which never supplied cover",
      // The hold is created AWAITING_REVIEW, and this branch runs only while the
      // quote is still SENT, so it cannot have been accepted and paid into a
      // coverage source.
      "src/lib/booking-request-quotes.ts::respondToBookingRequestQuote":
        "releases an AWAITING_REVIEW request hold when its quote is withdrawn",
      // `where: { status: BookingStatus.PAYMENT_PENDING }`.
      "src/lib/cron-group-settlement-reaper.ts::cancelReapedChildren":
        "cancels PAYMENT_PENDING children of a stale settlement",
      // Both `where: { status: BookingStatus.AWAITING_REVIEW }`.
      "src/lib/cron-quote-expiry-reminders.ts::releaseExpiredQuoteHolds":
        "releases an expired AWAITING_REVIEW quote hold",
      "src/lib/cron-quote-expiry-reminders.ts::releaseStaleModificationHolds":
        "releases a stale AWAITING_REVIEW modification hold",
      // `where: { status: { in: [WAITLISTED, WAITLIST_OFFERED] } }`.
      "src/lib/cron-waitlist.ts::processWaitlistCronOnce":
        "expires waitlist rows whose stay has already ended",
    };
    const SEAMS = [
      "enqueueOwnHostingCoverageReevaluation(",
      "enqueueHostingCoverageReevaluationForMember(",
      "reconcileAdultMemberHostingReviewWithSiblings(",
      "reconcileHostingReviewForSystemCancellation(",
    ];
    const flips = terminalStatusFlips();
    // A sweep that found nothing would pass in silence, and the reader could be
    // broken by a Prisma rename without a single failure.
    expect(flips.length).toBeGreaterThan(10);
    const seen = new Set<string>();
    for (const flip of flips) {
      const key = `${flip.file}::${flip.functionName}`;
      seen.add(key);
      if (key in NOT_A_SOURCE_REMOVING_FLIP) continue;
      expect(
        SEAMS.some((seam) => flip.scope.includes(seam)),
        `INV-HOST-041 (docs/invariants/adult-member-hosting.md): ${key} flips a ` +
          `booking to ${flip.status} without reaching the hosting rule by any ` +
          "seam, so cancelling a CONFIRMED or PAID coverage source there strands " +
          "the owner's other booking silently. Wire a seam, or add this key to " +
          "NOT_A_SOURCE_REMOVING_FLIP with the reason its transition cannot " +
          "remove a source.",
      ).toBe(true);
    }
    // An exemption for a writer that no longer exists is a claim nobody is
    // checking, and the previous version of this list carried exactly one: a file
    // whose only mention of the hold-release constant was inside a `//` comment
    // that `readRepoCode` strips, so it was never in the swept set and the
    // exemption could never fire.
    for (const key of Object.keys(NOT_A_SOURCE_REMOVING_FLIP)) {
      expect(
        [...seen],
        `${key} is exempted but no longer flips anything`,
      ).toContain(key);
    }

    // THE SECONDARY SIGNAL. `RELEASE_WHOLE_LODGE_HOLD_UPDATE` is spread by
    // cancel-like transitions, so a file that spreads it and shows NO flip above
    // is either a flip written in a shape the reader missed — the failure mode
    // that would make this whole sweep quietly vacuous — or a non-terminal release
    // that has to say so.
    const NOT_A_TERMINAL_FLIP: Record<string, string> = {
      // `PAYMENT_PENDING -> WAITLISTED`, verified: a release back to the queue, and
      // PAYMENT_PENDING was never a coverage source. Its own docblock records that
      // whether a RELEASE should re-evaluate cover is a question about all three
      // release sites at once, carried forward as its own issue.
      "src/app/api/admin/bookings/[id]/return-to-waitlist/route.ts":
        "releases from PAYMENT_PENDING to WAITLISTED, which is not a terminal flip",
    };
    const flipFiles = new Set(flips.map((flip) => flip.file));
    for (const file of sourceFilesNaming("RELEASE_WHOLE_LODGE_HOLD_UPDATE")) {
      if (file === "src/lib/booking-status.ts") continue;
      if (file in NOT_A_TERMINAL_FLIP) continue;
      expect(
        flipFiles.has(file),
        `INV-HOST-041: ${file} releases a whole-lodge hold but no terminal status ` +
          "write was found in it, so either the sweep's reader has stopped " +
          "recognising this file's write — which would make the sweep vacuous — " +
          "or the transition is not terminal and belongs in NOT_A_TERMINAL_FLIP.",
      ).toBe(true);
    }
  });

  it("never lets a system cancellation be refused by the hosting rule (#3209)", () => {
    // INV-HOST-041 (docs/invariants/adult-member-hosting.md).
    // Four authoritative transitions with no actor: an organiser's group cancel, an
    // expired Internet Banking hold, a capacity-failed Stripe void and a
    // cross-lodge price-drift unwind. §8 lists those shapes among the changes that
    // cannot reasonably be blocked, and the concrete failure is worse than a
    // refused request — a rolled-back release re-reads the same rows next run and
    // refuses again, deterministically, wedging the hold and its beds. So they go
    // through the seam that removes the refusal, never through the bare reconciler.
    const CALLERS = [
      "src/lib/group-cancel.ts",
      "src/lib/internet-banking-payment-cron.ts",
      "src/lib/payment-reconciliation.ts",
      "src/lib/waitlist-cross-lodge.ts",
    ];
    expect(
      sourceFilesNaming("reconcileHostingReviewForSystemCancellation("),
    ).toEqual(
      [...CALLERS, "src/lib/adult-member-hosting-system-cancellation.ts"].sort(),
    );
    for (const file of CALLERS) {
      // Inside the cancelling transaction, so the obligation commits with it.
      expect(readRepoCode(file), file).toContain(
        "reconcileHostingReviewForSystemCancellation(",
      );
    }
    // The two pure cancellation modules reach the rule ONLY through the seam. The
    // other two also settle payments and confirm bookings, so they legitimately
    // hold other hosting call sites and are not pinned this way.
    for (const file of [
      "src/lib/group-cancel.ts",
      "src/lib/internet-banking-payment-cron.ts",
    ]) {
      const source = readRepoCode(file);
      // The bare reconciler would refuse; the actor helper would ask an officer
      // for a confirmation nobody is there to give.
      expect(source, file).not.toContain(
        "reconcileAdultMemberHostingReviewWithSiblings(",
      );
      expect(source, file).not.toContain("hostingCoverageActorOptions(");
    }
    // And the seam REMOVES the refusal rather than catching it. The distinction is
    // the whole of #3209's second round: a catch has to put the interrupted
    // obligation back, and the fallback it used enqueued against the CANCELLED
    // SOURCE while the refusal is raised by a SIBLING — so at the DEFAULT host
    // scope (`sameBookingOwner: false`) the drain computed an empty dependent list
    // and recorded nothing at all. `REVIEW_ONLY` travels into the sibling loop by
    // design, so the sibling records its hazard in-transaction instead.
    const body = readRepoCode(
      "src/lib/adult-member-hosting-system-cancellation.ts",
    );
    expect(body).toContain('enforcement: "REVIEW_ONLY"');
    expect(body).not.toContain("catch");
    expect(body).not.toContain("enqueueOwnHostingCoverageReevaluation");
  });

  /**
   * The files that DEFINE the enqueue seams, plus the transaction-scoped helpers that
   * run inside somebody else's `tx` and so have no commit of their own to drain
   * after. Every other name reached by the sweep below would be a real gap.
   *
   * Shared by the two assertions that follow, because the exemption and the proof of
   * its premise have to be reading the same list — a helper exempted in one place and
   * unproven in the other is how the `member-guest-consent-service.ts` gap survived.
   */
  const TX_SCOPED_HELPERS = [
    "src/lib/adult-member-hosting-review.ts",
    // #3209 split the system-cancellation seam out of the engine for the same
    // reason #3128 split the ceilings out. It runs inside its callers' own
    // transactions, so it has no commit of its own to drain after; its four
    // callers are swept by the sweep above and by their own entrypoint below.
    "src/lib/adult-member-hosting-system-cancellation.ts",
    // #3128 moved `enqueueMemberMergeHostingCoveragePlan`'s DECLARATION out of
    // the engine and into its own module. The engine was exempt here, the new
    // module was not, so the sweep began demanding that a pure planner drain a
    // queue it never commits — a false red produced by a move, on the one half
    // of this test #2623 F3 hardened for callers and not for declarations.
    "src/lib/adult-member-hosting-merge-coverage-plan.ts",
    "src/lib/booking-credit-election.ts",
    "src/lib/booking-guest-removal-service.ts",
    "src/lib/booking-exception-approval.ts",
  ];

  it("drains after the commit on every path that can record work", () => {
    // A queue row with nobody draining it is §7's "immediate re-evaluation" turned
    // into "within three hours": that long before an incident a new officer-created
    // booking has just fixed is resolved, or before one it caused is raised.
    //
    // TREE-WIDE, WHICH IS WHAT THE FIRST VERSION OF THIS TEST ONLY LOOKED LIKE. It
    // swept the enqueue users and then checked a HARDCODED list of five change
    // paths, so five other files that reconcile — and therefore can enqueue, because
    // `dependentCoverage` defaults to ESCALATE — sat outside the assertion entirely:
    // waitlist.ts, booking-request.ts, booking-request-quotes.ts, group-booking.ts
    // and school-booking-request.ts. The sweep below finds them by what they CALL.
    // #2623 T9(a): the merge plan seam belongs here too. Nothing escaped without
    // it — `member-merge.ts` is its only caller and is pinned separately above,
    // and it does drain — but the whole point of finding seam users by what they
    // CALL is that the NEXT caller is covered without anybody remembering to add
    // it to a list.
    const ENQUEUE_SEAMS = [
      "enqueueOwnHostingCoverageReevaluation(",
      "enqueueHostingCoverageReevaluationForMember(",
      "enqueueMemberMergeHostingCoveragePlan(",
      "reconcileAdultMemberHostingReviewWithSiblings(",
      "reconcileHostingReviewForSystemCancellation(",
    ];
    const seamUsers = new Set<string>();
    for (const seam of ENQUEUE_SEAMS) {
      const users = sourceFilesNaming(seam);
      // A seam nobody calls contributes nothing, and a renamed seam left in this
      // list would degrade the sweep to the hardcoded list it replaced without
      // failing anything. Every entry has to be earning its place.
      //
      // NON-EMPTINESS IS TOO WEAK, and #2623 F3 found exactly where.
      // `sourceFilesNaming` matches any non-test file NAMING the identifier —
      // including the file that DECLARES it. Three of these four seams are
      // declared in `adult-member-hosting-review.ts`, which is also in
      // `TX_SCOPED_HELPERS` and so is skipped by the sweep below. So for
      // `enqueueMemberMergeHostingCoveragePlan(`, whose only real caller is
      // `member-merge.ts`, losing that caller would leave `users` as just the
      // declaration: non-empty, guard green, and `member-merge.ts` silently out
      // of the sweep — the exact regression this entry was added to prevent.
      // Discount the declaration and require a real CALLER. The declaring file
      // is found rather than hardcoded, so moving a seam to another module does
      // not quietly turn this back into the weaker check.
      const declaresSeam = `function ${seam.slice(0, -1)}(`;
      const callers = users.filter(
        (file) => !readRepoCode(file).includes(declaresSeam),
      );
      expect(
        callers,
        `${seam} has no caller outside its own declaration`,
      ).not.toEqual([]);
      for (const file of users) seamUsers.add(file);
    }
    for (const file of [...seamUsers].sort()) {
      if (TX_SCOPED_HELPERS.includes(file)) continue;
      expect(readRepoCode(file), file).toContain(
        "settleHostingCoverageAfterCommit(",
      );
    }
  });

  it("proves the carve-out's premise: every caller of a tx-scoped helper drains", () => {
    // THE CARVE-OUT ABOVE ASSERTS SOMETHING IT DOES NOT CHECK, and that unchecked
    // half is where a real gap hid. `booking-guest-removal-service.ts` is exempt on
    // the stated grounds that "its own callers drain" — and one of them did not:
    // `member-guest-consent-service.ts` routes a DECLINE and an EXPIRY through the
    // shared removal path, which reconciles and can enqueue, and then committed
    // without draining. §6 lists "removal or decline of required member-guest
    // consent" among the changes that must be re-evaluated, so the owner of a booking
    // that had just lost its cover waited up to three hours to be told.
    //
    // So the premise is now an assertion. A future helper added to the exempt list
    // brings its callers into this sweep automatically, which is the property the
    // hardcoded list never had.
    const EXPORTED_TX_ENTRYPOINTS: Record<string, readonly string[]> = {
      "src/lib/booking-guest-removal-service.ts": [
        "removeBookingGuestInTransaction(",
      ],
      "src/lib/booking-credit-election.ts": ["settleFullyCreditCoveredBooking("],
      "src/lib/booking-exception-approval.ts": [],
      // The seam definitions themselves; their callers are the sweep above.
      "src/lib/adult-member-hosting-review.ts": [],
      "src/lib/adult-member-hosting-merge-coverage-plan.ts": [],
      "src/lib/adult-member-hosting-system-cancellation.ts": [
        "reconcileHostingReviewForSystemCancellation(",
      ],
    };
    for (const helper of TX_SCOPED_HELPERS) {
      const entrypoints = EXPORTED_TX_ENTRYPOINTS[helper];
      // A helper added to the exempt list without saying how it is entered would
      // silently opt its callers out of the whole invariant.
      expect(entrypoints, `${helper} has no declared entrypoints`).toBeDefined();
      for (const entrypoint of entrypoints ?? []) {
        for (const caller of sourceFilesNaming(entrypoint)) {
          if (caller === helper) continue;
          expect(
            readRepoCode(caller),
            `${caller} calls ${entrypoint} and must drain after its commit`,
          ).toContain("settleHostingCoverageAfterCommit(");
        }
      }
    }
  });

  it("never drains through a transaction client", () => {
    // The drain takes the module client by default. A call that handed it a `tx`
    // would read the uncommitted rows it exists to re-read, and would send email
    // from a transaction that can still roll back.
    for (const file of sourceFilesNaming("settleHostingCoverageAfterCommit(")) {
      const source = readRepoCode(file);
      for (const call of source.matchAll(
        /settleHostingCoverageAfterCommit\(([^)]*)\)/g,
      )) {
        // The argument is a scoping object (`{ bookingId }`, `{ limit }`) — never a
        // client. `\btx\b` still catches the mistake this exists to catch, because a
        // transaction client is only ever named `tx` here.
        expect(call[1].trim(), `${file}: ${call[0]}`).not.toMatch(/\btx\b/);
      }
    }
  });

  it("pins hosting and lock seams to the confirming branches that need them", () => {
    const adminConfirm = readRepoCode(
      "src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts",
    );
    const adminZero = adminConfirm.slice(
      adminConfirm.indexOf("if (booking.finalPriceCents === 0)"),
      adminConfirm.indexOf("// No saved payment method"),
    );
    expect(adminZero).toContain(
      "reconcileBedAllocationsForBookingWithLodgeLockHeld({",
    );
    expect(adminZero).toContain("enqueueOwnHostingCoverageReevaluation(");
    expect(adminZero).toContain("settleHostingCoverageAfterCommit({ bookingId })");

    const cron = readRepoCode("src/lib/cron-confirm-pending.ts");
    const cronZero = cron.slice(
      cron.indexOf("if (booking.finalPriceCents === 0)"),
      cron.indexOf("const savedPayment = savedPaymentMethodForBooking"),
    );
    expect(cronZero).toContain("enqueueOwnHostingCoverageReevaluation(");

    const processingMarker = cron.indexOf(
      "status: PaymentStatus.PROCESSING,",
      cron.indexOf("export async function confirmPendingBookings"),
    );
    const processingRelease = cron.slice(
      cron.lastIndexOf("await prisma.$transaction", processingMarker),
      cron.indexOf('"Booking payment processing"', processingMarker),
    );
    const releaseOrder = [
      "pg_advisory_xact_lock(1)",
      "acquireLodgeCapacityLock(",
      "const lockedBooking = await tx.booking.findUnique(",
      "const released = await tx.booking.updateMany(",
      "reconcileBedAllocationsForBookingWithLodgeLockHeld(",
    ].map((marker) => processingRelease.indexOf(marker));
    expect(releaseOrder.every((index) => index >= 0)).toBe(true);
    expect(releaseOrder).toEqual([...releaseOrder].sort((a, b) => a - b));

    const groupSettlement = readRepoCode("src/lib/group-settlement.ts");
    const groupCommitCalls = [
      ...groupSettlement.matchAll(/await commitChildrenToConfirmed\(/g),
    ];
    expect(groupCommitCalls).toHaveLength(2);
    for (const call of groupCommitCalls) {
      const callerTail = groupSettlement.slice(call.index, call.index + 400);
      expect(callerTail).toContain("settleHostingCoverageAfterCommit({ limit: 25 })");
    }

    const xeroInbound = readRepoCode(
      "src/lib/xero-inbound/invoice-paid-effects.ts",
    );
    const xeroPaid = xeroInbound.slice(
      xeroInbound.indexOf("await acquireLodgeCapacityLock(tx, fresh.booking.lodgeId)"),
      xeroInbound.indexOf(
        "await enqueueOwnHostingCoverageReevaluation(fresh.bookingId",
      ),
    );
    const xeroOrder = [
      "await acquireLodgeCapacityLock(",
      "const locked = await tx.payment.findUnique(",
      "status: locked.booking.status",
      "reconcileBedAllocationsForBookingWithLodgeLockHeld(",
    ].map((marker) => xeroPaid.indexOf(marker));
    expect(xeroOrder.every((index) => index >= 0)).toBe(true);
    expect(xeroOrder).toEqual([...xeroOrder].sort((a, b) => a - b));
  });
});

describe("no writer can bypass Group Trip reconciliation (#3039)", () => {
  const REVIEW_SERVICE = "src/lib/adult-member-hosting-review.ts";

  /** The whole body of a top-level function, declaration to its column-0 brace. */
  function topLevelFunctionBody(source: string, name: string): string | null {
    const start = source.indexOf(`function ${name}(`);
    if (start === -1) return null;
    const closing = /\r?\n\}(?=\r?\n|$)/.exec(source.slice(start));
    if (!closing) return null;
    return source.slice(start, start + closing.index + closing[0].length);
  }

  /**
   * EVERY seam that reaches the hosting rule, and the count is THREE rather than two.
   *
   * The first two are the booking-write doors:
   * `reconcileAdultMemberHostingReviewWithSiblings` (reconcile, which can refuse) and
   * `enqueueOwnHostingCoverageReevaluation` (enqueue, for the confirming paths that
   * must not be refused).
   *
   * THE THIRD IS THE ONE THAT WAS MISSED, and it was missed because nothing about a
   * membership change looks like a booking change.
   * `enqueueHostingCoverageReevaluationForMember` is where the membership lifecycle
   * arrives — deactivation, archive, membership cancellation, consent decline, the
   * Xero lapse sync, account deletion, manual subscription payment. Host
   * qualification DEPENDS on membership standing (`participantQualifiesAsHost`
   * returns false for an inactive, cancelled or archived member and for an unsettled
   * subscription), so a lapse removes cover from every booking relying on that
   * person — including bookings on OTHER ACCOUNTS in the same Group Trip. Without the
   * fan-out here the seam enqueued for the bookings this person attends and nothing
   * else, and the stranded sibling was never reached: PERMANENTLY, because there is no
   * periodic full re-evaluation in this system — the three-hourly cron drains the
   * queue and nothing more.
   *
   * This list is what makes `INV-HOST-046`'s claim ("every writer that reaches the
   * hosting rule participates automatically") true rather than aspirational, so a
   * FOURTH seam belongs in it before it belongs in the tree.
   */
  const GROUP_FANOUT_SEAMS = [
    "reconcileAdultMemberHostingReviewWithSiblings",
    "enqueueOwnHostingCoverageReevaluation",
    "enqueueHostingCoverageReevaluationForMember",
  ];

  it("puts the fan-out inside every seam, so no writer has to know about trips", () => {
    // THE CENSUS THAT MAKES THE REST FREE. Thirty-odd booking writers and a dozen
    // membership writers reach the hosting rule through the three seams above. The
    // Group Trip fan-out lives inside ALL of them, so a writer that participates in
    // the hosting rule participates in the fan-out automatically and a NEW writer
    // cannot forget it.
    //
    // The alternative — a separate seam each writer had to call — is the arrangement
    // `INV-SSOT-001` refuses: forty call sites to keep right, and the failure mode
    // is a stranded booking on somebody else's account that nobody hears about.
    const review = readRepoCode(REVIEW_SERVICE);
    for (const seam of GROUP_FANOUT_SEAMS) {
      const body = topLevelFunctionBody(review, seam);
      expect(body, seam).not.toBeNull();
      expect(
        body ?? "",
        `INV-HOST-046 (docs/invariants/adult-member-hosting.md): ${seam} must run the Group Trip fan-out, or every writer reaching it silently skips the trip`,
      ).toContain("settleGroupTripDependentCoverage(");
      expect(
        body ?? "",
        `INV-LOCK-002 (docs/invariants/operations.md): ${seam} must take the per-trip key through the shared plan/lock/verify helper`,
      ).toContain("lockAndVerifyGroupTripCoverageDependents(");
    }
  });

  it("plans the trip's dependents BEFORE the participant fence, in every seam", () => {
    // NOT A STYLE POINT, it is what makes the queue writes legal.
    // `assertHostingCoverageQueueParticipantsLocked` demands that every owner an item
    // names is in the runtime-issued proof, and the proof locks exactly the owners it
    // was handed. So the sibling owners have to be discovered BEFORE the proof is
    // acquired; planning after it produces a proof that cannot admit the items the
    // fan-out is about to write, and every group edit would answer the stable retry
    // 409 forever.
    const review = readRepoCode(REVIEW_SERVICE);
    for (const seam of GROUP_FANOUT_SEAMS) {
      const body = topLevelFunctionBody(review, seam) ?? "";
      const plan = body.indexOf("planGroupTripCoverageDependents(");
      const proof = body.indexOf("acquireOrValidateQueueParticipantProof(");
      const key = body.indexOf("lockAndVerifyGroupTripCoverageDependents(");
      expect(plan, seam).toBeGreaterThan(-1);
      expect(proof, seam).toBeGreaterThan(-1);
      expect(
        plan,
        `INV-HOST-046: ${seam} must plan the Group Trip dependents before the participant fence, or their owners are outside the proof`,
      ).toBeLessThan(proof);
      // ...and the key after the fence, keeping the documented
      // participant-rows -> group -> owner order.
      expect(key, seam).toBeGreaterThan(proof);
    }
  });

  it("takes the trip key before the seam does anything that takes an owner key", () => {
    // WHY THIS IS A SEPARATE ASSERTION FROM THE BEHAVIOURAL ORDER TEST, and it was
    // added because a mutation escaped. Moving
    // `lockAndVerifyGroupTripCoverageDependents` BELOW the reconcile call leaves the
    // behavioural order test GREEN: the evaluator one call deeper takes the two keys
    // in the right order itself, so the recorded acquisition sequence is unchanged.
    // What that mutation really breaks is subtler — the fan-out's own dependent read
    // and its plan/verify would run after the reconcile had already evaluated and
    // written under the owner key, so the set the fan-out enqueues against would not
    // have been frozen for the evaluation that consumed it. Only a positional
    // assertion at the seam can see that.
    const review = readRepoCode(REVIEW_SERVICE);
    const seams: Record<string, string> = {
      reconcileAdultMemberHostingReviewWithSiblings:
        "reconcileAdultMemberHostingReview(",
      enqueueOwnHostingCoverageReevaluation: "enqueueHostingCoverageReevaluation(",
      // The membership seam's owner-key consumer is the plural helper: it locks every
      // affected booking OWNER together, in sorted order, and the trip keys must be
      // held before that (`INV-LOCK-002`).
      enqueueHostingCoverageReevaluationForMember:
        "tryLockHostingCoverageOwners(",
    };
    for (const [seam, ownerKeyTaker] of Object.entries(seams)) {
      const body = topLevelFunctionBody(review, seam) ?? "";
      const proof = body.indexOf("acquireOrValidateQueueParticipantProof(");
      const key = body.indexOf("lockAndVerifyGroupTripCoverageDependents(");
      // FROM THE PROOF ONWARDS, not from the start of the body.
      // `reconcileAdultMemberHostingReviewWithSiblings` calls the single-id
      // reconciler in its INACTIVE-MODE early return, above the fence and above any
      // key — that call takes nothing, and anchoring on it would make this assertion
      // unsatisfiable rather than strict.
      const consumer = body.indexOf(ownerKeyTaker, proof);
      expect(proof, seam).toBeGreaterThan(-1);
      expect(key, seam).toBeGreaterThan(-1);
      expect(consumer, seam).toBeGreaterThan(-1);
      expect(
        key,
        `INV-LOCK-002 (docs/invariants/operations.md): ${seam} must freeze the Group Trip under its per-trip key BEFORE ${ownerKeyTaker}, which reaches the per-owner key`,
      ).toBeLessThan(consumer);
    }
  });

  it("keeps the fan-out inside the engine, so nobody re-implements it", () => {
    // Every one of these is engine-internal. A second implementation anywhere in
    // `src/` would be a second definition of which bookings are in a trip and which
    // are stranded — and the two would drift in the direction that loses a dependent.
    for (const internal of [
      "planGroupTripCoverageDependents",
      "lockAndVerifyGroupTripCoverageDependents",
      "settleGroupTripDependentCoverage",
      "groupTripDependentFingerprint",
    ]) {
      expect(sourceFilesNaming(internal), internal).toEqual([REVIEW_SERVICE]);
    }
    // The per-trip key itself is minted in exactly one module, the same way the
    // per-lodge and per-owner keys are (`INV-LOCK-002`).
    expect(sourceFilesNaming("hosting-coverage-group")).toEqual([
      "src/lib/adult-member-hosting-coverage-lock.ts",
    ]);
  });

  it("resolves the trip's dependent bookings for the inline drain in exactly one place", () => {
    // The post-commit half. `settleHostingCoverageAfterCommit` is the ONE caller, so
    // the thirty-odd writers that already call it need no change at all — which is
    // also why the resolution had to go into the wrapper rather than its parameters.
    expect(
      sourceFilesNaming("loadGroupTripCoverageDependentBookingIds"),
    ).toEqual([
      "src/lib/adult-member-hosting-coverage-drain.ts",
      "src/lib/adult-member-hosting-review.ts",
    ]);
  });
});

describe("the participant fence is gated on the hosting policy (#2623 T5)", () => {
  const REVIEW_SERVICE = "src/lib/adult-member-hosting-review.ts";

  function functionStartsIn(service: string): number[] {
    return [...service.matchAll(/\n(?:export )?(?:async )?function \w+/g)].map(
      (match) => match.index ?? 0,
    );
  }

  it("reads the lodge's mode before every queue-participant acquisition", () => {
    // WHY STRUCTURAL. The behavioural proof lives in
    // `adult-member-hosting-same-owner.test.ts`, and it can only assert the sites
    // it happens to reach. This is the claim about the SET: a fourth seam added
    // later, or a gate quietly hoisted out of one of these three, is invisible to
    // every behavioural test that does not already exercise that seam — and the
    // consequence is a `FOR KEY SHARE NOWAIT` taken on an ordinary booking write
    // at a club with the rule switched off, which surfaces to the member as the
    // fixed payment-flavoured retry 409 and nothing else.
    //
    // `await` is part of the pattern so the declaration of
    // `acquireOrValidateQueueParticipantProof` in this same file is not read as a
    // call site.
    const service = readRepoCode(REVIEW_SERVICE);
    const functionStarts = functionStartsIn(service);
    const sites = [
      ...service.matchAll(/await acquireOrValidateQueueParticipantProof\(/g),
    ].map((match) => match.index ?? 0);
    // FOUR SITES ACROSS THE THREE ENQUEUE SEAMS. A change to this number is a new
    // fence: gate it, then say so here.
    //
    // The fourth is not a fourth seam. `enqueueOwnHostingCoverageReevaluation`
    // acquires its proof TWICE on one path since #3039: once over the booking plus its
    // Group Trip dependents, and — only in `bestEffort` mode, only after that first
    // acquisition was refused by a third party's contention — once over the booking
    // alone, so a `PAID` claim for an already-paid invoice is not rolled back by
    // somebody else's edit. Both sit inside the same mode-gated function, which is
    // what this test's per-site check requires.
    expect(sites).toHaveLength(4);

    for (const site of sites) {
      const enclosing = Math.max(
        ...functionStarts.filter((start) => start < site),
        -1,
      );
      const gate = service.lastIndexOf("loadAdultMemberHostingPolicy(", site);
      expect(
        gate,
        `a hosting fence at offset ${site} is acquired before its own function ` +
          "reads the policy mode: " +
          service.slice(site, site + 80).split("\n")[0],
      ).toBeGreaterThan(enclosing);
    }
  });

  it("keeps the un-fenced return fail-fast on the coverage-owner key", () => {
    // THE ONE THING THE GATE GIVES UP, kept bounded. Skipping the fence is safe
    // because an inactive mode reaches no coverage-owner key at all — but the
    // reconciler re-reads the mode for itself one call deeper, so in the narrow
    // window where a lodge turns the rule ON between the two reads, that return
    // IS a path to the coverage-owner advisory lock with no Member fence in
    // front of it. `true` is `failFastCoverageOwner`: it makes that acquisition
    // `pg_try_advisory_xact_lock`, so the worst case is the stable retry 409.
    // Flip it to `false` and the same window becomes a BLOCKING wait taken
    // inside the caller's booking transaction while it holds the global and
    // per-lodge capacity locks — the #2623 T6 hazard relocated, and invisible
    // to every behavioural test because the window needs two interleaved
    // policy reads to open.
    //
    // #3209 widened the CONDITION — the return is now taken only when this lodge
    // is inactive AND no related booking sits at an active one — and left this
    // property exactly as it was: whatever decides to skip, the call it skips to
    // still passes `true`. That is why the assertion names the flag rather than
    // the test that sets it.
    expect(readRepoCode(REVIEW_SERVICE)).toMatch(
      /if \(!sourceLodgeActive && !siblingOwedAtAnotherLodge\) \{\s*return reconcileAdultMemberHostingReview\(\s*bookingId,\s*db,\s*options,\s*true,?\s*\);/,
    );
  });

  it("leaves the shared standing-subject barrier deliberately mode-independent", () => {
    // THE OTHER HALF, AND IT IS THE ONE THAT COSTS SOMETHING TO GET WRONG.
    // `lockHostingCoverageMemberLifecycleTarget` looks like a fourth ungated
    // fence and is not one: every standing writer — deactivation, archive,
    // membership cancellation, consent decline, the Xero lapse sync, account
    // deletion — reaches it through this one function, and it is what makes a
    // concurrent booking-request linked-member hold and a deactivation mutually
    // exclusive. `docs/CONCURRENCY_AND_LOCKING.md` states the contract: the
    // hold's refusal "is independent of the lodge's hosting consequence
    // (DISABLED, ADMIN_REVIEW_REQUIRED, or ENFORCED), so review policy is not an
    // identity-safety backstop."
    //
    // A club-wide `ENFORCED` gate was written above it while implementing T5 and
    // real PostgreSQL refuted it: six interleavings in
    // `adult-member-hosting-queue-merge.realdb.test.ts` failed for DISABLED and
    // ADMIN_REVIEW_REQUIRED, because a deletion could then deactivate the member
    // and unlink the guest underneath a hold that had already read them active.
    // So this asserts the ABSENCE of a gate, with the reason, rather than letting
    // the next reader "finish the job".
    const service = readRepoCode(REVIEW_SERVICE);
    const barrier = service.indexOf(
      "await lockHostingCoverageMemberLifecycleTarget(",
    );
    expect(barrier).toBeGreaterThan(-1);
    const enclosing = Math.max(
      ...functionStartsIn(service).filter((start) => start < barrier),
      -1,
    );
    expect(
      service.slice(enclosing, barrier),
      "The standing-subject barrier now has a hosting-policy read above it in " +
        "its own function. That makes identity safety depend on review policy, " +
        "which docs/CONCURRENCY_AND_LOCKING.md forbids by name.",
    ).not.toContain("loadAdultMemberHostingPolicy(");
    // And it is still the FIRST thing that function does, so nothing — not even
    // an empty-fan-out early return — can commit before the subject is frozen.
    expect(
      service.slice(enclosing, barrier),
      "Work moved above the standing-subject barrier.",
    ).not.toContain("loadHostingCoverageMemberFanoutCandidates(");
  });
});

describe("no policy read inside a booking transaction (#2569 §7)", () => {
  it("the create path evaluates the proposed party before the creating service runs", () => {
    // `evaluateProposedAdultMemberHosting` loads the policy rows and the party's
    // member facts. The transaction belongs to `booking-create.ts`, which the three
    // creating branches of this route call; doing the read inside it would hold the
    // per-lodge capacity lock while taking a second pool connection, which is the
    // shape the booking rules forbid outright, and would serialise every concurrent
    // booking at the lodge behind those reads. The refusal also has to come first
    // for a plainer reason: it is the only point where the member can be handed the
    // exception door with the party they actually submitted.
    const source = readRepoCode("src/app/api/bookings/route.ts");
    const evaluation = source.indexOf(
      "await evaluateProposedAdultMemberHosting(prisma, {",
    );
    expect(evaluation).toBeGreaterThan(-1);
    // The ENFORCED refusal sits with it, above every creating call.
    const refusal = source.indexOf(
      'hostingViolation?.consequence === "ENFORCED"',
    );
    expect(refusal).toBeGreaterThan(evaluation);

    const creators = [
      "createDraftBooking({",
      "createConfirmedBooking({",
      "createWaitlistedBooking({",
    ];
    for (const creator of creators) {
      const call = source.indexOf(creator);
      expect(call, creator).toBeGreaterThan(-1);
      expect(refusal, creator).toBeLessThan(call);
    }
    // ...and the transaction really is the service's, not this route's.
    expect(source).not.toContain("prisma.$transaction(");
    expect(readRepoCode("src/lib/booking-create.ts")).toContain(
      "prisma.$transaction(",
    );
  });

  it("the exception-request re-evaluation reads through its own client", () => {
    // The override door: a member refused by a booking path re-submits the party
    // here, and this re-evaluation is what reproduces the violation server-side.
    // It takes the caller's client rather than reaching for the module-level one.
    const source = readRepoFile("src/lib/booking-exception-request-service.ts");
    expect(source).toContain("evaluateProposedAdultMemberHosting(db, {");
  });

  it("every proposed-booking evaluator carries the authoritative Booking.memberId", () => {
    const create = readRepoCode("src/app/api/bookings/route.ts");
    expect(create).toContain("bookingOwnerMemberId: effectiveMemberId");

    const groupJoin = readRepoFile("src/lib/group-booking.ts");
    expect(groupJoin).toContain("bookingOwnerMemberId: sessionUserId");

    const exceptionRequest = readRepoFile(
      "src/lib/booking-exception-request-service.ts",
    );
    expect(exceptionRequest).toContain(
      "bookingOwnerMemberId = resolveProposalBookingOwner(",
    );
    // From the ONE read of the live booking, not from anything the requester
    // sent, and not from a second `findUnique` of the same row.
    expect(exceptionRequest).toContain("loadProposalBooking(db, presence)");
    expect(exceptionRequest).toContain("bookingOwnerMemberId,");
  });

  it("the in-transaction reconcilers all pass the transaction client", () => {
    // The composition rule on `loadAdultMemberHostingPolicy`: a caller already
    // inside `prisma.$transaction` MUST pass its own `tx`, or the read checks out
    // a second connection underneath the advisory and capacity locks and sees a
    // different snapshot from the write it is about to decide.
    for (const file of sourceFilesNaming(
      "reconcileAdultMemberHostingReviewWithSiblings(",
    )) {
      if (file === "src/lib/adult-member-hosting-review.ts") continue;
      const source = readRepoFile(file);
      for (const call of source.matchAll(
        /reconcileAdultMemberHostingReviewWithSiblings\(\s*([^)]*)\)/g,
      )) {
        expect(call[1], `${file}: ${call[0]}`).toMatch(/,\s*tx\b/);
      }
    }
  });

  it("keeps the ENFORCED modification bypass exclusive to an approved exception", () => {
    // This option carries a prior attributable officer decision into the real
    // batch service, so it suppresses the ordinary ENFORCED refusal. A route or
    // another service copying it would create an unreviewed bypass even though
    // the implementation still typechecks. Pin both its declaration and its sole
    // supplier tree-wide.
    expect(
      sourceFilesNaming("approvedExceptionAdultMemberHostingDecision"),
    ).toEqual([
      "src/lib/booking-batch-modification-service.ts",
      "src/lib/booking-exception-approval.ts",
    ]);

    expect(readRepoCode("src/lib/booking-batch-modification-service.ts")).toMatch(
      /approvedExceptionAdultMemberHostingDecision\?:\s*\{[\s\S]*?reason:\s*string;[\s\S]*?byMemberId:\s*string;/,
    );
    expect(readRepoCode("src/lib/booking-exception-approval.ts")).toContain(
      "approvedExceptionAdultMemberHostingDecision:",
    );
  });
});

describe("the participant fence stays switched ON where a suite claims it (#2623 F1)", () => {
  /**
   * Suites that wire the #2619 fence doubles but leave the lodge's hosting mode
   * at the resolver's `DISABLED` default, so after #2623 T5's mode gate their
   * seam returns before the fence and the doubles beside it exercise nothing.
   *
   * THIS LIST IS THE POINT. The fence doubles' own docstring names "exercised
   * their seams with the fence effectively switched off" as the state to avoid,
   * and T5 silently put eleven suites into it — silently, because a double that
   * is never reached looks exactly like a double that passes. An exact `toEqual`
   * turns that into an enumerated, reviewable list: a NEW suite that wires the
   * doubles without an active policy fails here, and fixing one means deleting
   * its line.
   *
   * EIGHT OF THE ELEVEN HAVE NOW BEEN FIXED (#2675) and their lines deleted.
   * They were the FIXTURE-DEPTH group: supplying an active mode does not merely
   * re-enable the fence, it runs the hosting EVALUATOR, and their booking
   * fixtures were not hosting-evaluable. Guest rows carried `isMember: true`
   * with no nested `member`, and because `memberIsInGoodStanding` tests
   * `member !== null` — which `undefined` satisfies — the seam did not degrade
   * to "not a member", it read `undefined.active` and threw. The participant's
   * member data comes off the booking fixture's own guest rows, never a
   * `member.findMany` a double could intercept, so the fix was to complete each
   * fixture: `member` (a row via `hostingMemberRow`, or an explicit `null`),
   * `consentStatus`, `nights` and the stay window.
   *
   * MEASURED, TWICE, IN OPPOSITE DIRECTIONS — because "the fixture no longer
   * takes the shortcut" and "the fixture now reaches the fence" are different
   * claims and only the second one is coverage:
   *
   *  - a `throw` in the T5 early return (`adult-member-hosting-review.ts`, the
   *    `!hostingModeIsActive(planned.mode)` branch of
   *    `reconcileAdultMemberHostingReviewWithSiblings`) failed **77 of these
   *    eight suites' 198 tests** before the fixture work — 39 / 11 / 7 / 6 / 5 /
   *    3 / 3 / 3, in the order listed below — and fails **0 of 198** after it;
   *  - a `throw` inside `acquireOrValidateQueueParticipantProof` itself fails
   *    **exactly those same 77**, in exactly that per-suite split. The two
   *    numbers matching is the point: every test that used to skip the fence now
   *    executes it, rather than merely having stopped taking one branch.
   *
   * None of the eight needed an assertion changed. (77, not the 78 an earlier
   * draft of this docstring carried — that figure was never reproduced and the
   * issue's own probe table also says 77.)
   *
   * THE THREE THAT REMAIN ARE BLOCKED BY HOISTING, not by fixtures, and they
   * lose no coverage — measured, no test in them reaches the gate at all. Their
   * policy double lives inside a `vi.mock` factory, which vitest hoists above
   * the imports, so referencing `fenceHostingPolicyFindMany` there is a
   * `ReferenceError: Cannot access '__vi_import_N__' before initialization`.
   * They are recorded here permanently with that reason rather than left to look
   * like unfinished work.
   *
   * A note for whoever fixes the next one: several of the eight ALSO keep a
   * second, hoisted policy double inside their own `vi.mock("@/lib/prisma")`
   * factory, and those were deliberately left alone. They are dead weight —
   * every `reconcileAdultMemberHostingReviewWithSiblings` call site in `src/`
   * passes `tx`, never the singleton — which was confirmed by making one throw
   * and observing the suite stay green.
   */
  const FENCE_DOUBLES_WITHOUT_AN_ACTIVE_POLICY = [
    "src/lib/__tests__/booking-request-quotes.test.ts",
    "src/lib/__tests__/booking-request.test.ts",
    "src/lib/__tests__/school-booking-request.test.ts",
  ];

  it("lists every suite whose fence doubles the mode gate now bypasses", () => {
    const root = path.resolve(process.cwd(), "src");
    const wired: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.test\.tsx?$/.test(entry.name)) continue;
        const rel = path.relative(process.cwd(), full).split(path.sep).join("/");
        // COMMENT-STRIPPED, not raw (#2675 review). This file defines
        // `readRepoCode` precisely because a plain text search reads prose as a
        // call site, and the suites below carry long comments naming both the
        // module and the helper. Reading the raw file let an author delete the
        // wiring, keep the explanation, and stay green.
        const source = readRepoCode(rel);
        if (!source.includes("hosting-participant-fence-double")) continue;
        // The suite that DEFINES the hosting behaviour sets its own policies per
        // test rather than through the shared double, so it is not in scope.
        if (rel === "src/lib/__tests__/adult-member-hosting-review.test.ts") continue;
        // A real CALL, not the identifier appearing somewhere in the file.
        if (/fenceHostingPolicyFindMany\s*\(/.test(source)) continue;
        wired.push(rel);
      }
    };
    walk(root);
    expect(
      wired.sort(),
      "A suite wiring the #2619 fence doubles without an ACTIVE hosting policy " +
        "reaches none of them: T5's mode gate returns first. Either give its tx " +
        "double `fenceHostingPolicyFindMany()` (and make its booking fixtures " +
        "hosting-evaluable), or add it here with a reason.",
    ).toEqual(FENCE_DOUBLES_WITHOUT_AN_ACTIVE_POLICY);
  });

  /**
   * The census above can only see that the helper is CALLED — it cannot see what
   * mode the call states, and #2675 made `{ mode: ... }` an override eight
   * suites now write. Changing one of those words back to an inactive mode
   * restores the exact #2623 T5 bypass with every test in the tree still green,
   * because the gate returns before the fence and the doubles beside it simply
   * stop being reached. Nothing throws; coverage just evaporates.
   *
   * So the value is guarded where it is WRITTEN, and this pins that guard.
   */
  it("refuses to build a policy double in an INACTIVE hosting mode", async () => {
    const { fenceHostingPolicyFindMany } = await import(
      "./support/hosting-participant-fence-double"
    );

    for (const inactive of ["DISABLED", "", "enforced", null, undefined]) {
      expect(
        () =>
          fenceHostingPolicyFindMany({
            mode: inactive as unknown as "ENFORCED",
          }),
        `mode: ${JSON.stringify(inactive)} must be refused`,
      ).toThrow(/ACTIVE hosting mode/);
    }

    // Both ACTIVE modes stay available — the choice between refusing a hazard
    // and recording it is a real one a suite has to make.
    for (const active of ["ENFORCED", "ADMIN_REVIEW_REQUIRED"] as const) {
      const double = fenceHostingPolicyFindMany({ mode: active });
      await expect(double()).resolves.toEqual([
        expect.objectContaining({ mode: active }),
      ]);
    }
    // And the default, which states no mode at all, is still ENFORCED.
    await expect(fenceHostingPolicyFindMany()()).resolves.toEqual([
      expect.objectContaining({ mode: "ENFORCED" }),
    ]);
  });

  /**
   * The mode every wired suite actually states, read off the tree.
   *
   * Belt and braces with the runtime refusal in the helper: that one fires only
   * when a bad mode reaches it AT RUNTIME, so a call site inside a `describe`
   * nobody runs in a focused pass, or one behind a branch, can sit wrong for a
   * while. This reads the literal each suite writes, statically, so the census
   * owns the VALUE as well as the call. (The third route — dropping the helper
   * and hand-rolling a `DISABLED` double under the same key — is what the census
   * above catches: a suite wiring the fence doubles with no
   * `fenceHostingPolicyFindMany(` call is listed there or it fails.)
   */
  it("states an active mode at every fence-policy call site", () => {
    const root = path.resolve(process.cwd(), "src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.test\.tsx?$/.test(entry.name)) continue;
        const rel = path.relative(process.cwd(), full).split(path.sep).join("/");
        // This census file is the guard, not a subject of it: the test above
        // calls the helper deliberately with inactive modes to prove it refuses
        // them, and with a loop variable rather than a literal.
        if (rel === "src/lib/__tests__/adult-member-hosting-call-sites.test.ts") {
          continue;
        }
        const source = readRepoCode(rel);
        for (const match of source.matchAll(
          /fenceHostingPolicyFindMany\s*\(([^)]*)\)/g,
        )) {
          const args = match[1];
          if (!/\bmode\b/.test(args)) continue; // the default is ENFORCED
          if (/"(ENFORCED|ADMIN_REVIEW_REQUIRED)"/.test(args)) continue;
          offenders.push(`${rel}: ${match[0]}`);
        }
      }
    };
    walk(root);
    expect(
      offenders.sort(),
      "A fence policy double naming an INACTIVE mode switches the #2619 " +
        "participant fence off in the suite that wires it (#2623 T5's gate " +
        "returns first) while every test stays green — the #2675 bypass, " +
        "restored by one word. Use ENFORCED or ADMIN_REVIEW_REQUIRED.",
    ).toEqual([]);
  });
});


describe("the settings card and the evaluator use one set of words (#2576 §12)", () => {
  // THE GUARD THE COMPONENT'S OWN DOCBLOCK PROMISED, which did not exist. It
  // said "the route tests assert the two agree"; nothing did, and the card
  // therefore carried a free-standing second copy of every scope label and
  // description. That is exactly the drift `INV-SSOT-002` is about: the words an
  // admin ticks a box against would stop matching the words the config-transfer
  // guide and the officer-facing surfaces use, and no test anywhere would care.
  //
  // Importing the constants into the component is genuinely blocked — it is a
  // client component and `policies/adult-member-hosting.ts` imports a Prisma
  // VALUE, which cannot cross into the browser bundle. So the copy stays and is
  // POLICED, which is the weaker of the two `INV-SSOT` options and is used here
  // only because the stronger one is unavailable.

  const CARD = "src/components/admin/booking-policies/adult-member-hosting-section.tsx";

  /**
   * A `Record<key, "string">` literal from the card, as a map.
   *
   * Parsed off disk rather than imported because the constants are module-local
   * to a client component. Comment-stripped first, so a label quoted in prose
   * cannot satisfy the assertion — the failure mode a raw-text scanner has in
   * this repository, where defects are documented at the site that removed them.
   */
  function cardRecord(name: string): Record<string, string> {
    const source = readRepoCode(CARD);
    const start = source.indexOf(`const ${name}`);
    expect(start, name).toBeGreaterThan(-1);
    const open = source.indexOf("{", source.indexOf("=", start));
    const close = source.indexOf("\n}", open);
    expect(close, name).toBeGreaterThan(open);
    const body = source.slice(open + 1, close);
    const entries: Record<string, string> = {};
    for (const match of body.matchAll(
      // The join between literals is REQUIRED here, not optional. Written as
      // `(?:"..."\s*\+?\s*)+` the repeated group can match a bare `""`, so a run
      // of adjacent literals gives the engine several ways to divide the same
      // text and it backtracks exponentially — CodeQL js/redos, high severity,
      // raised against this line. This form reads one literal, then zero or more
      // genuinely-joined literals: unambiguous, one parse or none. It matches the
      // same strings. Worth fixing even in a test, because this census reads
      // every file in the tree, so a pathological one would hang CI rather than
      // fail it.
      /(\w+):\s*("(?:[^"\\]|\\.)*"(?:\s*\+\s*"(?:[^"\\]|\\.)*")*),/g,
    )) {
      entries[match[1]] = match[2]
        .split(/"\s*\+\s*"/)
        .join("")
        .replace(/^"|"$/g, "")
        .replace(/\\"/g, '"');
    }
    return entries;
  }

  /**
   * The scope-set FIELD that switches on `scope`, derived rather than hand-listed.
   *
   * `hostScopeEnabled`'s switch is exhaustive over the scope union, so turning
   * one field on at a time and asking which scope it enables recovers the
   * pairing without a second mapping for somebody to forget. A hand-written map
   * here would be the very duplication this block exists to refuse.
   */
  const allOff = Object.fromEntries(
    Object.keys(DEFAULT_ADULT_MEMBER_HOST_SCOPES).map((key) => [key, false]),
  ) as unknown as AdultMemberHostScopeSet;

  function fieldFor(scope: AdultMemberHostScope): string {
    const fields = Object.keys(allOff).filter((key) =>
      hostScopeEnabled({ ...allOff, [key]: true } as AdultMemberHostScopeSet, scope),
    );
    expect(fields, scope).toHaveLength(1);
    return fields[0];
  }

  it("shows every scope the evaluator has, and no others", () => {
    const expected = ADULT_MEMBER_HOST_SCOPES.map(fieldFor).sort();
    expect(Object.keys(cardRecord("HOST_SCOPE_LABELS")).sort()).toEqual(expected);
    expect(Object.keys(cardRecord("HOST_SCOPE_DESCRIPTIONS")).sort()).toEqual(
      expected,
    );
    // The render order is a separate literal and has to stay total too, or a new
    // scope is saveable through the API and invisible on the card.
    const order = readRepoCode(CARD).slice(
      readRepoCode(CARD).indexOf("const HOST_SCOPE_ORDER"),
    );
    for (const scope of ADULT_MEMBER_HOST_SCOPES) {
      expect(order.slice(0, order.indexOf("] as const")), scope).toContain(
        `"${fieldFor(scope)}"`,
      );
    }
  });

  it("uses the evaluator's exact label and description for each scope", () => {
    const labels = cardRecord("HOST_SCOPE_LABELS");
    const descriptions = cardRecord("HOST_SCOPE_DESCRIPTIONS");
    for (const scope of ADULT_MEMBER_HOST_SCOPES) {
      const field = fieldFor(scope);
      expect(labels[field], scope).toBe(ADULT_MEMBER_HOST_SCOPE_LABELS[scope]);
      expect(descriptions[field], scope).toBe(
        ADULT_MEMBER_HOST_SCOPE_DESCRIPTIONS[scope],
      );
    }
  });
});
