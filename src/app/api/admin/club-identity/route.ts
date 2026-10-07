import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import { primeClubIdentitySync } from "@/lib/club-identity-settings";
import { isHttpUrl } from "@/lib/http-url";
import { prisma } from "@/lib/prisma";
import { invalidatePublicClubIdentity } from "@/lib/public-layout-cache";
import { requireAdmin } from "@/lib/session-guards";

// DB-first club identity admin API (E3 #1929; facebookUrl added C5 #1984).
// Cloned from the content-gated public-content-settings route: content:view to
// read, content:edit to write, audited, and it invalidates the tagged identity
// cache + primes the sync accessor on write. Every field is nullable — clearing
// one (empty string) restores the club.json / hard-default fallback for that
// field. facebookUrl additionally requires an http(s) URL shape when non-blank
// (the shared `isHttpUrl`, the same rule `publicUrl` is held to).

const settingsSchema = z
  .object({
    name: z.string().trim().max(200).nullable(),
    shortName: z.string().trim().max(200).nullable(),
    hutLeaderLabel: z.string().trim().max(200).nullable(),
    facebookUrl: z
      .string()
      .trim()
      .max(500)
      // Blank clears (restores the fallback); a value must be a valid http(s) URL.
      .refine((v) => v === "" || isHttpUrl(v), {
        message: "facebookUrl must be a valid http(s) URL",
      })
      .nullable(),
  })
  .strict();

type PersistedIdentity = {
  name: string | null;
  shortName: string | null;
  hutLeaderLabel: string | null;
  facebookUrl: string | null;
};

const defaults: PersistedIdentity = {
  name: null,
  shortName: null,
  hutLeaderLabel: null,
  facebookUrl: null,
};

const settingsSelect = {
  name: true,
  shortName: true,
  hutLeaderLabel: true,
  facebookUrl: true,
} as const;

function serialize(row: PersistedIdentity): PersistedIdentity {
  return {
    name: row.name,
    shortName: row.shortName,
    hutLeaderLabel: row.hutLeaderLabel,
    facebookUrl: row.facebookUrl,
  };
}

// Empty string clears the override (restores the fallback); a value is trimmed.
function emptyToNull(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "content", level: "view" },
  });
  if (!guard.ok) return guard.response;
  const settings = await prisma.clubIdentitySettings.findUnique({
    where: { id: "default" },
    select: settingsSelect,
  });
  return NextResponse.json({
    settings: settings ? serialize(settings) : defaults,
  });
}

export async function PUT(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "content", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = settingsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid settings" }, { status: 400 });
  }

  const data: PersistedIdentity = {
    name: emptyToNull(parsed.data.name),
    shortName: emptyToNull(parsed.data.shortName),
    hutLeaderLabel: emptyToNull(parsed.data.hutLeaderLabel),
    facebookUrl: emptyToNull(parsed.data.facebookUrl),
  };

  const settings = await prisma.$transaction(async (tx) => {
    const before = await tx.clubIdentitySettings.findUnique({
      where: { id: "default" },
      select: settingsSelect,
    });
    const saved = await tx.clubIdentitySettings.upsert({
      where: { id: "default" },
      update: { ...data, updatedByMemberId: guard.session.user.id },
      create: { id: "default", ...data, updatedByMemberId: guard.session.user.id },
      select: settingsSelect,
    });
    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "CLUB_IDENTITY_SETTINGS_UPDATED",
        actor: { memberId: guard.session.user.id },
        entity: { type: "ClubIdentitySettings", id: "default" },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: "Club identity settings updated",
        metadata: { before: before ? serialize(before) : defaults, after: data },
        request: getAuditRequestContext(request),
      }),
    );
    return saved;
  });

  revalidatePath("/", "layout");
  invalidatePublicClubIdentity();
  await primeClubIdentitySync();

  return NextResponse.json({ settings: serialize(settings) });
}
