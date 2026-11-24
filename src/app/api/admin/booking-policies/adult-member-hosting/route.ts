import type { AdultMemberHostingPolicy } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";

import { logAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { revalidatePublicPageContent } from "@/lib/public-content-revalidation";
import { requireAdmin } from "@/lib/session-guards";
import {
  adminPolicyLodgeQuerySchema,
  adultMemberHostingBodySchema,
} from "@/lib/admin-bookings-schemas/setup";
import {
  ADMIN_ADULT_MEMBER_HOSTING_CONNECTION_SHAPE,
  type AdultMemberHostingAnswer,
} from "@/lib/connection-shapes/bookings-setup";
import { connectionJson } from "@/lib/mcp-connection-request";
import {
  INACTIVE_ADULT_MEMBER_HOSTING_LODGE_MESSAGE,
  STALE_ADULT_MEMBER_HOSTING_POLICY_MESSAGE,
  lockAdultMemberHostingPolicySet,
} from "@/lib/adult-member-hosting-policy-set";
import {
  HOSTING_POLICY_RECONCILIATION_SELECT,
  enqueueActiveHostingIncidentPolicyReconciliation,
} from "@/lib/adult-member-hosting-policy-reconciliation";
import { settleHostingCoverageAfterCommit } from "@/lib/adult-member-hosting-coverage-drain";
import {
  describeAdultMemberHostingPolicy,
  hostScopeSetIsEmpty,
  resolveAdultMemberHostingPolicy,
  type AdultMemberHostScopeSet,
} from "@/lib/policies/adult-member-hosting";

/**
 * Adult-member hosting policy administration (#2364).
 *
 * One row per scope, so this is a keyed singleton rather than the minimum-stay
 * LIST: `?lodgeId=` selects the club-wide row or one lodge's override, and the
 * GET synthesises the built-in default when that scope has no row yet. The
 * synthesised body carries `configured: false` so the card can tell "the club
 * has not set this" from "the club set it to Disabled" — without that flag the
 * draft would equal the snapshot and the dirty gate would make the FIRST save
 * unreachable (#2142/#2143, exactly as on the group-discount card).
 */

const CLUB_SCOPE_KEY = "club-wide";

// The request schemas (and why the scope set is strict, nullable and its
// `sameGroupTrip` optional) live in admin-bookings-schemas/setup.ts so the AI
// app actions `get_adult_member_hosting_policy` and
// `update_adult_member_hosting_policy` offer the same fields (ALP-719).

function scopeKeyFor(lodgeId: string | null): string {
  return lodgeId ?? CLUB_SCOPE_KEY;
}

class StalePolicyError extends Error {}
class InactivePolicyLodgeError extends Error {}

export async function GET(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "view" },
  });
  if (!guard.ok) return guard.response;

  // A string or nothing always parses; the 400 is only a backstop.
  const query = adminPolicyLodgeQuerySchema.safeParse({
    lodgeId: request.nextUrl.searchParams.get("lodgeId") ?? undefined,
  });
  if (!query.success) {
    return NextResponse.json({ error: query.error.issues[0]?.message }, { status: 400 });
  }
  const lodgeId = query.data.lodgeId ?? null;
  // BOTH candidate rows, not just this scope's: #2569 §16 requires the card to
  // show whether each dimension is inherited or overridden and what the EFFECTIVE
  // answer is, and only the resolver can say that — computing it in the component
  // from one row would be a second implementation of the inheritance rule.
  const rows = await prisma.adultMemberHostingPolicy.findMany({
    where: { OR: [{ lodgeId }, { lodgeId: null }] },
  });
  const policy = rows.find((row) => row.scopeKey === scopeKeyFor(lodgeId)) ?? null;

  return connectionJson(request, {
    ...(policy
      ? { ...policy, hostScopes: storedHostScopes(policy), configured: true }
      : {
          scopeKey: scopeKeyFor(lodgeId),
          lodgeId: lodgeId ?? null,
          // An unconfigured LODGE inherits; an unconfigured CLUB has the
          // requirement off. Neither is a stored row, and `configured: false`
          // says so.
          mode: lodgeId ? "INHERIT" : "DISABLED",
          // Deliberately null rather than a plausible-looking mode: the admin has
          // to choose one before the first save, and pre-filling the field would
          // be the hidden default D-R6 rules out.
          capacityMode: null,
          // Nothing decided on this row, which is the inherit option.
          hostScopes: null,
          version: 0,
          configured: false,
        }),
    effective: effectiveView(rows, lodgeId),
  }, ADMIN_ADULT_MEMBER_HOSTING_CONNECTION_SHAPE);
}

