/**
 * The BOUNDED RUN that acts on the missing-Xero-contact census (#2939, a child
 * of MAD programme #2725). The rule is `INV-INT-023`; the rule this must not
 * break is `INV-INT-018`; the census is `xero-missing-contact-seeding.ts`, the
 * shape both return is `xero-missing-contact-seeding-shape.ts`, the operator
 * guide is `docs/guides/xero.md` -> "Create the missing Xero contacts in bulk"
 * and the design rationale is `docs/xero/ARCHITECTURE.md`.
 *
 * ## IT RESOLVES NOTHING ITSELF. That is the whole design.
 *
 * Every contact this creates or links is resolved by
 * {@link findOrCreateXeroContact} — the one funnel every Xero document writer
 * already uses — called once per member. Nothing here talks to Xero, mints an
 * idempotency key, writes a `Member.xeroContactId`, or decides whether a
 * provider contact already exists. Five rules therefore come with the funnel
 * rather than being re-implemented here, and each is one this issue could
 * otherwise have got subtly wrong: link-before-create by asking the PROVIDER
 * rather than the local cache; convergent retry and replay, through a
 * member-scoped reservation and idempotency key; the two-homes refusal
 * (`INV-INT-018`); the undeclared-installation refusal (`INV-CONFIG-005`, epic
 * #2986); and contact-email containment on a copy of the club's site.
 *
 * ## ONE THING IT DOES ASK THE FUNNEL TO DO DIFFERENTLY
 *
 * `requireAuthoritativeMatch`. The funnel's defaults are tuned for a document
 * writer, where the expensive outcome is a blocked invoice: a failed Xero
 * search falls through to a create, and a create Xero refuses on its
 * contact-name uniqueness rule is recovered by adopting the existing same-named
 * contact, on the NAME ALONE with no email comparison. Both trades INVERT here.
 * Nothing is blocked by refusing; what is expensive is a duplicate customer in
 * a ledger with no merge API, or worse, a new member silently linked to a
 * fifteen-year-old contact that happens to share their name — after which every
 * invoice, statement and reminder for them lands on somebody else's account.
 *
 * So this run passes the option, and a member the provider could not be asked
 * about authoritatively is recorded as a FAILURE the next run retries rather
 * than as a success. It then compares the contact id the funnel returned
 * against the one the reviewed plan promised, because a plan digest cannot see
 * a divergence that happens INSIDE the funnel after the plan already matched.
 *
 * ## WHY THIS IS NOT THE `INV-INT-019` BULK EXCEPTION
 *
 * That exception — one bulk path that does not take the two-homes refusal — was
 * written while this issue was unbuilt, and its parenthetical said bulk seeding
 * was #2939's subject, which reads as though whatever #2939 built would inherit
 * it. It does not, and the reason is structural rather than careful. The
 * refusal is unaffordable to a path holding ONE transaction open across many
 * contacts, because the contact-home key would then be held for the whole run.
 * This path holds no such transaction: it is a loop of independent per-member
 * calls, each opening the funnel's own short phase-2 transaction and closing it
 * before the next member starts. The lock is taken and released once per
 * member, exactly as for a single invoice — so a bulk run is
 * indistinguishable, from the lock's point of view, from the members being
 * invoiced one at a time, which is the state this tool exists to bring forward.
 * #2939 also closed the inbound exception rather than leaving it standing; see
 * `xero-contact-create-recovery.ts` and `xero-member-import.ts`.
 *
 * ## What the run may touch
 *
 * The intersection of the ids the operator reviewed with a freshly recomputed
 * pushable set, and nothing else. Both halves are load-bearing; `INV-INT-023`
 * is where that is written down, and
 * {@link runXeroMissingContactSeedingChunk} says what each half excludes.
 */

