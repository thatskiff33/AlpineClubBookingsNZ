import { NextResponse } from "next/server";
import { z } from "zod";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import {
  buildUniqueLodgeSlug,
  lodgeIdentitySelect,
  lodgeOrderBy,
  lodgeSelect,
  normalizeLodgeText,
  redactLodgeForAudit,
  serializeLodge,
  serializeLodgeIdentity,
} from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { revalidatePublicPageContent } from "@/lib/public-content-revalidation";
import { invalidatePublicClubIdentity } from "@/lib/public-layout-cache";
import { primeClubIdentitySync } from "@/lib/club-identity-settings";
import { acquireConfigImportLock } from "@/lib/config-transfer-lock";

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    address: z.string().trim().max(300).nullable().optional(),
    doorCode: z.string().trim().max(80).nullable().optional(),
    travelNote: z.string().trim().max(2000).nullable().optional(),
    active: z.boolean().optional().default(true),
  })
  .strict();

/*
  ADMISSION: any admitted administrator (#2925, owner decision 17 Aug 2026).
  PAYLOAD: narrowed to the lodge vocabulary unless the caller holds `lodge:view`.

  The lodge list is the vocabulary every admin screen needs to say WHICH lodge
  it means. `ADMIN_MEMBERSHIP` and `FINANCE_ADMIN` hold no `lodge` entry at all
  (`admin-permissions.ts`), so a `lodge:view` gate here was a permanent 403 for
  them, and pages they legitimately hold — Promo Codes, Seasons, Hut Fees,
  Lockers — lost their content to it. The owner's decision was to relax THIS
  route alone, not to add `lodge:view` to those presets, which would widen
  eighteen other read endpoints on upgrade.

  `permission: "any-admin"` is what expresses this, and it is what the issue
  asked for in so many words. An earlier cut of this change used
  `permission: { area: "overview", level: "view" }` on the stated grounds that
  "every admin access-role grid carries `overview`". THAT IS FALSE, and review
  measured it against the shipped presets: `FINANCE_USER` ("Finance Viewer",
  `access-role-definitions.ts`) ships `overviewLevel: "NONE"` and
  `lodgeLevel: "NONE"`, so it was 403 under the old gate AND under the new one -
  while still being admitted to the finance area. The issue exists to stop
  shipped presets losing whole pages, so leaving one of them refused would have
  missed the point of it.

  THAT LAST REFUSAL IS NOW GONE, and not by a change here. #2925 recorded it as
  a question about `hasAdminPortalAccess` rather than about this endpoint and
  filed it; #2984 answered it, so a finance-only grid has portal standing and
  reaches this route like any other administrator. It gets the narrowed payload
  below, because it holds no `lodge:view` - which is the whole reason the
  relaxation was safe to make in the first place.

  It was also a REGRESSION for a second class, reachable through a custom grid
  rather than a preset: a role holding `lodge:view` without `overview:view`
  previously got the full list and would have started getting a 403.

  `"any-admin"` resolves to `hasAdminPortalAccess`, i.e. admitted to the admin
  portal at all - which is the honest statement of "any admin may read the lodge
  names". It is safe HERE because of the payload split below and only because of
  it: a caller without `lodge:view` receives id, name, slug and active, and
  nothing else.

  IT MUST BE EXPLICIT. The first attempt (PR #2885) wrote a bare
  `requireAdmin()` and was INERT: with no `permission`,
  `inferAdminAccessRequirement` reads the `x-pathname` / `x-request-method`
  headers `proxy.ts` stamps on this route and resolves them through
  `getAdminRouteRequirement`, which maps `/api/admin/lodges` to `area: "lodge"`
  — so the exact 403 the change existed to remove came straight back by
  inference. And if the header were ever missing, inference returns null and the
  guard falls back to the literal `ADMIN` role, which is NARROWER than before.
  There is no input under which the bare call means "any admitted admin".
  `admin-lodges-access-gate.test.ts` drives the real guard through the real
  inference path so that cannot silently return.

  The relaxation is only safe because the payload narrows with it. `lodgeSelect`
  carries `doorCode` — a physical-access secret this codebase already refuses to
  put in audit metadata — plus the street address and travel notes. Serving that
  to every admitted admin would hand two roles a door code they cannot read
  today, so a caller without `lodge:view` gets `lodgeIdentitySelect` instead.

  `POST` below keeps `lodge:edit`, and `PATCH` in `[id]/route.ts` is untouched:
  this changes who may READ the lodge names, and nothing about who may write.
*/
export async function GET() {
  const guard = await requireAdmin({ permission: "any-admin" });
  if (!guard.ok) return guard.response;

  /*
    Decided from the matrix `requireAdmin` just computed off the DB-joined
    member (definitions included) and returned on the session — the same source,
    at the same strength, that admitted this caller a line above. Re-deriving it
    from the raw JWT claim would be weaker; a second database read would be the
    same answer for another round trip.
  */
  const canReadLodgeDetail = hasAdminAreaAccess(guard.session.user, {
    area: "lodge",
    level: "view",
  });

  if (!canReadLodgeDetail) {
    const lodges = await prisma.lodge.findMany({
      orderBy: lodgeOrderBy(),
      select: lodgeIdentitySelect,
    });
    return NextResponse.json({ lodges: lodges.map(serializeLodgeIdentity) });
  }

  const lodges = await prisma.lodge.findMany({
    orderBy: lodgeOrderBy(),
    select: lodgeSelect,
  });

  return NextResponse.json({ lodges: lodges.map(serializeLodge) });
}

export async function POST(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const created = await prisma.$transaction(async (tx) => {
    await acquireConfigImportLock(tx);
    const slug = await buildUniqueLodgeSlug(tx, parsed.data.name);
    const lodge = await tx.lodge.create({
      data: {
        name: parsed.data.name.trim(),
        slug,
        active: parsed.data.active,
        address: normalizeLodgeText(parsed.data.address),
        doorCode: normalizeLodgeText(parsed.data.doorCode),
        travelNote: normalizeLodgeText(parsed.data.travelNote),
      },
      select: lodgeSelect,
    });

    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "LODGE_CREATED",
        actor: { memberId: session.user.id },
        entity: { type: "Lodge", id: lodge.id },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: "Lodge created",
        metadata: { newLodge: redactLodgeForAudit(serializeLodge(lodge)) },
        request: getAuditRequestContext(request),
      }),
    );

    return lodge;
  });

  revalidatePublicPageContent();
  // A new (possibly default) lodge can change DB-first club identity (E3 #1929).
  invalidatePublicClubIdentity();
  await primeClubIdentitySync();

  return NextResponse.json(
    { lodge: serializeLodge(created) },
    { status: 201 },
  );
}