/**
 * The stored scope set, or null where this row did not decide (#2569 §2).
 *
 * THE #2569 PAIR DECIDES; `hostScopeSameGroupTrip` IS READ, NOT TESTED (#3037).
 * It is legitimately NULL on a decided row — every row a draining previous colour
 * writes, and every row that predates the #3037 migration — and NULL there means
 * OFF, exactly as `rowHostScopes` reads it for the evaluator. Testing it would
 * make those rows report "this scope inherits", which is a different setting from
 * the one the admin saved.
 */
function storedHostScopes(policy: {
  hostScopeSameBooking: boolean | null;
  hostScopeSameBookingOwner: boolean | null;
  hostScopeSameGroupTrip: boolean | null;
}): AdultMemberHostScopeSet | null {
  if (
    policy.hostScopeSameBooking === null ||
    policy.hostScopeSameBookingOwner === null
  ) {
    return null;
  }
  return {
    sameBooking: policy.hostScopeSameBooking,
    sameBookingOwner: policy.hostScopeSameBookingOwner,
    sameGroupTrip: policy.hostScopeSameGroupTrip === true,
  };
}

/**
 * What is actually in force at this scope, and where each dimension came from
 * (#2569 §16), plus the plain-English preview.
 *
 * Computed by the SAME `resolveAdultMemberHostingPolicy` the booking gates use, so
 * the card cannot show an effective policy the evaluator disagrees with. For the
 * club-wide scope there is nothing above it, so `modeSource` can only be
 * CLUB_WIDE or the built-in default.
 */
function effectiveView(
  rows: Parameters<typeof resolveAdultMemberHostingPolicy>[0],
  lodgeId: string | null,
): AdultMemberHostingAnswer["effective"] {
  // The resolver is per LODGE. There is no lodge for the club-wide card, so it is
  // resolved against a sentinel that matches no row: the club row and the built-in
  // default are the only possible answers, which is exactly right for that scope.
  const resolved = resolveAdultMemberHostingPolicy(
    rows,
    lodgeId ?? "__club-wide__",
  );
  return {
    mode: resolved.mode,
    modeSource: resolved.policyId === null ? "BUILT_IN_DEFAULT" : resolved.resolvedScope.kind,
    hostScopes: resolved.hostScopes,
    hostScopeSource: resolved.hostScopeSource,
    preview: describeAdultMemberHostingPolicy(resolved.mode, resolved.hostScopes),
  };
}