import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { XeroDailyLimitError } from "@/lib/xero-api-client";
import {
  XeroContactTwoHomesError,
  XERO_CONTACT_TWO_HOMES_CODE,
} from "@/lib/xero-contact-home";
import {
  findOrCreateXeroContact,
  XeroContactCreatePartialSuccessError,
  XeroContactProviderAnswerUnavailableError,
} from "@/lib/xero-contacts";
import { assertXeroProviderWriteAllowed } from "@/lib/xero-environment-write-gate";
import { getXeroMissingContactSnapshot } from "@/lib/xero-missing-contact-seeding";
import {
  CHUNK_WALL_CLOCK_BUDGET_MS,
  SeedingPlanChangedError,
  type MissingContactMemberRef,
  type SeedingFailureKind,
  type SeedingRunResult,
} from "@/lib/xero-missing-contact-seeding-shape";

/** The one contact-home refusal, recognised without depending on a message. */
function isTwoHomesRefusal(error: unknown): boolean {
  return (
    error instanceof XeroContactTwoHomesError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === XERO_CONTACT_TWO_HOMES_CODE)
  );
}

/**
 * How the funnel resolved this contact, read from the fact it persisted rather
 * than inferred: `findOrCreateXeroContact` writes `linkedVia: "created"` on the
 * canonical CONTACT link when it minted one and an `email_match` / `name_match`
 * value when it adopted one. An unlabelled row is reported as unlabelled, never
 * guessed — the count exists to tell an operator how many NEW customers a run
 * added to the club's books.
 */
async function readResolutionLabel(
  memberId: string,
  xeroContactId: string,
): Promise<"created" | "linked" | "unknown"> {
  const link = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel: "Member",
      localId: memberId,
      xeroObjectType: "CONTACT",
      xeroObjectId: xeroContactId,
      role: "CONTACT",
    },
    // At most one row: the five columns above are exactly the model's unique key.
    select: { metadata: true },
  });
  const metadata = link?.metadata;
  const linkedVia =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).linkedVia
      : undefined;
  if (linkedVia === "created") return "created";
  if (typeof linkedVia === "string" && linkedVia.length > 0) return "linked";
  return "unknown";
}

/**
 * Run one bounded chunk. `reviewedMemberIds` is what the operator confirmed;
 * the pushable set is recomputed here from the same classifier the dry run
 * used, and only the intersection is touched. The reviewed half excludes a
 * member who became eligible after the review; the recomputed half excludes a
 * reviewed member who has since stopped being pushable. See `INV-INT-023`.
 *
 * ## Three guards, and each one closes a different door
 *
 * `reviewedPlannedDigest` is what the operator reviewed, as a value. It is
 * COMPARED, not merely recorded: the membership test above is blind to a member
 * whose plan CHANGED while staying pushable — the operator approves "link Jane
 * to the contact Xero already has", the contact sync archives it underneath
 * them, and the member is still pushable, now as a CREATE. The sibling
 * grouping-resync refuses with `plan_changed` in exactly this situation; this
 * refuses with {@link SeedingPlanChangedError}.
 *
 * `requireAuthoritativeMatch` is passed to every funnel call, so a member whose
 * Xero search fails, or whose name collides with a contact Xero already holds,
 * is RECORDED AS A FAILURE and left where they were rather than being given a
 * speculative new contact or somebody else's old one. The next run picks them
 * up unchanged. A plan digest cannot catch that class, because the divergence
 * happens inside the funnel after the plan has already matched.
 *
 * The returned contact id is compared against the one the plan promised. When
 * the plan said "link to contact X" and the funnel linked to something else,
 * that is a `PLAN_DIVERGED` failure rather than a success — the count an
 * operator reads must never say "linked to a contact Xero already had" about a
 * link nobody reviewed.
 */
