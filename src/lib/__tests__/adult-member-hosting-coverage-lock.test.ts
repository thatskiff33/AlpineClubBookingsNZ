// #2576 §9 — the per-OWNER advisory lock that makes same-owner coverage
// deterministic.
//
// WHY THIS FILE EXISTS AT ALL. The lane's first design argued no new lock was
// needed, on the claim that "every path that can confirm a booking and every path
// that can remove exact-night attendance already takes the per-lodge capacity lock".
// When #2576 introduced the owner key, cancellation and confirmed creation used
// different global/lodge tiers, so the named race remained open. #2593 later made
// the allocation-participating create/cancel paths compose global → lodge, but the
// owner key remains authoritative because the cross-booking participant/member/queue
// writers do not all share those tiers. §9 forbids commit-order-dependent coverage.
//
// A unit test cannot prove two Postgres transactions serialise. What it CAN pin is
// everything that would silently disable the lock: the SQL shape, the namespace, the
// sorted acquisition order that keeps composition deadlock-free, and the fact that
// the coverage reads and writes call it at all. Each of those is a mutation that
// leaves every other test in the tree green.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

vi.mock("server-only", () => ({}));

import {
  HOSTING_COVERAGE_GROUP_LOCK_NAMESPACE_FOR_TESTS,
  HOSTING_COVERAGE_OWNER_LOCK_NAMESPACE_FOR_TESTS,
  lockHostingCoverageGroup,
  lockHostingCoverageGroups,
  lockHostingCoverageOwner,
  lockHostingCoverageOwners,
  tryLockHostingCoverageGroups,
} from "@/lib/adult-member-hosting-coverage-lock";

function readRepoFile(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

/**
 * The whole body of a top-level function, from its declaration to its own closing
 * brace — not a fixed number of characters from the declaration.
 *
 * A CHARACTER WINDOW IS NOT THE CONSTRUCT THESE ASSERTIONS MEAN TO PIN, and #2623
 * proved it: a comment added inside `enqueueHostingCoverageReevaluationForMember`
 * explaining WHY a neighbouring lock is deliberately ungated pushed the
 * `lockHostingCoverageOwner` call past `start + 4000`, and the test failed on a
 * change that moved no code at all. The failure mode in the other direction is
 * worse and silent: shrink a function and the window spills into the NEXT one, so
 * the assertion passes on a call that has been hoisted out of the guarded path
 * entirely — exactly the mutation this file exists to catch.
 *
 * Every source file here is prettier-formatted, so a top-level function ends at
 * the first line that is exactly `}` in column 0 after its declaration; nothing
 * inside the body is unindented. That makes the boundary exact without a parser.
 * The "line that is exactly `}`" part is load-bearing rather than pedantic:
 * `evaluateBookingAdultMemberHosting` returns a multi-line inline object type
 * whose own brace closes in column 0 as `}>`, so a bare search for a column-0 `}`
 * would end the body inside the signature and never reach a single statement.
 */
function topLevelFunctionBody(source: string, name: string): string | null {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) return null;
  // `\r?\n` on both sides, and NULL rather than a fall back to the rest of the
  // file, are the same guard twice. `*.ts` is pinned `eol=lf` in `.gitattributes`
  // precisely because a Windows checkout otherwise materialises CRLF — and if
  // that pin ever lapsed, an LF-only pattern would find no closing brace, a
  // rest-of-file fallback would then contain every OTHER holder's lock call, and
  // all four assertions would pass vacuously on Windows while still meaning
  // something on Linux CI. That is the #2399 failure mode exactly, so it fails
  // loudly instead.
  const closing = /\r?\n\}(?=\r?\n|$)/.exec(source.slice(start));
  if (!closing) return null;
  return source.slice(start, start + closing.index + closing[0].length);
}

/** A client that records the tagged-template SQL it was handed. */
function recordingClient() {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  return {
    calls,
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: strings.join("?"), values });
      return 1;
    }),
  };
}

