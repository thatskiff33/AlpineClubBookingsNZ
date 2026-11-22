import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getAppBaseUrl } from "@/lib/app-url";
import { logAudit } from "@/lib/audit";
import { getClientIp } from "@/lib/rate-limit-http";
import logger from "@/lib/logger";
import {
  buildMaintenanceReportSignUrl,
  getLodgeMaintenanceTokenStatus,
  mintLodgeMaintenanceToken,
  setLodgeMaintenanceTokenActive,
} from "@/lib/maintenance-report-tokens";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { parseJsonRequestBody } from "@/lib/api-json";

/**
 * QR sign management (#2780). Lodge Operations `view`/`edit`.
 *
 * GET lists every active lodge with whether it has a sign, whether that sign is
 * switched on, and when it was created, rotated and last scanned. It NEVER returns
 * a token or a hash, because it cannot: the raw value does not exist anywhere after
 * the mint response, and the hash is not selected.
 *
 * POST mints or rotates, and its response is THE ONLY TIME the raw token is ever
 * transmitted. That is why the response also carries the finished sign URL — the
 * admin page shows it, offers Copy, and offers Print, all from that one response
 * held in component state. If the admin closes the page without printing, the
 * answer is to Rotate, and rotating is what an admin should do anyway when they
 * have lost track of a sign.
 *
 * PATCH pauses or resumes a lodge's sign WITHOUT minting. It is a pause, not a
 * revocation: the same token works again when it is switched back on. The admin
 * surface says so beside the control, because an operator who believes Pause kills
 * a leaked sign has been given the wrong tool.
 */

const postSchema = z.object({ lodgeId: z.string().trim().min(1).max(64) }).strict();
const patchSchema = z
  .object({ lodgeId: z.string().trim().min(1).max(64), active: z.boolean() })
  .strict();

export async function GET() {
  const admin = await requireAdmin({
    permission: { area: "lodge", level: "view" },
  });
  if (!admin.ok) return admin.response;

  const lodges = await prisma.lodge.findMany({
    where: { active: true },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    select: { id: true, name: true },
  });

  const signs = await Promise.all(
    lodges.map(async (lodge) => ({
      lodgeId: lodge.id,
      lodgeName: lodge.name,
      // `null` means "no sign has ever been created for this lodge". The admin UI
      // distinguishes that from "a sign exists but is switched off", because the
      // remedy is different.
      sign: await getLodgeMaintenanceTokenStatus(lodge.id),
    })),
  );

  return NextResponse.json({ signs });
}

export async function POST(request: NextRequest) {
  const admin = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!admin.ok) return admin.response;

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const lodge = await prisma.lodge.findFirst({
    where: { id: parsed.data.lodgeId, active: true },
    select: { id: true, name: true },
  });
  if (!lodge) {
    return NextResponse.json({ error: "Lodge not found" }, { status: 404 });
  }

  try {
    const minted = await mintLodgeMaintenanceToken(lodge.id, admin.session.user.id);

    logAudit({
      action: minted.rotated
        ? "maintenance.qr_token.rotated"
        : "maintenance.qr_token.created",
      category: "lodge",
      memberId: admin.session.user.id,
      entityType: "LodgeMaintenanceReportToken",
      entityId: lodge.id,
      // The token is NOT in the details, and must never be. What is recorded is
      // that a sign for this lodge was created or replaced, which is the auditable
      // fact; the secret itself is the thing the audit log must not hold.
      details: JSON.stringify({ lodgeId: lodge.id, rotated: minted.rotated }),
      ipAddress: getClientIp(request),
      severity: "important",
      outcome: "success",
    });

    return NextResponse.json(
      {
        lodgeId: lodge.id,
        lodgeName: lodge.name,
        rotated: minted.rotated,
        // Shown once. See the module docblock for why there is no "show it again".
        signUrl: buildMaintenanceReportSignUrl(
          getAppBaseUrl(request.nextUrl.origin),
          minted.token,
        ),
      },
      { headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } },
    );
  } catch (err) {
    logger.error({ err, lodgeId: lodge.id }, "Failed to mint maintenance QR token");
    return NextResponse.json({ error: "Failed to create the sign" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const admin = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!admin.ok) return admin.response;

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const changed = await setLodgeMaintenanceTokenActive(
    parsed.data.lodgeId,
    parsed.data.active,
  );
  if (!changed) {
    return NextResponse.json(
      { error: "That lodge does not have a sign yet." },
      { status: 404 },
    );
  }

  logAudit({
    action: parsed.data.active
      ? "maintenance.qr_token.resumed"
      : "maintenance.qr_token.paused",
    category: "lodge",
    memberId: admin.session.user.id,
    entityType: "LodgeMaintenanceReportToken",
    entityId: parsed.data.lodgeId,
    details: JSON.stringify({
      lodgeId: parsed.data.lodgeId,
      active: parsed.data.active,
    }),
    ipAddress: getClientIp(request),
    severity: "important",
    outcome: "success",
  });

  return NextResponse.json({ ok: true });
}