export async function runXeroMissingContactSeedingChunk(options: {
  reviewedMemberIds: string[];
  /** The `plannedDigest` of the dry run the operator reviewed. */
  reviewedPlannedDigest?: string;
  limit?: number;
  createdByMemberId?: string;
  /** Test seam for the wall-clock budget, in milliseconds since the loop began. */
  elapsedMs?: () => number;
}): Promise<SeedingRunResult> {
  const result: SeedingRunResult = {
    processed: 0,
    linkedExisting: 0,
    created: 0,
    resolvedUnlabelled: 0,
    failed: 0,
    failures: [],
    outcomes: [],
    skipped: [],
    remaining: 0,
    outstandingPushable: 0,
    done: true,
    haltedByDailyLimit: false,
    haltedByTimeBudget: false,
  };

  // The environment gate, asked ONCE and before anything else (#2986). The
  // funnel asks it again per member and `callXeroApi` refuses every mutation
  // underneath that, so this is a courtesy to the operator rather than the
  // control: it turns N identical refusals into one, and it cannot be the thing
  // that lets a run through, because it only ever throws.
  await assertXeroProviderWriteAllowed("createContacts");

  const snapshot = await getXeroMissingContactSnapshot();

  /*
    The plan check, BEFORE anything is touched, so a refusal here can leave
    nothing partial behind: no provider call has happened yet.
  */
  if (
    options.reviewedPlannedDigest !== undefined &&
    options.reviewedPlannedDigest !== snapshot.plannedDigest
  ) {
    throw new SeedingPlanChangedError();
  }

  const pushableById = new Map(
    snapshot.pushableRows.map((row) => [row.memberId, row]),
  );
  const reviewed = [...new Set(options.reviewedMemberIds)].sort((left, right) =>
    left.localeCompare(right),
  );
  /*
    Which reviewed members already hold a contact. This is what separates "an
    earlier chunk of this same review already did them" from "this member
    stopped being pushable" — two states the run used to report as one number,
    and only the second is something an operator has to look at.
  */
  const alreadyLinkedIds = new Set(
    (
      await prisma.member.findMany({
        where: { id: { in: reviewed }, xeroContactId: { not: null } },
        select: { id: true },
      })
    ).map((row) => row.id),
  );

  const targets: string[] = [];
  for (const memberId of reviewed) {
    if (pushableById.has(memberId)) targets.push(memberId);
    else {
      result.skipped.push({
        memberId,
        reason: alreadyLinkedIds.has(memberId)
          ? "ALREADY_DONE"
          : "NO_LONGER_PUSHABLE",
      });
    }
  }

  const chunkSize = Math.max(1, options.limit ?? snapshot.chunkSize);
  const chunk = targets.slice(0, chunkSize);

  // A REAL stopwatch. `Date.now()` is frozen for every unit test in this
  // repository, so a deadline built from it can never expire (docs/TESTING.md).
  const startedAt = process.hrtime.bigint();
  const elapsedMs =
    options.elapsedMs ??
    (() => Number(process.hrtime.bigint() - startedAt) / 1_000_000);

  let attempted = 0;
  for (const memberId of chunk) {
    /*
      The wall-clock budget. A route killed by its host's timeout loses the
      WHOLE result — the summary audit row is written after this returns — while
      every contact it created stays in Xero. Stopping and returning a partial
      result is strictly better than losing the record of one. Checked after at
      least one member so a chunk always makes progress.
    */
    if (attempted > 0 && elapsedMs() > CHUNK_WALL_CLOCK_BUDGET_MS) {
      result.haltedByTimeBudget = true;
      break;
    }
    attempted += 1;
    const planned = pushableById.get(memberId);
    const ref: MissingContactMemberRef = planned
      ? {
          memberId,
          memberName: planned.memberName,
          memberEmail: planned.memberEmail,
        }
      : { memberId, memberName: memberId, memberEmail: "" };
    try {
      const xeroContactId = await findOrCreateXeroContact(memberId, {
        createdByMemberId: options.createdByMemberId,
        // #2939: if the provider cannot be asked authoritatively, do nothing
        // for this member. See the docblock above.
        requireAuthoritativeMatch: true,
      });

      /*
        THE PLAN COMPARISON. A reviewed row that named a contact was reviewed AS
        that contact; the funnel resolving a different one is a divergence the
        operator never saw, not a success. The local link is already written by
        the time this reads it — the funnel owns that write and second-guessing
        it here would be a different bug — so this is reported loudly rather
        than reversed, with BOTH ids, which is what makes it actionable.
      */
      if (
        planned?.cachedXeroContactId &&
        planned.cachedXeroContactId !== xeroContactId
      ) {
        result.failed += 1;
        const message =
          "The dry run said this member would be linked to Xero contact " +
          `${planned.cachedXeroContactId}, and the run linked them to ` +
          `${xeroContactId} instead. Check both contacts in Xero before ` +
          "raising anything for this member.";
        result.failures.push({
          memberId,
          kind: "PLAN_DIVERGED",
          error: message,
        });
        result.outcomes.push({
          ...ref,
          outcome: "failed",
          xeroContactId,
          plannedEvidence: planned.evidence,
          kind: "PLAN_DIVERGED",
          error: message,
        });
        logger.error(
          { memberId, planned: planned.cachedXeroContactId, xeroContactId },
          "Xero missing-contact seeding: the funnel resolved a contact the reviewed plan did not name",
        );
        continue;
      }

      result.processed += 1;
      const label = await readResolutionLabel(memberId, xeroContactId);
      if (label === "created") result.created += 1;
      else if (label === "linked") result.linkedExisting += 1;
      else result.resolvedUnlabelled += 1;
      result.outcomes.push({
        ...ref,
        outcome:
          label === "created"
            ? "created"
            : label === "linked"
              ? "linked"
              : "unlabelled",
        xeroContactId,
        plannedEvidence: planned?.evidence ?? "NO_CACHED_MATCH",
        kind: null,
        error: null,
      });
    } catch (error) {
      // A daily limit stops the whole run rather than failing every remaining
      // member against a budget that is already spent. What is left stays
      // pushable, so the next dry run finds it unchanged.
      if (error instanceof XeroDailyLimitError) {
        result.haltedByDailyLimit = true;
        finishRun(result, targets.length, snapshot.pushable);
        result.done = false;
        logger.warn(
          { memberId },
          "Xero missing-contact seeding halted by the daily API limit",
        );
        return result;
      }
      result.failed += 1;
      const kind = classifyFailure(error);
      const message = error instanceof Error ? error.message : String(error);
      result.failures.push({ memberId, kind, error: message });
      result.outcomes.push({
        ...ref,
        outcome: "failed",
        xeroContactId: null,
        plannedEvidence: planned?.evidence ?? "NO_CACHED_MATCH",
        kind,
        error: message,
      });
      // One bad member does not stall the chunk: the funnel has already
      // recorded the operation FAILED and replayable (INV-INT-019), so the
      // next run picks this member up again with nothing duplicated.
      logger.error(
        { err: error, memberId },
        "Xero missing-contact seeding: member failed (continuing)",
      );
    }
  }

  finishRun(result, targets.length, snapshot.pushable);
  return result;
}

