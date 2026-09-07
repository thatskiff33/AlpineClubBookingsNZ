import { readFileSync, readdirSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * Custodian occupancy — write-path contract (#2286).
 *
 * Enforcement is application-code exclusion (owner decision, option (a)): NO
 * database constraint stops a `BedAllocation` row landing on a custodian-held
 * bed-night. The only thing that does is a guard at each write path — so a new
 * write path added later, by someone who has never heard of custodians, would
 * silently punch a hole through the whole feature.
 *
 * This test is that alarm. It enumerates every place in `src/` and `prisma/`
 * that creates or moves a `BedAllocation` onto a bed, and asserts each one is
 * covered by a named mechanism. Adding a new write site fails CI until it is listed here
 * with the mechanism that protects it.
 */

function readRepoFile(relativePath: string) {
  // Test helper: reads a fixed repo file under process.cwd(); relativePath is test-controlled, not user input.
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

/**
 * Every `.ts`/`.tsx` file under `src/` and `prisma/`, as repo-relative POSIX
 * paths.
 *
 * The scan below used to look at three hand-listed files, which is exactly the
 * hole this test exists to close: a `bedAllocation.create*` added anywhere else
 * — a route handler, a seed, a new service — would never have been seen. The
 * walk is over both trees instead, so a new write site fails CI wherever it
 * lands. Tests are excluded: a mock's `createMany` spy is not a write path.
 */
function allSourceFiles(): string[] {
  const roots = ["src", "prisma"].map((dir) => path.resolve(process.cwd(), dir));
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (/\.test\.tsx?$/.test(entry.name)) continue;
      out.push(path.relative(process.cwd(), full).split(path.sep).join("/"));
    }
  };
  for (const root of roots) walk(root);
  return out.sort();
}

/**
 * Every known bed-PLACING write, and how the custodian exclusion reaches it.
 *
 * "Placing" means the statement sets `bedId` to a bed — creating an allocation
 * or moving one. Writes that only touch approval flags, `bedType` or
 * `isSecondOccupant` on a row that is already where it is are NOT placements
 * and are deliberately absent (they cannot introduce an occupant onto a held
 * bed-night).
 */
const GUARDED_WRITE_SITES: Array<{
  file: string;
  statement: string;
  /**
   * How many such statements this file is allowed to contain.
   *
   * Declared rather than inferred, and this is the whole point of the field
   * (#2688 review F3). The enumeration below compares a SET of
   * `file::statement` keys, so a second, entirely unguarded
   * `bedAllocation.createMany` dropped into a file already on this list — every
   * one of which is a real write path — used to be absorbed by the first
   * entry's key and never seen. `guest-stay-expansion-census.test.ts` records
   * the same lesson for its own table; this is that fix applied here.
   */
  occurrences: number;
  mechanism: string;
  /**
   * A string that must appear in the file for the mechanism to be real.
   *
   * Matched with runs of whitespace collapsed on BOTH sides (see
   * `containsEvidence`), so a reformat — Prettier-on-save wrapping a long call
   * across lines is the obvious one — cannot fail this test with a message
   * about a missing custodian guard when the guard is perfectly intact. The
   * evidence names the mechanism; it is not a formatting pin.
   */
  evidence: string;
}> = [
  {
    file: "src/lib/bed-allocation-placement.ts",
    statement: "bedAllocation.upsert",
    occurrences: 1,
    mechanism:
      "allocateBedNightWithLocksHeld calls assertBedNightsFreeOfCustodianHold before the upsert; every manual placement (single night, bulk drop, board move) funnels through it.",
    evidence: "await assertBedNightsFreeOfCustodianHold({",
  },
  {
    file: "src/lib/bed-allocation-auto-allocate.ts",
    statement: "bedAllocation.createMany",
    occurrences: 1,
    mechanism:
      "runAutoBedAllocation re-filters its suggestions against custodianHeldBedNightKeys inside its locked transaction.",
    evidence: "custodianHeldBedNightKeys(",
  },
  {
    file: "src/lib/bed-allocation-range-assign.ts",
    statement: "bedAllocation.createMany",
    occurrences: 1,
    mechanism:
      "runAssignBedRangeAttempt classifies held nights as the CUSTODIAN_HOLD refusal category before writing anything.",
    evidence: 'category: "CUSTODIAN_HOLD"',
  },
  {
    file: "src/lib/bed-allocation-range-assign.ts",
    statement: "bedAllocation.updateMany",
    occurrences: 1,
    mechanism:
      "The range path's batched updateMany only ever runs for targetNights with no refusal, and CUSTODIAN_HOLD is one of the refusal categories.",
    evidence: 'category: "CUSTODIAN_HOLD"',
  },
  {
    // NOT A PLACEMENT, and listed for that reason. The bed retype writer syncs
    // the denormalized `BedAllocation.bedType` (read only by the non-double
    // partial unique index) on rows that are ALREADY on that bed; `bedId`
    // appears in its WHERE, never in its `data`, so it can neither introduce an
    // occupant nor move one onto a held bed-night. The bed it acts on is being
    // retyped, which the custodian guards on deactivate/delete do not cover
    // because retyping takes nothing out of the pool.
    //
    // It is declared rather than excluded because the detector matches `bedId:`
    // anywhere in the statement, so an undeclared site here fails the census —
    // and because #2688 is how it surfaced at all: while every one of these
    // writers lived in `admin-bed-allocation.ts`, the RANGE path's
    // `updateMany` declaration covered this second, unrelated `updateMany` in
    // the same file. A file-and-statement-keyed census can absorb a second site
    // in an already-declared file, which is the lesson
    // `guest-stay-expansion-census.test.ts` records for its own table.
    file: "src/lib/bed-allocation-beds.ts",
    statement: "bedAllocation.updateMany",
    occurrences: 1,
    mechanism:
      "updateBedAllocationBedWithLocksHeld rewrites only the denormalized bedType on rows already sitting on that bed; bedId is a selector here, never written, so no occupant is introduced or moved.",
    evidence: "data: { bedType: input.bedType },",
  },
  {
    file: "src/lib/bed-allocation-lifecycle.ts",
    statement: "bedAllocation.createMany",
    occurrences: 2,
    mechanism:
      "autoAllocateMissingBedNights feeds custodian holds to the planner as #1768 unknown-occupant rows (blocking, never evictable), AND re-filters the payload against the live holds on the writing client immediately before both createManys — the reconcile is routinely called post-commit and unlocked, so the plan-time read alone would let a hold created in between be written over.",
    evidence: "dropRowsOnCustodianHeldBedNights(client, rows",
  },
  {
    file: "src/lib/bed-allocation-lifecycle.ts",
    statement: "bedAllocation.updateMany",
    occurrences: 1,
    mechanism:
      "The displacement MOVE writes `bedId: displacement.toBedId`, and every displacement comes from the same planner run that was fed the custodian holds as never-evictable unknown occupants — so a MOVE can never target a held bed-night either.",
    evidence:
      "bedId: displacement.toBedId,\n            roomId: displacement.toRoomId,",
  },
  {
    file: "prisma/demo-seed.ts",
    statement: "bedAllocation.create",
    occurrences: 1,
    mechanism:
      "The demo seed builds a fresh demo database from nothing: it creates its own rooms, beds and bookings and creates NO HutLeaderAssignment with a bedId, so there is no hold for it to write over. Listed rather than excluded so that adding a seeded custodian hold later forces whoever does it to re-read this entry and order the seed correctly.",
    evidence: "bedAllocation.create({",
  },
  {
    file: "src/lib/bed-allocation.ts",
    statement: "bedAllocation.createMany",
    occurrences: 1,
    mechanism:
      "replaceBedAllocationsForBooking is a DORMANT test seam with no production caller. It is listed so it can never be revived unguarded: reviving it means giving it a guard and updating this entry.",
    evidence: "// test seam",
  },
];

/**
 * The whole-lodge-hold half of the same contract (#2317).
 *
 * `dropRowsOn…`/`findBlockingWholeLodgeHolds` at a write path is what makes
 * DOMAIN_INVARIANTS' "both writers re-read the live holds immediately before
 * writing" a machine-checked claim rather than prose. Only the AUTOMATIC
 * placers appear: manual placement is deliberately never refused for a
 * whole-lodge hold (ADR-001 decision 1 hands the overlap to the officer), which
 * is the one place the two exclusions differ.
 */
const WHOLE_LODGE_GUARDED_WRITE_SITES: Array<{
  file: string;
  statement: string;
  mechanism: string;
  evidence: string;
}> = [
  {
    file: "src/lib/bed-allocation-auto-allocate.ts",
    statement: "bedAllocation.createMany",
    mechanism:
      "runAutoBedAllocation feeds the blocking holds to the planner as #1768 unknown-occupant rows AND re-reads them on the transaction client inside its locked transaction, dropping any suggestion landing on a held lodge-night.",
    evidence: "await findBlockingWholeLodgeHolds({",
  },
  {
    file: "src/lib/bed-allocation-lifecycle.ts",
    statement: "bedAllocation.createMany",
    mechanism:
      "autoAllocateMissingBedNights feeds the blocking holds to the planner AND re-filters the payload against the live holds on the writing client immediately before the createMany — the reconcile is routinely called post-commit and unlocked, so the plan-time read alone would let a hold created in between be written over.",
    evidence: "return dropRowsOnWholeLodgeHeldNights(client, offCustodianHolds, {",
  },
  {
    file: "src/lib/bed-allocation-lifecycle.ts",
    statement: "bedAllocation.updateMany",
    mechanism:
      "The displacement MOVE writes `bedId: displacement.toBedId`, and a displacement is applied only when the RE-CHECKED payload still claims the bed-night it frees — so a MOVE cannot survive the re-filter that dropped the row it was clearing the way for.",
    // #2669 review F1: the justification is now computed from `writable` — the
    // payload AFTER the occupancy filter, not just after the hold re-filters —
    // so a row dropped by any write-time re-check takes its displacement with
    // it. Strictly stronger than the `data` it replaced; same mechanism.
    evidence: "const applicable = justifiedDisplacements(writable);",
  },
];

/**
 * Whitespace-insensitive substring match — see the `evidence` note above.
 *
 * Whitespace is stripped entirely rather than collapsed, because a formatter
 * does not only wrap lines: it also adds and removes spaces inside argument
 * lists and braces. None of the evidence strings depend on whitespace inside a
 * string literal, so this costs nothing and removes the whole class of
 * "reformatting fails the guard test" false alarms.
 */
function containsEvidence(source: string, evidence: string): boolean {
  const squash = (value: string) => value.replace(/\s+/g, "");
  return squash(source).includes(squash(evidence));
}

/**
 * The balanced `open`..`close` region starting at `openIndex`.
 *
 * The same helper `bed-allocation-lock-topology-contract.test.ts` uses, and for
 * the same reason: a fixed-width window is not a call. The detector below used
 * a 400-character lazy window, and four of the nine declared sites are longer
 * than that — including `bedAllocation.upsert`, which is THE manual-placement
 * funnel this whole contract is about. Those four were invisible to the scan
 * that claims to enumerate the tree (#2688 review F3). Balancing the call's own
 * parentheses reaches all nine, whatever their size.
 */
function balancedFrom(
  text: string,
  openIndex: number,
  open: string,
  close: string,
): string {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    const char = text[i];
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex, i + 1);
    }
  }
  return text.slice(openIndex);
}

