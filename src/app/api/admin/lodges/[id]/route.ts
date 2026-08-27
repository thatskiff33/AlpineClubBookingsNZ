import { NextResponse } from "next/server";
import { z } from "zod";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  buildUniqueLodgeSlug,
  lodgeSelect,
  normalizeLodgeText,
  redactLodgeForAudit,
  serializeLodge,
} from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { revalidatePublicPageContent } from "@/lib/public-content-revalidation";
import { invalidatePublicClubIdentity } from "@/lib/public-layout-cache";
import { primeClubIdentitySync } from "@/lib/club-identity-settings";
import { acquireConfigImportLock } from "@/lib/config-transfer-lock";
import { acquireLodgeCapacityLock } from "@/lib/lodge-capacity-lock";
import { findLodgeDeactivationRefusal } from "@/lib/lodge-deactivation-guard";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";

const paramsSchema = z.object({
  id: z.string().min(1),
});

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    address: z.string().trim().max(300).nullable().optional(),
    doorCode: z.string().trim().max(80).nullable().optional(),
    travelNote: z.string().trim().max(2000).nullable().optional(),
    active: z.boolean().optional(),
    // Acknowledge the deactivation dependency pre-flight and proceed anyway.
    // Never written to the lodge row.
    force: z.boolean().optional(),
  })
  .strict();

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json({ error: "Invalid lodge id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const existing = await prisma.lodge.findUnique({
    where: { id: parsedParams.data.id },
    select: lodgeSelect,
  });
  if (!existing) {
    return NextResponse.json({ error: "Lodge not found" }, { status: 404 });
  }

  // #3123 / INV-LOCK-004 — the club's day, resolved ONCE here, before the
  // transaction below opens. Resolving it is a `clubTimeSettings.findUnique`,
  // which inside that transaction would take a second pooled connection while
  // the config-import singleton and the per-lodge capacity key are held. One
  // read also means the cheap ask and the locked re-check are judged against
  // the same day; two independent reads could straddle club midnight and
  // disagree.
  const clubToday = await clubTodayDateOnlyInstant();

  // The same predicate the locked re-read below runs, asked cheaply first so
  // the common refusals cost no lock. Only the locked answer is authoritative.
  const earlyRefusal = await findLodgeDeactivationRefusal(prisma, {
    lodgeId: existing.id,
    lodgeIsActive: existing.active,
    requestedActive: parsed.data.active,
    force: parsed.data.force,
    today: clubToday,
  });
  if (earlyRefusal) {
    return NextResponse.json(earlyRefusal.body, { status: earlyRefusal.status });
  }

  const data: {
    name?: string;
    slug?: string;
    address?: string | null;
    doorCode?: string | null;
    travelNote?: string | null;
    active?: boolean;
  } = {};

  const nameChanges = parsed.data.name !== undefined && parsed.data.name !== existing.name;
  if (nameChanges) {
    data.name = parsed.data.name!.trim();
  }
  if (parsed.data.address !== undefined) {
    data.address = normalizeLodgeText(parsed.data.address);
  }
  if (parsed.data.doorCode !== undefined) {
    data.doorCode = normalizeLodgeText(parsed.data.doorCode);
  }
  if (parsed.data.travelNote !== undefined) {
    data.travelNote = normalizeLodgeText(parsed.data.travelNote);
  }
  if (parsed.data.active !== undefined) {
    data.active = parsed.data.active;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ lodge: serializeLodge(existing) });
  }

  // NAME THIS `updated`, not `outcome`. The audit-writer census identifies
  // every write site by its enclosing symbol chain, so this variable's name is
  // part of `lodges/[id]/route.ts::PATCH.updated#0` — one of the fifteen
  // lodge-gated sites pinned as a reviewed KEEP (INV-PRIV-013). Renaming the
  // variable reads to that gate as the writer having MOVED, which demands a
  // readership decision and a backfill answer for a change that is neither.
  const updated = await prisma.$transaction(async (tx) => {
    // Lodge identity mutations share the config-import singleton first and
    // then the immutable per-lodge capacity key. Booking creation takes the
    // same capacity key before its active/access/room reads, so neither side
    // can validate against a state the other is about to invalidate.
    await acquireConfigImportLock(tx);
    await acquireLodgeCapacityLock(tx, parsedParams.data.id);

    const lockedExisting = await tx.lodge.findUnique({
      where: { id: parsedParams.data.id },
      select: lodgeSelect,
    });
    if (!lockedExisting) {
      return {
        kind: "error" as const,
        status: 404,
        body: { error: "Lodge not found" },
      };
    }

    // The authoritative ask: same predicate, now serialized behind the lodge
    // key and reading the row this transaction re-read, so a dependency
    // created since the early ask cannot slip past.
    const lockedRefusal = await findLodgeDeactivationRefusal(tx, {
      lodgeId: lockedExisting.id,
      lodgeIsActive: lockedExisting.active,
      requestedActive: parsed.data.active,
      force: parsed.data.force,
      // The SAME day the early ask used, resolved outside this transaction.
      today: clubToday,
    });
    if (lockedRefusal) {
      return {
        kind: "error" as const,
        status: lockedRefusal.status,
        body: lockedRefusal.body,
      };
    }

    const lockedNameChanges =
      parsed.data.name !== undefined &&
      parsed.data.name !== lockedExisting.name;
    if (lockedNameChanges) {
      data.slug = await buildUniqueLodgeSlug(
        tx,
        data.name!,
        lockedExisting.id,
      );
    }
    const lodge = await tx.lodge.update({
      where: { id: existing.id },
      data,
      select: lodgeSelect,
    });

    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action:
          data.active === undefined
            ? "LODGE_UPDATED"
            : data.active
              ? "LODGE_ACTIVATED"
              : "LODGE_DEACTIVATED",
        actor: { memberId: session.user.id },
        entity: { type: "Lodge", id: lodge.id },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary:
          data.active === undefined
            ? "Lodge updated"
            : data.active
              ? "Lodge activated"
              : "Lodge deactivated",
        metadata: {
          changedFields: Object.keys(data),
          previousLodge: redactLodgeForAudit(serializeLodge(lockedExisting)),
          newLodge: redactLodgeForAudit(serializeLodge(lodge)),
          forcedDeactivation:
            data.active === false && parsed.data.force === true,
        },
        request: getAuditRequestContext(request),
      }),
    );

    return { kind: "updated" as const, lodge };
  });

  if (updated.kind === "error") {
    return NextResponse.json(updated.body, { status: updated.status });
  }
  const updatedLodge = updated.lodge;

  revalidatePublicPageContent();
  // The default lodge's name feeds DB-first club identity (E3 #1929); refresh
  // both the tagged public cache and the sync accessor after a lodge write.
  invalidatePublicClubIdentity();
  await primeClubIdentitySync();

  return NextResponse.json({ lodge: serializeLodge(updatedLodge) });
}
