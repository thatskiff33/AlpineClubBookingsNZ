/**
 * The missing-Xero-contact census, and the bounded run that acts on it (#2939).
 * `INV-INT-022` (census) and `INV-INT-023` (run). The census is
 * `src/lib/xero-missing-contact-seeding.ts`, the
 * run `src/lib/xero-missing-contact-seeding-run.ts`, and the shape they return
 * `src/lib/xero-missing-contact-seeding-shape.ts`.
 *
 * GET is the dry run and is read-only in the strongest sense available here —
 * it is a GET, it needs only `finance:view`, and the engine it calls writes
 * nothing at all. POST is the run: `finance:edit`, an explicit confirmation,
 * the reviewed member ids, and the DIGEST of the plan those ids were reviewed
 * against, which the engine re-computes and compares before it touches anybody.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { logAudit } from "@/lib/audit";
import { requireAdmin } from "@/lib/session-guards";
import { isXeroConnected } from "@/lib/xero-token-store";
import { XeroContactEnvironmentUnknownError } from "@/lib/xero-environment-write-gate";
import { getXeroMissingContactSnapshot } from "@/lib/xero-missing-contact-seeding";
import { runXeroMissingContactSeedingChunk } from "@/lib/xero-missing-contact-seeding-run";
import { SeedingPlanChangedError } from "@/lib/xero-missing-contact-seeding-shape";

/** Rows returned per bucket. The counts are always the full population. */
const DEFAULT_ROW_LIMIT = 500;

const CACHE_NOT_READY =
  "Xero contacts have never been synced into this application, so a dry run " +
  "cannot tell which members already have a contact in Xero. Run Contact Sync " +
  "first, then come back.";

const NOT_CONNECTED =
  "Xero is not connected. Connect Xero before creating any contacts.";

export async function GET(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const rawLimit = request.nextUrl.searchParams.get("limit");
  const parsedLimit = rawLimit === null ? DEFAULT_ROW_LIMIT : Number(rawLimit);
  const limit =
    Number.isInteger(parsedLimit) && parsedLimit >= 1 && parsedLimit <= 2000
      ? parsedLimit
      : DEFAULT_ROW_LIMIT;

  const snapshot = await getXeroMissingContactSnapshot({ limit });
  return NextResponse.json({
    snapshot,
    // Said by the server rather than assembled in the panel, so the one
    // condition that makes every count meaningless reads the same everywhere.
    notReadyMessage: snapshot.cacheReady ? null : CACHE_NOT_READY,
  });
}

const postSchema = z.object({
  /*
    The operator's explicit confirmation, and the reviewed set it applies to.

    `memberIds` is NOT the authority for what gets pushed — the engine
    recomputes the pushable set and processes the intersection — so a forged id
    buys nothing. What posting the set DOES buy is the other half of the rule:
    a member who became eligible between the review and the run is absent from
    it, and is therefore never touched by a confirmation nobody gave for them.
  */
  confirmReviewed: z.literal(true),
  memberIds: z.array(z.string().min(1)).min(1).max(5000),
  /*
    The digest of the plan those ids were reviewed against. It is what closes
    the door `memberIds` cannot: a member can stay pushable while what would
    HAPPEN to them changes — the operator approves "link Jane to the contact
    Xero already has", the contact sync archives it underneath them, and the
    member is still pushable, now as a create. Required, because a client that
    omitted it would be asking for exactly the unguarded run this field exists
    to prevent.
  */
  plannedDigest: z.string().min(1),
  // Capped low: each member costs two to four Xero calls depending on whether
  // contact grouping is on, and a small chunk is what lets an operator stop a
  // run that is going wrong. Omitted, the engine derives it from that cost.
  limit: z.number().int().min(1).max(100).optional(),
});

export async function POST(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const body = await request.json().catch(() => null);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Checked here as well as inside the per-member funnel: without a connection
  // every member in the chunk would fail individually, which reads to an
  // operator as a data problem rather than a connection one.
  if (!(await isXeroConnected())) {
    return NextResponse.json({ error: NOT_CONNECTED }, { status: 409 });
  }

  let result;
  try {
    result = await runXeroMissingContactSeedingChunk({
      reviewedMemberIds: parsed.data.memberIds,
      reviewedPlannedDigest: parsed.data.plannedDigest,
      limit: parsed.data.limit,
      createdByMemberId: session.user.id,
    });
  } catch (error) {
    /*
      The reviewed plan no longer matches, so nothing was done. 409 rather than
      400: the request was well formed and the SERVER's state moved, which is
      the same answer the sibling grouping re-sync gives for `plan_changed`.
    */
    if (error instanceof SeedingPlanChangedError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    /*
      The undeclared-installation refusal (#2986, INV-CONFIG-005). It is raised
      before anything reaches Xero, and its message is written for an operator —
      it names what did NOT happen and where to fix it — so it is surfaced
      verbatim rather than replaced with a generic 500.
    */
    if (error instanceof XeroContactEnvironmentUnknownError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }

  /*
    One summary row per chunk, category `xero` — the subsystem every other
    writer of a member's contact link already records under, so this correlates
    with them rather than splitting the subsystem (INV-PRIV-013).

    COUNTS AND IDS ONLY. No member names and no email addresses: the panel is
    where an operator reads who was touched, and an audit row is read by more
    people and kept for longer (INV-PRIV).
  */
  logAudit({
    action: "XERO_MISSING_CONTACT_SEEDING_RUN",
    category: "xero",
    memberId: session.user.id,
    details: JSON.stringify({
      reviewedCount: parsed.data.memberIds.length,
      processed: result.processed,
      created: result.created,
      linkedExisting: result.linkedExisting,
      resolvedUnlabelled: result.resolvedUnlabelled,
      failed: result.failed,
      failureKinds: result.failures.map((failure) => failure.kind),
      skippedAlreadyDone: result.skipped.filter(
        (row) => row.reason === "ALREADY_DONE",
      ).length,
      skippedNoLongerPushable: result.skipped.filter(
        (row) => row.reason === "NO_LONGER_PUSHABLE",
      ).length,
      remaining: result.remaining,
      outstandingPushable: result.outstandingPushable,
      done: result.done,
      haltedByDailyLimit: result.haltedByDailyLimit,
      haltedByTimeBudget: result.haltedByTimeBudget,
    }),
  });

  return NextResponse.json({ result });
}
