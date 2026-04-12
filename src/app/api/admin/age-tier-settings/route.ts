import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import type { AgeTier } from "@prisma/client";
import { z } from "zod";
import { ageTierEnum } from "@/lib/age-tier-schema";
import { logAudit } from "@/lib/audit";
import {
  AGE_TIER_DEFAULTS,
  invalidateAgeTierCache,
  normalizeAgeTierSettings,
} from "@/lib/age-tier";

type AgeTierSettingInput = {
  tier: AgeTier;
  minAge: number;
  maxAge: number | null;
  label: string;
  sortOrder: number;
};

const putSchema = z.object({
  settings: z
    .array(
      z.object({
        tier: ageTierEnum,
        minAge: z.number().int().min(0),
        maxAge: z.number().int().min(0).nullable(),
        label: z.string().min(1).max(100),
        sortOrder: z.number().int().min(0),
      })
    )
    .min(1),
});

export async function GET() {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const settings = await prisma.ageTierSetting.findMany({
    orderBy: { sortOrder: "asc" },
    select: { tier: true, minAge: true, maxAge: true, label: true, sortOrder: true },
  });

  return NextResponse.json({ settings: normalizeAgeTierSettings(settings) });
}

export async function PUT(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const body = await request.json();
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const settings: AgeTierSettingInput[] = parsed.data.settings.map((setting) => ({
    ...setting,
    tier: setting.tier as AgeTier,
  }));
  const requiredTiers = new Set(AGE_TIER_DEFAULTS.map((setting) => setting.tier));
  const providedTiers = new Set(settings.map((setting) => setting.tier));

  if (
    settings.length !== requiredTiers.size ||
    providedTiers.size !== requiredTiers.size ||
    [...requiredTiers].some((tier) => !providedTiers.has(tier))
  ) {
    return NextResponse.json(
      {
        error: `Age tier settings must include each tier exactly once: ${[...requiredTiers].join(", ")}`,
      },
      { status: 400 }
    );
  }

  // Validate: tiers must be contiguous — no gaps or overlaps
  const sorted = [...settings].sort((a, b) => a.minAge - b.minAge);
  for (let i = 0; i < sorted.length - 1; i++) {
    const current = sorted[i];
    const next = sorted[i + 1];
    if (current.maxAge === null) {
      return NextResponse.json(
        { error: "Only the highest tier (ADULT) can have no upper age limit" },
        { status: 400 }
      );
    }
    if (current.maxAge + 1 !== next.minAge) {
      return NextResponse.json(
        {
          error: `Age boundaries must be contiguous: gap or overlap between maxAge ${current.maxAge} and minAge ${next.minAge}`,
        },
        { status: 400 }
      );
    }
  }

  // ADULT must have maxAge = null
  const adult = settings.find((s) => s.tier === "ADULT");
  if (adult && adult.maxAge !== null) {
    return NextResponse.json(
      { error: "ADULT tier must have no upper age limit (maxAge must be null)" },
      { status: 400 }
    );
  }

  // Persist each tier
  await Promise.all(
    settings.map((s) =>
      prisma.ageTierSetting.upsert({
        where: { tier: s.tier },
        update: { minAge: s.minAge, maxAge: s.maxAge, label: s.label, sortOrder: s.sortOrder },
        create: { tier: s.tier, minAge: s.minAge, maxAge: s.maxAge, label: s.label, sortOrder: s.sortOrder },
      })
    )
  );

  // Invalidate cache so next computeAgeTier reads fresh values
  invalidateAgeTierCache();

  await logAudit({
    action: "AGE_TIER_SETTINGS_UPDATED",
    memberId: session.user.id,
    details: JSON.stringify(settings),
  });

  const updated = await prisma.ageTierSetting.findMany({
    orderBy: { sortOrder: "asc" },
    select: { tier: true, minAge: true, maxAge: true, label: true, sortOrder: true },
  });

  return NextResponse.json({ settings: normalizeAgeTierSettings(updated) });
}
