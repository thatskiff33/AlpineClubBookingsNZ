import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveEnvironmentRole } from "@/lib/environment-role";
import {
  stateFromResolution,
  stateFromWrittenRow,
} from "@/lib/environment-safety-admin-state";
import {
  isTransactionContentionError,
  writeEnvironmentSafetyOverride,
} from "@/lib/environment-safety-override-write";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";

/**
 * The environment-safety API (ENV-SAFETY 1, #3034; epic #2986). INV-CONFIG-003.
 *
 * FULL ADMIN ON BOTH VERBS, AND NOT BY AREA LEVEL. `requireAdmin({ permission:
 * false })` is the guard's "only a full administrator" shape (see
 * `RequireAdminOptions` in `src/lib/session-guards.ts`). The two other shapes are
 * both wrong here and both look right at a glance: an OMITTED `permission`
 * INFERS the requirement from the path, which for these prefixes is `support`,
 * so a support editor would be admitted; `"any-admin"` widens to every admitted
 * administrator. `/admin/environment` and `/api/admin/environment-safety` are
 * registered under `support` in `ROUTE_AREA_PREFIXES` only so the route-map drift
 * guard and the sidebar matrix resolve them to a concrete area instead of the
 * `overview` catch-all; that AREA decides who can reach the surface at all, and
 * the `permission: false` here is what enforces Full Admin.
 *
 * THE OVERRIDE CAN ONLY MAKE THIS INSTALLATION SAFER, and the API's shape says
 * so as plainly as the schema does. `PATCH` accepts one boolean,
 * `forceNonProduction`: no field could assert production and no field names a
 * role, so the request body cannot express "this is production" any more than the
 * table can. Production is declared by the DEPLOYMENT (`APP_ENVIRONMENT_ROLE`).
 * Turning the override OFF is equally privileged and equally audited, and it is
 * NOT an elevation — with it off the declaration decides, so a declared
 * non-production stays non-production and an undeclared installation goes back to
 * UNKNOWN.
 *
 * THE CONFIRMATION IS ENFORCED HERE, not only in the panel. A checkbox in a
 * browser is a courtesy to the operator, and the panel is not the only caller.
 *
 * THE WRITE ITSELF IS `environment-safety-override-write.ts`, which holds the
 * Serializable transaction, its dirty gate, its two-table contract and its audit
 * row. This file authorises and validates at the boundary and delegates the rest,
 * which is what `docs/ARCHITECTURE.md` → "Where code lives" asks of a route.
 */

export async function GET() {
  const guard = await requireAdmin({ permission: false });
  if (!guard.ok) return guard.response;

  const resolution = await resolveEnvironmentRole();
  return NextResponse.json({ state: await stateFromResolution(resolution) });
}

/**
 * `confirmed` is OPTIONAL in the schema and required by the check below, so an
 * absent flag and an explicit `false` get the same plain-English refusal rather
 * than one of them falling out as a generic "invalid body".
 *
 * `.strict()` is load-bearing: it is what makes an unknown key — `role`,
 * `forceProduction`, `isProduction` — a 400 rather than a silently ignored field
 * that a caller might believe had been honoured.
 */
const changeSchema = z
  .object({
    forceNonProduction: z.boolean(),
    confirmed: z.boolean().optional(),
  })
  .strict();

export async function PATCH(request: Request) {
  const guard = await requireAdmin({ permission: false });
  if (!guard.ok) return guard.response;
  const actingMemberId = guard.session.user.id;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = changeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  if (parsed.data.confirmed !== true) {
    return NextResponse.json(
      {
        error:
          "Changing how this installation is treated has to be confirmed before it is saved.",
      },
      { status: 400 },
    );
  }

  try {
    const outcome = await writeEnvironmentSafetyOverride({
      forceNonProduction: parsed.data.forceNonProduction,
      actingMemberId,
      request,
    });

    return NextResponse.json({
      changed: outcome.changed,
      state: await stateFromWrittenRow(outcome.resolution, outcome.row),
    });
  } catch (error) {
    /*
      The loser of a real race, told to try again rather than handed a 500 — and
      it wrote nothing, so retrying is safe. Anything else rethrows: this route
      cannot tell what a broken database means, and dressing that up as a
      friendly "try again shortly" would hide it from whoever has to fix it.
    */
    if (!isTransactionContentionError(error)) throw error;
    logger.warn(
      { err: error },
      "Environment safety override save hit write contention",
    );
    return NextResponse.json(
      { error: "Another update is in progress — try again shortly." },
      { status: 503 },
    );
  }
}