/**
 * How many bed-PLACING `bedAllocation.*` statements of each kind a file holds,
 * keyed `file::bedAllocation.<statement>`.
 *
 * `updateMany` on approval flags, `bedType` or `isSecondOccupant` is not a
 * placement, so only an `updateMany` whose call names a bed is counted — the
 * same rule as before, applied to the whole balanced call rather than to its
 * first 400 characters.
 */
function countPlacementStatements(
  file: string,
  source: string,
  into: Map<string, number>,
): void {
  const call = /bedAllocation\.(create|createMany|upsert|updateMany)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = call.exec(source)) !== null) {
    const statement = match[1];
    const args = balancedFrom(
      source,
      source.indexOf("(", match.index),
      "(",
      ")",
    );
    const placesABed = statement !== "updateMany" ? true : /bedId:/.test(args);
    if (!placesABed) continue;
    const key = `${file}::bedAllocation.${statement}`;
    into.set(key, (into.get(key) ?? 0) + 1);
  }
}

/** The whole tree's placement statements, counted per site. */
function placementStatementCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of allSourceFiles()) {
    countPlacementStatements(file, readRepoFile(file), counts);
  }
  return counts;
}

/**
 * Exactly one function's body, braces balanced from its own opening `{`.
 *
 * The alternative — slice from this signature to the next symbol's name, or to
 * end of file — is what made the lock assertions below vacuous (#2688 review
 * F1/F2). A whole-file `toContain` is satisfied by the IMPORT line; an
 * end-of-file slice is satisfied by anything appended after the function. A
 * balanced body can be satisfied only by the function itself, and it needs no
 * hard-coded "next symbol" string to stay bounded when the module is
 * reorganised.
 *
 * The parameter list is balanced first, then the return type is stepped over by
 * tracking angle brackets, so `Promise<{ … }>` cannot be mistaken for the body.
 */
