import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";

import { createAuditLog } from "@/lib/audit";
import { centralLinkStatus } from "@/lib/central-lodge-link";
import { SERVERNZ_PUSH_SECRET_KEY } from "@/lib/club-post-mirror";
import { getIntegrationCredentialValue } from "@/lib/integration-credentials";
import { otherLodgeChoiceLabel } from "@/lib/other-lodge-choice-label";
import { OWNED_CENTRAL_LODGE_ID_MAX, type OwnedCentralLodge } from "@/lib/other-lodges";
import { prisma } from "@/lib/prisma";
import { loadServerNzSettings, lockServerNzSettings } from "@/lib/servernz-settings";
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
 * lifecycle, settlement or capacity cohort and takes no advisory lock.
 * The Settings row precedes the immutable Lodge row; the audit commits with
 * that transition. The unique index stops one central
 * lodge being linked to two local ones, including under two concurrent saves.
 */

const paramsSchema = z.object({ id: z.string().min(1) });

const putSchema = z
  .object({
    // Null clears the link and stops free-bed publication (INV-INT-028).
    centralLodgeId: z.string().trim().min(1).max(OWNED_CENTRAL_LODGE_ID_MAX).nullable(),
  })
  .strict();

/**
 * Each owned lodge with the label its option shows (#69): two may share a
 * name, so such a pair also shows the location their local copies hold.
 */
async function labelOwnedLodges(owned: ReadonlyArray<OwnedCentralLodge>) {
  const rows = await prisma.otherLodge.findMany({
    where: { centralId: { in: owned.map((l) => l.id) } },
    select: { centralId: true, location: true },
  });
  const location = new Map(rows.map((r) => [r.centralId, r.location]));
  return owned.map((l) => ({
    ...l,
    label: otherLodgeChoiceLabel({ name: l.name, location: location.get(l.id) ?? null }, owned),
  }));
}

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
    ownedLodges: owned === null ? null : await labelOwnedLodges(owned),
    /**
     * The owned central lodge this lodge actually answers for through its
     * explicit link, decided by the endpoint's resolver; or null.
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

  // Before and after in one transaction, so the audit row describes a real
  // transition even when two administrators save at once.
  let before: { centralLodgeId: string | null } | { invalidOwned: true } | null = null;
  try {
    before = await prisma.$transaction(async (tx) => {
      // Settings -> immutable Lodge row, also used by the download's unlink.
      // No lifecycle/capacity advisory tier is needed (INV-LOCK-001/002).
      await lockServerNzSettings(tx);
      const { otherLodgesOwnedLodges: owned } = await loadServerNzSettings(tx);
      if (body.centralLodgeId !== null && !owned?.some((l) => l.id === body.centralLodgeId)) {
        return { invalidOwned: true } as const;
      }
      await tx.$executeRaw`SELECT 1 FROM "Lodge" WHERE "id" = ${parsedParams.data.id} FOR UPDATE`;
      const current = await tx.lodge.findUnique({
        where: { id: parsedParams.data.id },
        select: { centralLodgeId: true },
      });
      if (!current) return null;
      await tx.lodge.update({
        where: { id: parsedParams.data.id },
        data: { centralLodgeId: body.centralLodgeId },
      });

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
          before: { centralLodgeId: current.centralLodgeId },
          after: { centralLodgeId: body.centralLodgeId },
        },
      }, tx);
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

  if (before && "invalidOwned" in before) {
    return NextResponse.json({ error: "That is not a lodge the Alpine Central Server says this club owns. Download from the central server, then choose again." }, { status: 400 });
  }
  if (!before) {
    return NextResponse.json({ error: "Lodge not found" }, { status: 404 });
  }

  const settings = await readSettings(parsedParams.data.id);
  if (!settings) {
    return NextResponse.json({ error: "Lodge not found" }, { status: 404 });
  }
  return NextResponse.json(settings);
}