export async function PUT(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const jsonBody = await parseJsonRequestBody(request);
  if (!jsonBody.ok) return jsonBody.response;
  const parsedBody = adultMemberHostingBodySchema.safeParse(jsonBody.body);
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsedBody.error.issues },
      { status: 400 },
    );
  }
  const data = parsedBody.data;

  const lodgeId = data.lodgeId ?? null;
  if (lodgeId === null && data.mode === "INHERIT") {
    // The database CHECK refuses this too; refusing here as well means the
    // admin reads a sentence instead of a constraint-violation 500.
    return NextResponse.json(
      {
        error:
          "The club-wide setting cannot inherit — there is nothing above it to inherit from. Choose Disabled or Admin review required.",
      },
      { status: 400 },
    );
  }

  const hostScopes = data.hostScopes ?? null;
  if (hostScopes) {
    // An explicitly CUSTOM set with nothing ticked has no defensible reading: it
    // says "these are this scope's own rules, and nobody counts", which is only
    // ever a description of Disabled. Left storable it would make every
    // non-member guest-night uncovered, so a Review policy would flag every
    // booking and an Enforced one would refuse every booking (#2569 §16: prevent
    // saving an active policy with no host scopes enabled). Refused whatever the
    // mode is, so the saved selections a Disabled policy keeps for later reuse
    // are always a set that would actually work when it is turned back on.
    if (
      hostScopeSetIsEmpty({
        ...hostScopes,
        // An unstated Group Trip decision cannot make an otherwise-empty set
        // non-empty, so it reads as off for this test exactly as it does
        // everywhere else NULL is reachable.
        sameGroupTrip: hostScopes.sameGroupTrip === true,
      })
    ) {
      return NextResponse.json(
        {
          error:
            "Choose at least one kind of adult member who counts, or set this scope to inherit the club's choice.",
        },
        { status: 400 },
      );
    }
  }

  /**
   * `null` when this row inherits, `undefined` when the body expressed no view,
   * otherwise the decision it carried.
   *
   * The inherit case is null rather than absent because the migration's CHECK
   * requires it: the Group Trip column may be set only on a row that decided the
   * rest of the set, so a switch to inherit has to clear all three together.
   */
  const groupTripDecision: boolean | null | undefined =
    hostScopes === null ? null : hostScopes.sameGroupTrip;

  const scopeColumns = {
    hostScopeSameBooking: hostScopes ? hostScopes.sameBooking : null,
    hostScopeSameBookingOwner: hostScopes ? hostScopes.sameBookingOwner : null,
    // OMITTED ENTIRELY when the writer expressed no view (#3037). Prisma then
    // leaves the stored value alone on an UPDATE and stores NULL on a CREATE,
    // which is the only reading that cannot clear another admin's opt-in.
    ...(groupTripDecision === undefined
      ? {}
      : { hostScopeSameGroupTrip: groupTripDecision }),
  };

  const scopeKey = scopeKeyFor(lodgeId);

  try {
    // Discriminated on purpose, exactly as `minimum-stay/[id]/route.ts` does.
    // Returning the row alone would make the unchanged branch indistinguishable
    // from a real write out here, and the audit entry and the ISR bust below
    // would still fire — which is the thing the guard inside exists to prevent.
    const result = await prisma.$transaction<
      | { kind: "unchanged"; policy: AdultMemberHostingPolicy }
      | {
          kind: "written";
          policy: AdultMemberHostingPolicy;
          coverageReevaluationsQueued: number;
        }
    >(async (tx) => {
      // Before the first read, so the row this write compare-and-swaps against
      // cannot move underneath it. The migration's statement trigger re-enters
      // the same key when the DML below fires.
      await lockAdultMemberHostingPolicySet(tx);

      if (lodgeId) {
        const lodge = await tx.lodge.findUnique({
          where: { id: lodgeId },
          select: { id: true, active: true },
        });
        if (!lodge || !lodge.active) throw new InactivePolicyLodgeError();
      }

      // Snapshot the complete tiny policy set under its advisory lock. A
      // club-wide edit can change mode inheritance for one lodge and host-scope
      // inheritance for another, so only a before/after effective comparison is
      // complete. The helper below queues accepted future bookings plus active
      // incident bookings only at lodges whose effective mode/scopes moved.
      const beforePolicies = await tx.adultMemberHostingPolicy.findMany({
        select: HOSTING_POLICY_RECONCILIATION_SELECT,
      });

      const existing = await tx.adultMemberHostingPolicy.findUnique({
        where: { scopeKey },
      });

      if (!existing) {
        // The editor carried a version, so it believed it was updating a row
        // that has since been deleted (a configuration import can do that).
        // Creating one anyway would resurrect a policy the club removed.
        if (data.version !== undefined) throw new StalePolicyError();
        const policy = await tx.adultMemberHostingPolicy.create({
          data: {
            scopeKey,
            lodgeId,
            mode: data.mode,
            capacityMode: data.capacityMode,
            ...scopeColumns,
            version: 1,
          },
        });
        return {
          kind: "written",
          policy,
          coverageReevaluationsQueued:
            await enqueueActiveHostingIncidentPolicyReconciliation(
              {
                beforePolicies,
              },
              tx,
            ),
        };
      }

      if (data.version !== existing.version) throw new StalePolicyError();

      if (
        existing.mode === data.mode &&
        existing.capacityMode === data.capacityMode &&
        // The second dimension is part of "material", or a scope-set-only edit
        // would be reported as saved while nothing was written — and the
        // revision trigger, which now compares these columns too, would keep the
        // old token and leave another admin's editor believing it was current.
        existing.hostScopeSameBooking === scopeColumns.hostScopeSameBooking &&
        existing.hostScopeSameBookingOwner ===
          scopeColumns.hostScopeSameBookingOwner &&
        // #3037. Written as a strict comparison of the raw columns, so turning
        // Group Trip cover on for a row stored with NULL here — the shape a
        // previous colour writes — is correctly material rather than "false ===
        // false, nothing changed". Every scope column belongs in this test, and
        // the database revision trigger compares the same set. A body that
        // expressed no view writes nothing here, so it cannot make an otherwise
        // no-op save material either.
        (groupTripDecision === undefined ||
          existing.hostScopeSameGroupTrip === groupTripDecision)
      ) {
        // Nothing material changed. Return the row untouched rather than write
        // it: the revision trigger would hold the token anyway, but a no-op
        // UPDATE would still log an audit entry asserting a change that never
        // happened and bust the public-page cache (#2143). `kind` is what
        // carries that out of the transaction — see the caller.
        return { kind: "unchanged", policy: existing };
      }

      const updated = await tx.adultMemberHostingPolicy.updateMany({
        where: { scopeKey, version: existing.version },
        data: {
          mode: data.mode,
          capacityMode: data.capacityMode,
          ...scopeColumns,
          version: existing.version + 1,
        },
      });
      if (updated.count !== 1) throw new StalePolicyError();

      const reloaded = await tx.adultMemberHostingPolicy.findUnique({
        where: { scopeKey },
      });
      if (!reloaded) throw new StalePolicyError();
      return {
        kind: "written",
        policy: reloaded,
        coverageReevaluationsQueued:
          await enqueueActiveHostingIncidentPolicyReconciliation(
            {
              beforePolicies,
            },
            tx,
          ),
      };
    });

    const policy = result.policy;

    // Before the audit entry and before the revalidation, deliberately. An
    // admin who opened the card and saved without changing anything wrote
    // nothing, so the log must not name them as having changed the rule — an
    // operator asking "who changed this, and when" has to be able to trust the
    // answer — and the public page's cache must not be purged for a write that
    // did not happen (#2143).
    if (result.kind === "unchanged") {
      return connectionJson(
        request,
        await savedPolicyBody(policy, lodgeId),
        ADMIN_ADULT_MEMBER_HOSTING_CONNECTION_SHAPE,
      );
    }

    logAudit({
      action: "adult-member-hosting-policy.update",
      category: "booking",
      memberId: session.user.id,
      targetId: policy.id,
      entityType: "AdultMemberHostingPolicy",
      entityId: policy.id,
      details: JSON.stringify({
        scopeKey,
        lodgeId,
        mode: policy.mode,
        capacityMode: policy.capacityMode,
        hostScopes: storedHostScopes(policy),
        version: policy.version,
      }),
    });

    // The durable obligation committed with the policy write above. Re-read and
    // reconcile only now: provider delivery must never run in the policy
    // transaction, and a failed inline drain leaves the rows for the cron.
    if (result.coverageReevaluationsQueued > 0) {
      await settleHostingCoverageAfterCommit({ limit: 5 });
    }

    revalidatePublicPageContent();
    return connectionJson(
      request,
      await savedPolicyBody(policy, lodgeId),
      ADMIN_ADULT_MEMBER_HOSTING_CONNECTION_SHAPE,
    );
  } catch (error) {
    if (error instanceof StalePolicyError) {
      return NextResponse.json(
        {
          error: STALE_ADULT_MEMBER_HOSTING_POLICY_MESSAGE,
          code: "POLICY_VERSION_CONFLICT",
        },
        { status: 409 },
      );
    }
    if (error instanceof InactivePolicyLodgeError) {
      return NextResponse.json(
        { error: INACTIVE_ADULT_MEMBER_HOSTING_LODGE_MESSAGE },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: "Failed to save the adult-member hosting policy" },
      { status: 500 },
    );
  }
}

/**
 * The body a save returns: the stored row, its scope set, and a FRESHLY RESOLVED
 * effective view.
 *
 * Re-read rather than derived from the row just written, because the effective
 * answer at a lodge depends on the club-wide row as well — a lodge saving
 * `Inherit` has to be told what it is now inheriting, and the component has no
 * other way to find out without a second request.
 */
async function savedPolicyBody(
  policy: AdultMemberHostingPolicy,
  lodgeId: string | null,
): Promise<AdultMemberHostingAnswer> {
  const rows = await prisma.adultMemberHostingPolicy.findMany({
    where: { OR: [{ lodgeId }, { lodgeId: null }] },
  });
  return {
    ...policy,
    hostScopes: storedHostScopes(policy),
    configured: true,
    effective: effectiveView(rows, lodgeId),
  };
}