function functionBody(source: string, signature: string): string {
  const at = source.indexOf(signature);
  expect(at, `${signature} is not in this file`).toBeGreaterThanOrEqual(0);
  const parensAt = source.indexOf("(", at);
  const params = balancedFrom(source, parensAt, "(", ")");

  let angle = 0;
  let bodyAt = -1;
  for (let i = parensAt + params.length; i < source.length; i += 1) {
    const char = source[i];
    if (char === "<") angle += 1;
    else if (char === ">") angle = Math.max(0, angle - 1);
    else if (char === "{" && angle === 0) {
      bodyAt = i;
      break;
    }
  }
  expect(bodyAt, `${signature} has no body`).toBeGreaterThan(parensAt);
  return balancedFrom(source, bodyAt, "{", "}");
}

/** Every token in `tokens`, in this order, within `text`. */
function expectInOrder(text: string, tokens: readonly string[]): void {
  let cursor = -1;
  for (const token of tokens) {
    const next = text.indexOf(token, cursor + 1);
    expect(next, `Expected ${token} after offset ${cursor}`).toBeGreaterThan(
      cursor,
    );
    cursor = next;
  }
}

/**
 * Every board writer that opens its OWN transaction and takes its own locks.
 *
 * The lock-held implementations are not here: they are handed a client that
 * already holds both keys, which is what their `WithLocksHeld` name promises.
 * These five are the ones where the keys are actually acquired, so these five
 * are where `INV-LOCK-002` — global `pg_advisory_xact_lock(1)` BEFORE the
 * per-lodge capacity key — is either honoured or lost.
 *
 * `chain` is asserted as an ORDER, not as a set of things present. That
 * distinction is the entire finding (#2688 review F1): the assertion this
 * replaces was a whole-file `toContain("acquireLodgeCapacityLock")`, which the
 * module's IMPORT line satisfies on its own. Measured: deleting every
 * `acquireLodgeCapacityLock(...)` CALL from `assignBedRange`,
 * `manuallyAllocateBed` or `manuallyAllocateBedForNights` left the suite green,
 * so all three could silently lose the lodge tier that makes the #2286
 * custodian-hold exclusion non-racy on exactly the paths it protects.
 */
