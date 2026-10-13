import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";

import { createAuditLog } from "@/lib/audit";
import { centralLinkStatus } from "@/lib/central-lodge-link";
import { SERVERNZ_PUSH_SECRET_KEY } from "@/lib/club-post-mirror";
import { getIntegrationCredentialValue } from "@/lib/integration-credentials";
import { OWNED_CENTRAL_LODGE_ID_MAX } from "@/lib/other-lodges";
import { prisma } from "@/lib/prisma";
import { loadServerNzSettings } from "@/lib/servernz-settings";
import { requireAdmin } from "@/lib/session-guards";

/**
 * GET|PUT /api/admin/lodges/[id]/central-lodge — which lodge in the Alpine
 * Central Server's registry THIS lodge is (#62, owner decision D5).
 *
 * The central server asks this site how many beds are free at one of the
 * lodges it says the club owns, naming it by its permanent central id. This
 * setting is how an administrator says which local lodge that is. By id, never
 * by name: a lodge can be renamed centrally, and the link must survive it.
 *
 * Its own route, like `roster-settings` beside it and for the same reason:
 * `PATCH /api/admin/lodges/[id]` edits lodge identity inside the config-import
 * and per-lodge capacity locks, which a link has no business taking. Under
 * `/api/admin/lodges/`, so the `lodge` permission area applies.
 *
 * A single-row update of one nullable unique column on `Lodge`: it joins no
 * lifecycle, settlement or capacity cohort, takes no advisory lock, and
 * INV-LOCK-001/002 are unaffected. The unique index is what stops one central
 * lodge being linked to two local ones, including under two concurrent saves.
 */

const paramsSchema = z.object({ id: z.string().min(1) });

const putSchema = z
  .object({
    // Null clears the link; the one-lodge default may then apply.
    centralLodgeId: z.string().trim().min(1).max(OWNED_CENTRAL_LODGE_ID_MAX).nullable(),
  })
  .strict();

async function readSettings(lodgeId: string) {
  const lodge = await prisma.lodge.findUnique({
    where: { id: lodgeId },
    select: { id: true, name: true, active: true, centralLodgeId: true },
  });
  if (!lodge) return null;
  const [settings, pushSecret] = await Promise.all([
    loadServerNzSettings(),
    getIntegrationCredentialValue("servernz", SERVERNZ_PUSH_SECRET_KEY),
  ]);
  const owned = settings.otherLodgesOwnedLodges;
  // The endpoint's own resolver decides, so this page and the endpoint agree.
  const status = await centralLinkStatus(lodge.id, owned);
  return {
    lodgeId: lodge.id,
    lodgeName: lodge.name,
    lodgeActive: lodge.active,
    centralLodgeId: lodge.centralLodgeId,
    /**
     * The central lodges this club owns, as the central server last said:
     * `null` until a download from a 2.2 server has recorded them.
     */
    ownedLodges: owned,
    /**
     * The owned central lodge this lodge actually answers for — by its link or
     * by the one-lodge default — decided by the endpoint's resolver; or null.
     */
    answersForCentralLodgeId: status.answersFor,
    /** The other local lodge holding the only owned central lodge's link, if any. */
    linkHeldBy: status.heldBy,
    /** Whether Other lodges sharing is on; the endpoint answers nothing while it is off. */
    otherLodgesEnabled: settings.otherLodgesEnabled,
    /**
     * Whether this site holds the push secret the central server signs its
     * questions with; without it every question is refused (401).
     */
    registeredWithCentralServer: Boolean(pushSecret),
  };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json({ error: "Invalid lodge id" }, { status: 400 });
  }

  const settings = await readSettings(parsedParams.data.id);
  if (!settings) {
    return NextResponse.json({ error: "Lodge not found" }, { status: 404 });
  }
  return NextResponse.json(settings);
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json({ error: "Invalid lodge id" }, { status: 400 });
  }

  let body: z.infer<typeof putSchema>;
  try {
    body = putSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  // Only a lodge the central server says this club owns may be linked:
  // anything else could never be asked about, and would hide a typo.
  if (body.centralLodgeId !== null) {
    const { otherLodgesOwnedLodges: owned } = await loadServerNzSettings();
    if (!owned?.some((l) => l.id === body.centralLodgeId)) {
      return NextResponse.json(
        {
          error:
            "That is not a lodge the Alpine Central Server says this club owns. Download from the central server, then choose again.",
        },
        { status: 400 },
      );
    }
  }

  // Before and after in one transaction, so the audit row describes a real
  // transition even when two administrators save at once.
  let before: { centralLodgeId: string | null } | null = null;
  try {
    before = await prisma.$transaction(async (tx) => {
      const current = await tx.lodge.findUnique({
        where: { id: parsedParams.data.id },
        select: { centralLodgeId: true },
      });
      if (!current) return null;
      await tx.lodge.update({
        where: { id: parsedParams.data.id },
        data: { centralLodgeId: body.centralLodgeId },
      });
      return current;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const holder = await prisma.lodge.findUnique({
        where: { centralLodgeId: body.centralLodgeId ?? "" },
        select: { name: true },
      });
      return NextResponse.json(
        {
          error: `That central lodge is already linked to ${holder?.name ?? "another lodge"}. Unlink it there first.`,
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: "Could not save" }, { status: 500 });
  }

  if (!before) {
    return NextResponse.json({ error: "Lodge not found" }, { status: 404 });
  }

  // Category `admin`, like every writer under `/api/admin/lodges/`
  // (INV-PRIV-013; see `LODGE_GATED_ADMIN_CATEGORIES_2765` in the audit census).
  await createAuditLog({
    action: "LODGE_CENTRAL_LINK_UPDATED",
    memberId: guard.session.user.id,
    actorMemberId: guard.session.user.id,
    entityType: "Lodge",
    entityId: parsedParams.data.id,
    category: "admin",
    severity: "important",
    outcome: "success",
    summary: "Central lodge link updated",
    metadata: {
      before: { centralLodgeId: before.centralLodgeId },
      after: { centralLodgeId: body.centralLodgeId },
    },
  });

  const settings = await readSettings(parsedParams.data.id);
  if (!settings) {
    return NextResponse.json({ error: "Lodge not found" }, { status: 404 });
  }
  return NextResponse.json(settings);
}
