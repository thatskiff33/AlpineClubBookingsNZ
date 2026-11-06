import { NextResponse } from "next/server";
import { z } from "zod";

import { createAuditLog } from "@/lib/audit";
import { centralLinkStatus, labelOwnedLodges, saveCentralLodgeLinks } from "@/lib/central-lodge-link";
import { getIntegrationCredentialValue } from "@/lib/integration-credentials";
import { syncOwnOtherLodgesFromFees } from "@/lib/other-lodge-fees-sync";
import { OWNED_CENTRAL_LODGE_ID_MAX } from "@/lib/other-lodges";
import { prisma } from "@/lib/prisma";
import { SERVERNZ_CREDENTIAL_KEYS, SERVERNZ_PROVIDER } from "@/lib/servernz-config";
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
 *
 * The save itself is `saveCentralLodgeLinks` (`@/lib/central-lodge-link`),
 * shared with the setup page's link step: one serialised transaction that
 * locks the settings row then this `Lodge` row, re-checks ownership, writes
 * the link and its `LODGE_CENTRAL_LINK_UPDATED` audit row. A save refused for
 * ownership (400) writes nothing; one refused by the unique index (409) rolls
 * back; neither leaves an audit row. See docs/CONCURRENCY_AND_LOCKING.md ->
 * "Central lodge link writer".
 */

const paramsSchema = z.object({ id: z.string().min(1) });

const putSchema = z
  .object({
    // Null clears the link, and the lodge then answers nothing (#4262: every
    // club links explicitly; there is no one-lodge default).
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
    getIntegrationCredentialValue(SERVERNZ_PROVIDER, SERVERNZ_CREDENTIAL_KEYS.pushSecret),
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
     * The owned central lodge this lodge actually answers for — by its saved
     * link — decided by the endpoint's resolver; or null.
     */
    answersForCentralLodgeId: status.answersFor,
    /** The other local lodge holding the only owned central lodge's link, if any. */
    linkHeldBy: status.heldBy,
    /**
     * The central lodge the card preselects on Edit for a one-lodge club that
     * owns one central lodge (#4262): a suggestion, answered for only once saved.
     */
    suggestedCentralLodgeId: status.suggested,
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

  // Lock, check, read, write and audit in ONE transaction (see the header),
  // so the audit row describes the transition that actually happened even when
  // two administrators save at once.
  const lodgeId = parsedParams.data.id;
  let saved;
  try {
    const actorId = guard.session.user.id;
    saved = await saveCentralLodgeLinks(
      [{ lodgeId, centralLodgeId: body.centralLodgeId }],
      (entry, tx) =>
        // Category `admin`, like every writer under `/api/admin/lodges/`
        // (INV-PRIV-013; see `LODGE_GATED_ADMIN_CATEGORIES_2765` in the audit census).
        createAuditLog(
          {
            action: "LODGE_CENTRAL_LINK_UPDATED",
            memberId: actorId,
            actorMemberId: actorId,
            entityType: "Lodge",
            entityId: entry.lodgeId,
            category: "admin",
            severity: "important",
            outcome: "success",
            summary: "Central lodge link updated",
            metadata: { before: entry.before, after: entry.after },
          },
          tx,
        ),
    );
  } catch {
    return NextResponse.json({ error: "Could not save" }, { status: 500 });
  }
  // Every refusal named (#4720 review): a new one fails to compile here.
  // `duplicate` and `stale` need two rows or an expected link, which this
  // one-row save without `expectCurrent` never sends.
  if (!saved.ok) {
    switch (saved.reason) {
      case "already-linked":
        return NextResponse.json(
          {
            error: `That central lodge is already linked to ${saved.holderName ?? "another lodge"}. Unlink it there first.`,
          },
          { status: 409 },
        );
      case "lodge-not-found":
        return NextResponse.json({ error: "Lodge not found" }, { status: 404 });
      case "not-owned":
        return NextResponse.json(
          {
            error:
              "That is not a lodge the Alpine Central Server says this club owns. Download from the central server, then choose again.",
          },
          { status: 400 },
        );
      case "duplicate":
      case "stale":
        return NextResponse.json(
          { error: "That link was changed while this was open. Reload the page, then choose again." },
          { status: 409 },
        );
      default: {
        const unhandled: never = saved;
        return unhandled;
      }
    }
  }

  // The Fees page fills the own lodge's rates only once it is linked, as the
  // setup page's link step does after its save.
  await syncOwnOtherLodgesFromFees("central lodge linked", guard.session.user.id);

  const settings = await readSettings(lodgeId);
  if (!settings) {
    return NextResponse.json({ error: "Lodge not found" }, { status: 404 });
  }
  return NextResponse.json(settings);
}