const SELF_WRAPPED_WRITERS: ReadonlyArray<{
  file: string;
  signature: string;
  chain: readonly string[];
}> = [
  {
    file: "src/lib/bed-allocation-manual-writes.ts",
    signature: "export async function manuallyAllocateBed(",
    chain: [
      "resolveBedLodgeIdForLock(input.bedId, prisma)",
      "prisma.$transaction",
      "pg_advisory_xact_lock(1)",
      "acquireLodgeCapacityLock(tx, lockLodgeId)",
      "manuallyAllocateBedWithLocksHeld({ ...input, db: tx })",
    ],
  },
  {
    file: "src/lib/bed-allocation-manual-writes.ts",
    signature: "export async function moveBedAllocationsSameDate(",
    chain: [
      "resolveBedLodgeIdForLock(input.bedId, prisma)",
      "prisma.$transaction",
      "pg_advisory_xact_lock(1)",
      "acquireLodgeCapacityLock(tx, lockLodgeId)",
      "moveBedAllocationsSameDateWithLocksHeld({ ...input, db: tx })",
    ],
  },
  {
    file: "src/lib/bed-allocation-manual-writes.ts",
    signature: "export async function manuallyAllocateBedForNights(",
    chain: [
      "resolveBedLodgeIdForLock(input.bedId, prisma)",
      "prisma.$transaction",
      "pg_advisory_xact_lock(1)",
      "acquireLodgeCapacityLock(tx, lockLodgeId)",
      "manuallyAllocateBedForNightsWithLocksHeld({",
    ],
  },
  {
    // The one writer that does NOT use `resolveBedLodgeIdForLock`: a delete is
    // identified by allocation id, not by destination bed, so its lodge key
    // comes from the row itself — read INSIDE the transaction, after the global
    // lock, which is why the order below has the read between the two keys.
    file: "src/lib/bed-allocation-manual-writes.ts",
    signature: "export async function deleteBedAllocation(",
    chain: [
      "prisma.$transaction",
      "pg_advisory_xact_lock(1)",
      "tx.bedAllocation.findUnique",
      "acquireLodgeCapacityLock(tx, allocationKey.room.lodgeId)",
      "deleteBedAllocationWithLocksHeld({ ...input, db: tx })",
    ],
  },
  {
    file: "src/lib/bed-allocation-range-assign.ts",
    signature: "export async function assignBedRange(",
    chain: [
      "resolveBedLodgeIdForLock(input.bedId, prisma)",
      "prisma.$transaction",
      "pg_advisory_xact_lock(1)",
      "acquireLodgeCapacityLock(tx, lockLodgeId)",
      "assignBedRangeWithLocksHeld({ ...input, db: tx })",
    ],
  },
];