describe("the per-trip coverage lock (#3039, INV-LOCK-002)", () => {
  // MOVED HERE FROM `adult-member-hosting-group-trip-reconciliation.test.ts` (#3039
  // review). That file had copied `topLevelFunctionBody` without the docblock that
  // makes it correct — the CRLF guard and the null-return-rather-than-fall-back
  // reasoning — and the helper plus its reasoning already live in this file, which is
  // also where the OTHER coverage lock family's unit tests are. One home for both
  // families (`INV-SSOT-001`), and the reconciliation file keeps only the assertions
  // that need its fan-out harness.
  it("takes a transaction-scoped advisory lock in its own namespace, keyed on the trip", async () => {
    const db = recordingClient();
    await lockHostingCoverageGroup(db, "group-trip-1");
    expect(db.calls).toHaveLength(1);
    const [call] = db.calls;
    // TRANSACTION-scoped: a session lock would outlive the transaction and never be
    // released by a pooled connection.
    expect(call.sql).toContain("pg_advisory_xact_lock");
    expect(call.sql).not.toContain("pg_advisory_lock(");
    expect(call.values).toEqual([
      HOSTING_COVERAGE_GROUP_LOCK_NAMESPACE_FOR_TESTS,
      "group-trip-1",
    ]);
    expect(HOSTING_COVERAGE_GROUP_LOCK_NAMESPACE_FOR_TESTS).toBe(
      "hosting-coverage-group",
    );
    // Its own keyspace. A namespace shared with the owner key would make one member's
    // account collide with an unrelated trip whose id happened to hash the same, and
    // would silently serialise them against each other.
    expect(HOSTING_COVERAGE_GROUP_LOCK_NAMESPACE_FOR_TESTS).not.toBe(
      HOSTING_COVERAGE_OWNER_LOCK_NAMESPACE_FOR_TESTS,
    );
  });

  it("acquires several trips in sorted order, so composing can never deadlock", async () => {
    const db = recordingClient();
    await lockHostingCoverageGroups(db, ["trip-z", "trip-a", "trip-m"]);
    expect(db.calls.map((call) => call.values[1])).toEqual([
      "trip-a",
      "trip-m",
      "trip-z",
    ]);
  });

  it("de-duplicates and ignores absent trips", async () => {
    const db = recordingClient();
    await lockHostingCoverageGroups(db, [
      "group-trip-1",
      "group-trip-1",
      null,
      undefined,
      "",
    ]);
    expect(db.calls).toHaveLength(1);
    const empty = recordingClient();
    await lockHostingCoverageGroups(empty, [null, undefined]);
    expect(empty.calls).toHaveLength(0);
  });

  it("is a no-op on a client that cannot run raw SQL, rather than throwing", async () => {
    await expect(
      lockHostingCoverageGroup({}, "group-trip-1"),
    ).resolves.toBeUndefined();
    await expect(
      lockHostingCoverageGroup(null, "group-trip-1"),
    ).resolves.toBeUndefined();
    await expect(
      tryLockHostingCoverageGroups({}, ["group-trip-1"]),
    ).resolves.toBe(true);
  });

  it("reports a lost race as false rather than waiting", async () => {
    const db = { $queryRaw: vi.fn(async () => [{ locked: false }]) };
    await expect(
      tryLockHostingCoverageGroups(db, ["group-trip-1"]),
    ).resolves.toBe(false);
    // One statement, not three: a lost key stops the sequence, so the caller never
    // holds a partial set it would then have to release in order.
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("mints both families through ONE blocking and ONE fail-fast statement", () => {
    // `INV-SSOT-001`. The owner key and the trip key differ in exactly two facts —
    // the namespace constant and the decode label — so a second hand-written pair of
    // statements per family is two more places for the `pg_advisory_xact_lock`
    // spelling, the two-argument `hashtext` form or the `AS "locked"` alias to drift.
    // A family that drifted to the SESSION-scoped `pg_advisory_lock(` would leak a
    // lock on a pooled connection with every other test in the tree still green.
    const lock = readRepoFile("src/lib/adult-member-hosting-coverage-lock.ts");
    expect(
      lock.match(/await db\.\$executeRaw`SELECT pg_advisory_xact_lock\(/g) ?? [],
      "INV-SSOT-001: both coverage lock families must take their key through one blocking statement",
    ).toHaveLength(1);
    expect(
      lock.match(/pg_try_advisory_xact_lock\(/g) ?? [],
      "INV-SSOT-001: both coverage lock families must try their key through one fail-fast statement",
    ).toHaveLength(1);
  });

  it("acquires the trip key ONLY through the one try-then-take protocol", () => {
    // F1, AND IT IS THE WHOLE DEADLOCK DEFENCE. `tryLockHostingCoverageGroup` before
    // the blocking form is what makes a trip key un-waitable: the try never waits, an
    // xact lock cannot be released before commit, so the blocking call after a
    // successful try is a re-entrant no-op and no transaction ever WAITS on a trip
    // key. Delete that one `if` and a real deadlock exists — T1 holds trip G and
    // blocks on owner M1 while T2 holds trip H, wins owner M1, then reaches trip G
    // through `inspectSameOwnerDependents` — and PostgreSQL answers `40P01`, which is
    // neither `55P03` nor the retry error, so it surfaces as a raw 500 rather than
    // the stable 409.
    //
    // THE BEHAVIOURAL ORDER TESTS CANNOT SEE THAT DELETION, which is why this exists.
    // They assert the FIRST acquisition of the recorded sequence is a try, and the
    // seam runs before the evaluator — so removing the evaluator's try still leaves
    // `[try, block, block]` and a green suite. A per-SITE census sees it wherever it
    // happens, exercised or not.
    const review = readRepoFile("src/lib/adult-member-hosting-review.ts");
    const protocol = topLevelFunctionBody(review, "acquireHostingCoverageGroupKey");
    expect(protocol, "acquireHostingCoverageGroupKey").not.toBeNull();
    const body = protocol ?? "";
    const tryIndex = body.indexOf("await tryLockHostingCoverageGroup(");
    const blockIndex = body.indexOf("await lockHostingCoverageGroup(");
    expect(
      tryIndex,
      "INV-LOCK-002 (docs/invariants/operations.md): acquireHostingCoverageGroupKey must TRY the trip " +
        "key fail-fast before taking it blocking — without that try the coverage-group tier can enter " +
        "a wait-for cycle and PostgreSQL answers 40P01, which surfaces as a raw 500",
    ).toBeGreaterThan(-1);
    expect(body).toContain("throw new HostingCoverageParticipantRetryError()");
    expect(
      blockIndex,
      "INV-LOCK-002: the blocking acquisition must come AFTER the try, or the try proves nothing",
    ).toBeGreaterThan(tryIndex);

    // AND NOWHERE ELSE MAY TAKE IT. Outside the minting module, every textual
    // acquisition of the blocking form has to be inside that one protocol function —
    // so a second call site cannot reintroduce the copy this census replaced, and
    // cannot omit the try while doing it.
    const outside = [
      ...review.matchAll(/await lockHostingCoverageGroups?\(/g),
    ].map((match) => match.index ?? -1);
    expect(outside.length).toBeGreaterThan(0);
    const protocolStart = review.indexOf(body);
    for (const site of outside) {
      expect(
        site >= protocolStart && site < protocolStart + body.length,
        "INV-SSOT-001: the per-trip key may be acquired only inside " +
          "acquireHostingCoverageGroupKey, which is the one place the try-then-take protocol is " +
          `written; found an acquisition at offset ${site}`,
      ).toBe(true);
    }
  });
});

describe("the per-owner coverage lock (#2576 §9)", () => {
  it("takes a transaction-scoped advisory lock in its own namespace", () => {
    const db = recordingClient();
    return lockHostingCoverageOwner(db, "owner-1").then(() => {
      expect(db.calls).toHaveLength(1);
      const [call] = db.calls;
      // TRANSACTION-scoped, not session-scoped: a session lock would outlive the
      // transaction and never be released by a pooled connection.
      expect(call.sql).toContain("pg_advisory_xact_lock");
      expect(call.sql).not.toContain("pg_advisory_lock(");
      // Two-argument form, keyed in its own namespace, so it can never collide with
      // `pg_advisory_xact_lock(1)`, the per-lodge key, the member-night key or the
      // credit-ledger key.
      expect(call.values).toEqual([
        HOSTING_COVERAGE_OWNER_LOCK_NAMESPACE_FOR_TESTS,
        "owner-1",
      ]);
      expect(HOSTING_COVERAGE_OWNER_LOCK_NAMESPACE_FOR_TESTS).toBe(
        "hosting-coverage-owner",
      );
    });
  });

  it("acquires several owners in sorted order, so composing can never deadlock", async () => {
    // The same discipline `lockBookingMemberNights` uses. Two transactions that each
    // need the same two owner keys must request them in the same order or they can
    // hold one and wait for the other forever.
    const db = recordingClient();
    await lockHostingCoverageOwners(db, ["owner-z", "owner-a", "owner-m"]);
    expect(db.calls.map((call) => call.values[1])).toEqual([
      "owner-a",
      "owner-m",
      "owner-z",
    ]);
  });

  it("de-duplicates and ignores absent owners", async () => {
    const db = recordingClient();
    await lockHostingCoverageOwners(db, ["owner-1", "owner-1", null, undefined, ""]);
    expect(db.calls).toHaveLength(1);
    const empty = recordingClient();
    await lockHostingCoverageOwners(empty, [null, undefined]);
    expect(empty.calls).toHaveLength(0);
  });

  it("is a no-op on a client that cannot run raw SQL, rather than throwing", async () => {
    // The hosting modules accept a narrow delegate-only client so they can be driven
    // by an in-memory store in tests. Throwing here would make the policy untestable
    // without a live Postgres; in production the client is always a real transaction
    // client, so the lock is always taken.
    await expect(lockHostingCoverageOwner({}, "owner-1")).resolves.toBeUndefined();
    await expect(lockHostingCoverageOwner(null, "owner-1")).resolves.toBeUndefined();
  });

  it("is taken by every reader and writer of same-owner cover", () => {
    // The mutation this catches is the quiet one: deleting a single
    // `lockHostingCoverageOwner` call leaves the whole tree green, because no unit
    // test can observe a missing lock. Three sites, and all three are load-bearing —
    // the evaluator (which READS another booking as cover), the settle step (which
    // reads the DEPENDENTS), and the enqueue-only seam the confirming paths use
    // instead of evaluating.
    const review = readRepoFile("src/lib/adult-member-hosting-review.ts");
    expect(
      (review.match(/await lockHostingCoverageOwner\(/g)?.length ?? 0) +
        (review.match(/await lockHostingCoverageOwners\(/g)?.length ?? 0),
    ).toBeGreaterThanOrEqual(4);
    for (const holder of [
      "evaluateBookingAdultMemberHosting",
      "settleSameOwnerDependentCoverage",
      "enqueueOwnHostingCoverageReevaluation",
      "enqueueHostingCoverageReevaluationForMember",
    ]) {
      // The lock must appear inside the function's OWN body — the point is that
      // the call has not been deleted or hoisted out of the guarded path, so the
      // slice has to end where the function does rather than a fixed distance in.
      const body = topLevelFunctionBody(review, holder);
      expect(body, holder).not.toBeNull();
      expect(body ?? "", holder).toContain("lockHostingCoverageOwner");
    }
  });

  it("is documented as the SECOND of the last two keys, after the per-trip one", () => {
    // THE TITLE USED TO SAY "the last key in the tree's acquisition order", and it
    // stayed there after #3039 put the per-TRIP `hosting-coverage-group` key above
    // this one. The body only asserted that the string `hosting-coverage-owner`
    // appeared somewhere in the document, so the test passed while its own name
    // asserted something false — which is worse than no test, because a reader
    // checking whether the order is pinned finds a green test claiming it is.
    //
    // The assertion now requires the document to state the ORDER, not merely to
    // mention the key. Deadlock-freedom is an ordering property, and an ordering
    // property that is not written down is one the next lane breaks.
    const doc = readRepoFile("docs/CONCURRENCY_AND_LOCKING.md");
    expect(doc).toContain("hosting-coverage-owner");
    expect(doc).toContain("hosting-coverage-group");
    expect(
      doc,
      "docs/CONCURRENCY_AND_LOCKING.md must state the coverage-group -> coverage-owner order " +
        "explicitly (INV-LOCK-002), not merely name both keys",
    ).toContain("coverage-group -> coverage-owner");
  });

  it("pins drain reconciliation to policy, lifecycle, Member row, refresh, then owner", () => {
    const drain = readRepoFile("src/lib/adult-member-hosting-coverage-drain.ts");
    const drainStart = drain.indexOf(
      "async function processHostingCoverageReevaluation(",
    );
    const drainBody = drain.slice(drainStart, drainStart + 9000);
    const drainPolicy = drainBody.indexOf("tryLockAdultMemberHostingPolicySet(db)");
    const policyDeferral = drainBody.indexOf('return { kind: "deferred" }');
    const lifecycleLock = drainBody.indexOf("member-lifecycle:${memberId}");
    const memberRowLock = drainBody.indexOf("FOR KEY SHARE");
    const exactRefresh = drainBody.indexOf(
      "loadClaimedHostingCoverageReevaluation(item, db)",
    );
    const identityStabilisation = drainBody.indexOf("refreshedMemberIds.some(");
    const sourceLifecycleRead = drainBody.indexOf(
      "isHostingCoverageSourceBookingTerminal(",
    );
    const dependentRead = drainBody.indexOf("loadSameOwnerCoverageDependentIds(");
    expect(drainPolicy).toBeGreaterThan(-1);
    expect(policyDeferral).toBeGreaterThan(drainPolicy);
    expect(policyDeferral).toBeLessThan(lifecycleLock);
    expect(lifecycleLock).toBeGreaterThan(drainPolicy);
    expect(memberRowLock).toBeGreaterThan(lifecycleLock);
    expect(exactRefresh).toBeGreaterThan(memberRowLock);
    expect(identityStabilisation).toBeGreaterThan(exactRefresh);
    expect(sourceLifecycleRead).toBeGreaterThan(identityStabilisation);
    expect(dependentRead).toBeGreaterThan(sourceLifecycleRead);

    const review = readRepoFile("src/lib/adult-member-hosting-review.ts");
    const start = review.indexOf(
      "function reconcileSameOwnerCoverageIncident(",
    );
    expect(start).toBeGreaterThan(-1);
    const body = review.slice(start, start + 7500);
    const policyLock = body.indexOf("lockAdultMemberHostingPolicySet(db)");
    const actorLock = body.indexOf("FOR KEY SHARE");
    const ownerReconciliation = body.indexOf(
      "reconcileAdultMemberHostingReview(params.bookingId",
    );
    expect(policyLock).toBeGreaterThan(-1);
    expect(actorLock).toBeGreaterThan(policyLock);
    expect(ownerReconciliation).toBeGreaterThan(actorLock);
    expect(body).toContain(
      "policy-set -> Member KEY SHARE -> coverage-GROUP ->",
    );

    const doc = readRepoFile("docs/CONCURRENCY_AND_LOCKING.md");
    expect(doc).toContain("policy-set → sorted member-lifecycle → sorted");
    expect(doc).toContain("Member KEY SHARE → exact queue re-read → coverage-owner");
    expect(doc).toContain("deliberately not a `FOR UPDATE`");

    const merge = readRepoFile("src/lib/member-merge.ts");
    const mergePolicyLock = merge.indexOf("lockAdultMemberHostingPolicySet(tx)");
    const mergeLifecycleLock = merge.indexOf("member-lifecycle:${lockA}");
    const relationMoves = merge.indexOf("const relationMoves = await applyMoves(");
    const mergeMemberRows = merge.indexOf(
      "lockMemberMergeHostingCoverageParticipants(tx,",
      relationMoves,
    );
    expect(mergePolicyLock).toBeGreaterThan(-1);
    expect(mergeLifecycleLock).toBeGreaterThan(mergePolicyLock);
    expect(relationMoves).toBeGreaterThan(mergeLifecycleLock);
    expect(mergeMemberRows).toBeGreaterThan(relationMoves);
    expect(
      readRepoFile("src/lib/adult-member-hosting-queue-participants.ts"),
    ).toMatch(/ORDER BY "id"\s+FOR UPDATE/);
  });

  it("keeps queued reconciliation in a real transaction and email after it", () => {
    const drain = readRepoFile("src/lib/adult-member-hosting-coverage-drain.ts");
    const itemTransaction = drain.indexOf("await db.$transaction((tx) =>");
    const reconciliation = drain.indexOf(
      "processHostingCoverageReevaluation(reconciliationItem, tx)",
      itemTransaction,
    );
    const notification = drain.indexOf(
      "await notifyOwnerOfLostCoverage(",
      reconciliation,
    );
    expect(itemTransaction).toBeGreaterThan(-1);
    expect(reconciliation).toBeGreaterThan(itemTransaction);
    expect(notification).toBeGreaterThan(reconciliation);
  });

  it("pins the merge participant re-plan, late sweeps, queue write and drain order", () => {
    const source = readRepoFile("src/lib/member-merge.ts");
    const executeStart = source.indexOf(
      "export async function executeMemberMerge(",
    );
    expect(executeStart).toBeGreaterThan(-1);
    const body = source.slice(executeStart, executeStart + 50_000);
    const markers = [
      "await lockAdultMemberHostingPolicySet(tx)",
      // #2595: the partner-share prefix (every affected lodge capacity key,
      // sorted — and deliberately NOT the global cohort key) sits BETWEEN the
      // policy-set key and the member-lifecycle pair. Pinned by position, because
      // taking it any later would invert the documented lodge -> member order.
      "await acquireMemberMergePartnerSharedLodgeLocks(",
      "member-lifecycle:${lockA}",
      // #2595: merge writes partner links (step 2) and READS them to decide a
      // destructive bed write (step 3b), so it takes the canonical
      // member-partner-link keys too — LAST, matching the reviewed move's
      // member-lifecycle -> member-partner-link order so no new wait-graph edge
      // is created. Pinned by position: taking it before the lifecycle pair
      // would invert that order against `bed-allocation-move.ts`.
      "await acquireMemberPartnerLinkLocks(tx, [masterId, loserId])",
      "const relationMoves = await applyMoves(",
      "const hostingPlan = await buildMemberMergeHostingCoveragePlan(",
      "await lockMemberMergeHostingCoverageParticipants(tx,",
      "refreshedHostingPlan = await buildMemberMergeHostingCoveragePlan(",
      "memberMergeHostingCoveragePlanFingerprint(hostingPlan)",
      "hostingParticipantProof = proveMemberMergeHostingCoverageParticipants(",
      "const residualLoserOwnedBookings = await tx.booking.findMany(",
      "const residualLoserGuestRows = await tx.bookingGuest.findMany(",
      "await lockHostingCoverageOwners(",
      "await applyLateHostingCoverageMoves(",
      // #2595 step 3b: after the moves and every drift refusal, before the Xero
      // teardown, and its alert strictly after the transaction commits.
      //
      // #2672 made one more thing about this position load-bearing, and it is
      // NOT the same reason: the sweep now opens with
      // `assertPartnerShareLodgeCoverageWithLocksHeld`, which re-derives the
      // members' whole guest-row lodge set and 409s if the prefix no longer
      // covers it. That is only a FENCE because it sits below
      // `lockMemberMergeHostingCoverageParticipants` — `BookingGuest.memberId`
      // is a foreign key to `Member`, so PostgreSQL takes `FOR KEY SHARE` on the
      // member row for every INSERT naming it and every UPDATE re-pointing one
      // onto it, and that conflicts with the sorted `Member … FOR UPDATE` the
      // participant lock takes. Below it, the set is frozen for the rest of the
      // transaction. Moved above it, the same call is a visibility check that
      // proves nothing about the future — the exact criticism #2641 drew. The
      // explicit paired assertion after this array states that reason in its own
      // failure message, because "markers out of order" would not.
      "sweptShares = await sweepUnbackedFutureSharedDoublesWithLocksHeld({",
      "await enqueueMemberMergeHostingCoveragePlan(",
      "await tx.member.delete({ where: { id: loserId } })",
      "await settleHostingCoverageAfterCommit({ limit: 50 }, client)",
      "sendAdminPartnerShareSweptAlert({",
    ];
    const positions = markers.map((marker) => body.indexOf(marker));
    expect(positions.every((position) => position >= 0), markers.join(" -> ")).toBe(
      true,
    );
    // #2672 — ONE pair out of that array, restated on its own and asserted
    // FIRST so the failure text carries the reason. Order matters here: the
    // generic `positions` comparison below reports only "markers out of order",
    // which a future editor moving step 3b up to sit beside the
    // member-lifecycle pair would satisfy by reordering the array. This fires
    // before it and says why the pair exists.
    const participantLockMarker = "await lockMemberMergeHostingCoverageParticipants(tx,";
    const sweepMarker = "sweptShares = await sweepUnbackedFutureSharedDoublesWithLocksHeld({";
    expect(
      body.indexOf(sweepMarker),
      "The partner-share sweep must stay BELOW lockMemberMergeHostingCoverageParticipants. " +
        "It opens with assertPartnerShareLodgeCoverageWithLocksHeld, which re-derives the " +
        "members' guest-row lodge set; BookingGuest.memberId is an FK to Member, so a guest-row " +
        "INSERT or re-point needs FOR KEY SHARE on the member row and cannot commit against the " +
        "sorted `Member … FOR UPDATE` that participant lock takes. Below it the set is FROZEN for " +
        "the rest of the transaction and the check is a fence. Above it, it is only a visibility " +
        "check about that instant and #2672 is reopened.",
    ).toBeGreaterThan(body.indexOf(participantLockMarker));

    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(body).toMatch(
      /const residualLoserGuestRows = await tx\.bookingGuest\.findMany\([\s\S]*?where: \{ memberId: loserId \}[\s\S]*?driftFields: \["BookingGuest\.member"\]/,
    );

    // #2672 — and the fence is only real on merge's OWN connection. The sweep's
    // `db` parameter is typed `BedAllocationLifecycleDb`, to which the global
    // `PrismaClient` is structurally assignable, so neither the compiler nor the
    // marker above (which stops at the opening brace) would reject a refactor
    // passing `db: prisma`. That would run the coverage re-derivation on a fresh
    // connection outside the `Member … FOR UPDATE`, silently downgrading the
    // fence back to a visibility check with every suite still green.
    expect(
      body,
      "sweepUnbackedFutureSharedDoublesWithLocksHeld must be handed the merge's own " +
        "transaction client (`db: tx`). On any other client the coverage re-derivation runs " +
        "outside merge's `Member … FOR UPDATE`, so the #2672 FK fence does not apply to it.",
    ).toMatch(
      /sweptShares = await sweepUnbackedFutureSharedDoublesWithLocksHeld\(\{[\s\S]*?db: tx,[\s\S]*?\}\)/,
    );
  });
});