/**
 * ONE arithmetic for what is left, applied on EVERY exit.
 *
 * It used to be computed one way on the daily-limit halt and another way on the
 * normal path, so a failed member counted as outstanding in one branch and as
 * done in the other. A member is outstanding here exactly when the run did not
 * RESOLVE a contact for them, which is true on every branch, because every
 * non-resolution — not reached, failed, refused, timed out — leaves the member
 * exactly where they were and therefore pushable again next time.
 *
 * `outstandingPushable` is the same question asked of the whole population
 * rather than the reviewed slice. Past the row limit those are different
 * numbers, and reporting only the second is how the button said "next 25 of
 * 900" while the result said "475 still to do" on the same screen.
 */
function finishRun(
  result: SeedingRunResult,
  targetCount: number,
  populationPushable: number,
): void {
  result.remaining = targetCount - result.processed;
  result.done =
    result.remaining === 0 &&
    !result.haltedByTimeBudget &&
    !result.haltedByDailyLimit;
  result.outstandingPushable = Math.max(
    populationPushable - result.processed,
    result.remaining,
  );
}

/**
 * The failure kind, from the error's own TYPE rather than its message. The
 * two-homes refusal is recognised structurally (by class or by code) because it
 * crosses a module boundary; the rest are plain `instanceof`.
 */
function classifyFailure(error: unknown): SeedingFailureKind {
  if (isTwoHomesRefusal(error)) return "TWO_HOMES_REFUSAL";
  if (error instanceof XeroContactCreatePartialSuccessError) {
    return "PARTIAL_SUCCESS";
  }
  if (error instanceof XeroContactProviderAnswerUnavailableError) {
    return error.phase === "DUPLICATE_NAME_RECOVERY"
      ? "NAME_ALREADY_IN_XERO"
      : "PROVIDER_ANSWER_UNAVAILABLE";
  }
  return "OTHER";
}