/** The modules the table above covers. */
const SELF_WRAPPED_WRITER_FILES = [
  ...new Set(SELF_WRAPPED_WRITERS.map((writer) => writer.file)),
];

describe("custodian write-path contract (#2286)", () => {
  it("covers every BedAllocation write site that places a guest on a bed", () => {
    // Rebuild the enumeration from the WHOLE source tree rather than trusting
    // the list above — or a hand-picked list of three files.
    const found = placementStatementCounts();

    const declared = new Set(
      GUARDED_WRITE_SITES.map((site) => `${site.file}::${site.statement}`),
    );
    const undeclared = [...found.keys()].filter((key) => !declared.has(key)).sort();

    expect(
      undeclared,
      "A BedAllocation write path is not covered by the custodian exclusion. " +
        "Enforcement is application-code only (#2286, option (a)) — there is no " +
        "database constraint behind it. Add the guard, then list the site in " +
        "GUARDED_WRITE_SITES with the mechanism that protects it.",
    ).toEqual([]);
  });

  it("counts them per SITE, so a second write in a declared file fails too", () => {
    // The gap this closes (#2688 review F3): the test above compares a SET of
    // `file::statement` keys, so a brand-new, entirely unguarded
    // `bedAllocation.createMany` added to `bed-allocation-range-assign.ts` — or
    // an unguarded `upsert` added to `bed-allocation-placement.ts` — was
    // absorbed by the existing key for that file and never reported. Both were
    // measured green before this test existed. Every file on the list is a real
    // write path, so "already declared" is precisely the wrong reason to trust
    // the next statement in it.
    const found = placementStatementCounts();

    const perSite = GUARDED_WRITE_SITES.map((site) => ({
      site: `${site.file}::${site.statement}`,
      occurrences: found.get(`${site.file}::${site.statement}`) ?? 0,
    }));

    expect(
      perSite,
      "The number of bed-placing statements in a declared file changed. A new " +
        "one needs its own custodian guard and its own accounting here; a " +
        "removed one needs the count lowered. Do not raise the number to make " +
        "this pass.",
    ).toEqual(
      GUARDED_WRITE_SITES.map((site) => ({
        site: `${site.file}::${site.statement}`,
        occurrences: site.occurrences,
      })),
    );
  });

  it("MUTATION PROBE: the detector sees a second statement and a long one", () => {
    // Pins the two properties the fix depends on, so a later "simplification"
    // back to a fixed-width window or a set-valued scan fails here rather than
    // silently reopening the hole.
    const twoWrites = [
      "await db.bedAllocation.createMany({ data: rows });",
      "await db.bedAllocation.createMany({ data: more });",
    ].join("\n");
    const long = `await db.bedAllocation.upsert({\n${"  // padding\n".repeat(60)}  where: { id },\n});`;
    const notAPlacement =
      "await db.bedAllocation.updateMany({ where: { id }, data: { approvedAt: null } });";

    const counts = new Map<string, number>();
    countPlacementStatements("probe.ts", twoWrites, counts);
    expect(counts.get("probe.ts::bedAllocation.createMany")).toBe(2);

    const longCounts = new Map<string, number>();
    countPlacementStatements("probe.ts", long, longCounts);
    expect(longCounts.get("probe.ts::bedAllocation.upsert")).toBe(1);

    const ignored = new Map<string, number>();
    countPlacementStatements("probe.ts", notAPlacement, ignored);
    expect(ignored.size).toBe(0);
  });

  it("keeps each declared mechanism actually present in its file", () => {
    for (const site of GUARDED_WRITE_SITES) {
      const source = readRepoFile(site.file);
      expect(
        containsEvidence(source, site.evidence),
        `${site.file} no longer contains the evidence for: ${site.mechanism}`,
      ).toBe(true);
    }
  });

  it("keeps the whole-lodge-hold exclusion on the same write paths", () => {
    // #2317 extended the same application-code-only pattern to exclusive
    // whole-lodge holds: no database constraint stands behind THAT exclusion
    // either, and it covers every bed of a lodge rather than one bed-night, so
    // a write path that loses the guard loses far more. Enumerated separately
    // from GUARDED_WRITE_SITES because the two exclusions do not cover the same
    // set of writes: manual placement is deliberately NOT refused for a
    // whole-lodge hold (ADR-001 decision 1 keeps the overlap officer-resolved),
    // whereas it is for a custodian hold.
    for (const site of WHOLE_LODGE_GUARDED_WRITE_SITES) {
      const source = readRepoFile(site.file);
      expect(
        containsEvidence(source, site.evidence),
        `${site.file} no longer contains the evidence for: ${site.mechanism}`,
      ).toBe(true);
    }
  });

  it("keeps the manual funnel guarded BEFORE it resolves sharing or upserts", () => {
    // #2688: the funnel and its single-night caller now live in different
    // modules. The body is brace-balanced rather than sliced to the next
    // symbol's name, so reordering the module cannot quietly widen or empty it.
    const funnel = functionBody(
      readRepoFile("src/lib/bed-allocation-placement.ts"),
      "export async function allocateBedNightWithLocksHeld(",
    );
    expectInOrder(funnel, [
      "assertBedNightsFreeOfCustodianHold",
      "bedAllocation.upsert",
    ]);
  });

  it("keeps utilisation reporting deliberately custodian-FREE, with the reason at the loop", () => {
    // The include/exclude split is a decision, not an accident
    // (docs/CAPACITY_MODEL.md): every ADMISSION path and the capacity-warnings
    // cron count the custodian; the utilisation report does not, because it
    // measures how much the lodge was BOOKED. Pinned here so a later "fix" that
    // adds the custodian to the report has to change this test and re-read the
    // decision first.
    const reports = readRepoFile("src/app/api/admin/reports/route.ts");
    expect(reports).not.toContain("custodian-occupancy");
    expect(reports).toContain("deliberately EXCLUDED");

    // And the other way round: the cron DOES count it. Since #2681 the cron no
    // longer builds the custodian counter itself — it calls the ONE shared
    // occupancy calculation, which counts the custodian as one of its terms. The
    // guarantee is unchanged, so it is asserted through that indirection: the
    // cron must reach occupancy via computeNightOccupancy, and
    // computeNightOccupancy must still include the custodian term.
    const cron = readRepoFile("src/lib/cron-capacity-warnings.ts");
    expect(cron).toContain("computeNightOccupancy");
    const capacity = readRepoFile("src/lib/capacity.ts");
    expect(capacity).toContain("buildLodgeCustodianNightCounter");
  });

  it.each(SELF_WRAPPED_WRITERS.map((writer) => [writer.signature, writer] as const))(
    "takes global then the per-lodge advisory lock, in order, in %s",
    (_signature, writer) => {
      // The guard's read and the write must sit inside the SAME lock the
      // custodian-hold writer takes, or the exclusion is racy by construction —
      // and per FUNCTION, because these five each open their own transaction.
      // The body is brace-balanced, so neither the import line nor a helper
      // added elsewhere in the module can satisfy this on the function's behalf.
      const body = functionBody(readRepoFile(writer.file), writer.signature);
      expectInOrder(body, writer.chain);
    },
  );

  it("leaves no self-wrapped writer in those modules undeclared", () => {
    // Derived from the source, so a SIXTH writer added next to the five above
    // has to be declared here rather than inheriting their assurance. Every
    // exported function in these modules that opens its own `prisma.$transaction`
    // is acquiring the keys itself and therefore owes the order above.
    for (const file of SELF_WRAPPED_WRITER_FILES) {
      const source = readRepoFile(file);
      const declared = SELF_WRAPPED_WRITERS.filter(
        (writer) => writer.file === file,
      ).map((writer) => writer.signature);

      const selfWrapped: string[] = [];
      for (const match of source.matchAll(/export async function (\w+)\(/g)) {
        const signature = `export async function ${match[1]}(`;
        if (functionBody(source, signature).includes("prisma.$transaction")) {
          selfWrapped.push(signature);
        }
      }

      expect(
        selfWrapped.sort(),
        `${file} has an exported function that opens its own transaction and is ` +
          "not in SELF_WRAPPED_WRITERS. It acquires the locks itself, so declare " +
          "its global -> lodge order there (INV-LOCK-002).",
      ).toEqual([...declared].sort());
    }
  });

  it("keeps the lodge lock key derived in exactly the declared modules", () => {
    // `resolveBedLodgeIdForLock` is the OUTSIDE-the-transaction read that mints
    // the per-lodge key. A third module calling it is a third writer deriving a
    // lock key, and the table above would not cover it.
    const callers = allSourceFiles()
      .filter((file) => /\bresolveBedLodgeIdForLock\(/.test(readRepoFile(file)))
      .filter((file) => file !== "src/lib/bed-allocation-placement.ts");

    expect(
      callers.sort(),
      "A module outside SELF_WRAPPED_WRITERS derives the per-lodge capacity " +
        "lock key. Declare its writers there so their lock order is checked too.",
    ).toEqual([...SELF_WRAPPED_WRITER_FILES].sort());
  });

  it("rebuilds and writes the auto-allocation plan only under global then lodge", () => {
    // runAutoBedAllocation was transaction-free and lock-free before #2286. The
    // slice used to run to end of file, justified by "it is now the whole of its
    // own module" — true today, enforced by nothing: stripping the locks out of
    // the function and appending a plausible helper BELOW it left this green
    // (#2688 review F2). The body is brace-balanced instead, so only this
    // function can satisfy it.
    const body = functionBody(
      readRepoFile("src/lib/bed-allocation-auto-allocate.ts"),
      "export async function runAutoBedAllocation(",
    );
    expectInOrder(body, [
      "pg_advisory_xact_lock(1)",
      "acquireLodgeCapacityLock(tx, lodgeId)",
      "bedAllocation.createMany",
      "prisma.$transaction",
    ]);
  });

  it("keeps existing-allocation moves global-then-destination locked, date-preserving and on the guarded manual funnel", () => {
    const source = readRepoFile("src/lib/bed-allocation-manual-writes.ts");
    const lockHeldMove = source.slice(
      source.indexOf(
        "export async function moveBedAllocationsSameDateWithLocksHeld(",
      ),
      source.indexOf("export async function moveBedAllocationsSameDate("),
    );
    const move = source.slice(
      source.indexOf("export async function moveBedAllocationsSameDate("),
      source.indexOf("interface BulkAllocationConflict"),
    );
    const wrapper = move.slice(
      move.indexOf("// Only the destination bed is read before the transaction"),
    );

    expect(wrapper.indexOf("resolveBedLodgeIdForLock(input.bedId, prisma)"))
      .toBeLessThan(wrapper.indexOf("prisma.$transaction"));
    expect(wrapper.indexOf("pg_advisory_xact_lock(1)"))
      .toBeLessThan(wrapper.indexOf("acquireLodgeCapacityLock(tx, lockLodgeId)"));
    expect(wrapper.indexOf("acquireLodgeCapacityLock(tx, lockLodgeId)"))
      .toBeLessThan(
        wrapper.indexOf(
          "return moveBedAllocationsSameDateWithLocksHeld({ ...input, db: tx })",
        ),
      );
    expect(lockHeldMove).toContain("return moveUnderLock(input.db)");
    expect(lockHeldMove).toContain("db.bedAllocation.findMany");
    expect(lockHeldMove).toContain("stayDate: formatDateOnly(source.stayDate)");
    expect(lockHeldMove).toContain("await manuallyAllocateBedWithLocksHeld({");
    expect(move).toContain("pg_advisory_xact_lock(1)");
  });
});
