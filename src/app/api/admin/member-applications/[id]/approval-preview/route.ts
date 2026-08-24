import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { buildApprovalMappingPreview } from "@/lib/member-application-mapping";
import { personDecisionsSchema } from "@/lib/member-application-decisions";
import { isFullAdmin } from "@/lib/access-roles";
import { requireAdmin } from "@/lib/session-guards";
import { clubTimeZone } from "@/lib/club-time/server";
import { clubSeasonYear } from "@/lib/financial-year";
import logger from "@/lib/logger";

const paramsSchema = z.object({ id: z.string().min(1) });

const bodySchema = z
  .object({
    personDecisions: personDecisionsSchema.optional().nullable(),
  })
  .strict();

/**
 * POST /api/admin/member-applications/[id]/approval-preview
 *
 * E10 (#1936): compute the field-by-field diff of mapping the applicant and/or
 * each family member onto an existing member, and mint the HMAC preview token
 * the approval PUT must echo back. Read-only (no writes); guarded by the
 * explicit membership:edit permission (E1 pattern) because it is the second
 * check that gates a member-record overwrite.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json(
      { error: "Invalid route parameters", details: parsedParams.error.flatten() },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 422 },
    );
  }

  try {
    const result = await buildApprovalMappingPreview({
      applicationId: parsedParams.data.id,
      personDecisions: parsed.data.personDecisions ?? null,
      seasonYear: clubSeasonYear(await clubTimeZone()),
      // #1026 gate: DB-verified session roles (requireAdmin re-reads them), so
      // the privileged-email block can never be dodged with a stale JWT claim.
      actor: {
        id: guard.session.user.id,
        isFullAdmin: isFullAdmin({
          accessRoles: guard.session.user.accessRoles,
        }),
      },
    });
    return NextResponse.json(result.body, result.init);
  } catch (err) {
    logger.error(
      { err, applicationId: parsedParams.data.id },
      "Failed to build member application approval preview",
    );
    return NextResponse.json(
      { error: "Could not build the approval preview right now" },
      { status: 500 },
    );
  }
}
