import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { getDefaultLodgeId } from "@/lib/lodges";
import { createAuditLog } from "@/lib/audit";
import { DISPLAY_CONFIG_KEY_PATTERN } from "@/lib/lodge-display/display-token-catalogue";
import { DISPLAY_NAME_GRANULARITY_VALUES } from "@/lib/display-name-granularity-choices";

// Per-lodge display settings (fork issue #34): the {{config:<key>}} glob and
// the name-granularity override. Validation mirrors the serialiser's
// sanitiser exactly (issue #31 note): keys lower-case slugs <= 64 chars,
// string values <= 500 chars — violations are explicit 400s, never silently
// dropped at the edit surface (AC4).
//
// The key pattern is shared with the token assistant's catalogue (#2248) so the
// picker's free-text key validation can never drift from what this route
// accepts on save.

const CONFIG_KEY_PATTERN = DISPLAY_CONFIG_KEY_PATTERN;
const CONFIG_VALUE_MAX = 500;

const putSchema = z.object({
  lodgeId: z.string().min(1).optional(),
  displayConfig: z.record(z.string(), z.unknown()).optional(),
  // The four levels come from the shared choices module (#2942) rather than
  // being spelled again here: the member lodge roster validates the same enum
  // on its own route, and two hand-written copies is one place too many for a
  // list the schema already fixes (`INV-SSOT`).
  displayNameGranularity: z
    .enum(DISPLAY_NAME_GRANULARITY_VALUES)
    .nullable()
    .optional(),
  displayNotice: z
    .string()
    .max(2000, "The notice must be 2000 characters or fewer")
    .nullable()
    .optional(),
  // #126 / #37: per-lodge config for whether opted-in adult phone numbers may
  // appear on the PUBLIC lobby display. The serialiser also requires the
  // member's opt-in; this is the lodge (config) side of the two-sided gate.
  showGuestPhonesOnScreens: z.boolean().optional(),
});

async function resolveLodgeId(requested: string | null): Promise<string> {
  return requested ?? (await getDefaultLodgeId(prisma));
}

export async function GET(req: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const lodgeId = await resolveLodgeId(req.nextUrl.searchParams.get("lodgeId"));
  const lodge = await prisma.lodge.findUnique({
    where: { id: lodgeId },
    select: {
      id: true,
      name: true,
      displayConfig: true,
      displayNameGranularity: true,
      displayNotice: true,
      showGuestPhonesOnScreens: true,
    },
  });
  if (!lodge) {
    return NextResponse.json({ error: "Lodge not found" }, { status: 404 });
  }
  return NextResponse.json({
    lodgeId: lodge.id,
    lodgeName: lodge.name,
    displayConfig: lodge.displayConfig ?? {},
    displayNameGranularity: lodge.displayNameGranularity,
    displayNotice: lodge.displayNotice,
    showGuestPhonesOnScreens: lodge.showGuestPhonesOnScreens,
  });
}

export async function PUT(req: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  let body: z.infer<typeof putSchema>;
  try {
    body = putSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  if (body.displayConfig !== undefined) {
    for (const [key, value] of Object.entries(body.displayConfig)) {
      if (!CONFIG_KEY_PATTERN.test(key)) {
        return NextResponse.json(
          {
            error: `Config key "${key}" must be a lower-case slug (letters, digits, hyphens; max 64 characters)`,
          },
          { status: 400 }
        );
      }
      if (typeof value !== "string") {
        return NextResponse.json(
          { error: `Config value for "${key}" must be text` },
          { status: 400 }
        );
      }
      if (value.length > CONFIG_VALUE_MAX) {
        return NextResponse.json(
          {
            error: `Config value for "${key}" exceeds ${CONFIG_VALUE_MAX} characters`,
          },
          { status: 400 }
        );
      }
    }
  }

  const lodgeId = await resolveLodgeId(body.lodgeId ?? null);
  // Load the current display fields for before/after audit metadata (mirrors
  // the lodge-settings editor loading its previous settings before writing).
  const lodge = await prisma.lodge.findUnique({
    where: { id: lodgeId },
    select: {
      id: true,
      displayNameGranularity: true,
      showGuestPhonesOnScreens: true,
    },
  });
  if (!lodge) {
    return NextResponse.json({ error: "Lodge not found" }, { status: 404 });
  }

  await prisma.lodge.update({
    where: { id: lodgeId },
    data: {
      ...(body.displayConfig !== undefined
        ? { displayConfig: body.displayConfig as object }
        : {}),
      ...(body.displayNameGranularity !== undefined
        ? { displayNameGranularity: body.displayNameGranularity }
        : {}),
      ...(body.displayNotice !== undefined
        ? { displayNotice: body.displayNotice }
        : {}),
      ...(body.showGuestPhonesOnScreens !== undefined
        ? { showGuestPhonesOnScreens: body.showGuestPhonesOnScreens }
        : {}),
    },
  });

  // Audit the config write with the acting admin as actor. All four editable
  // fields sit in the config bundle's LODGE_FIELDS allowlist, so this is what
  // the bootstrap-import six-signal probe (signal 6) relies on to detect a
  // hand-configured lodge display.
  const changedFields = [
    ...(body.displayConfig !== undefined ? ["displayConfig"] : []),
    ...(body.displayNameGranularity !== undefined
      ? ["displayNameGranularity"]
      : []),
    ...(body.displayNotice !== undefined ? ["displayNotice"] : []),
    ...(body.showGuestPhonesOnScreens !== undefined
      ? ["showGuestPhonesOnScreens"]
      : []),
  ];
  // `lodge`, moved out of `admin` in #2730, and the rule it was moved on is worth
  // stating because other `entityType: "Lodge"` writers were deliberately NOT
  // moved with it. The test is not "does it name a Lodge" and not "is the route
  // gated `lodge:edit`" — `LODGE_CREATED`, `LODGE_UPDATED`, `LODGE_SETTINGS_UPDATED`
  // and `LODGE_INSTRUCTION_UPDATED` all pass both of those and all stay `admin`.
  // The test is whether the site SPLIT a subsystem: this was the one writer under
  // `/api/admin/display/**` still saying `admin` while its ten siblings said
  // `lodge`, so the display subsystem answered to two permission gates and a
  // kiosk correlation returned the layout change but not the config change that
  // caused it. The `LODGE_*` records-and-settings group is uniform at `admin`, so
  // moving it is a readership change of its own and is #2730's open question,
  // recorded per group in `docs/ai-diagnostics/audit-admin-category-review.md`.
  await createAuditLog({
    action: "LODGE_DISPLAY_CONFIG_UPDATED",
    memberId: guard.session.user.id,
    actorMemberId: guard.session.user.id,
    entityType: "Lodge",
    entityId: lodgeId,
    category: "lodge",
    severity: "important",
    outcome: "success",
    summary: "Lodge display configuration updated",
    metadata: {
      changedFields,
      before: {
        displayNameGranularity: lodge.displayNameGranularity,
        showGuestPhonesOnScreens: lodge.showGuestPhonesOnScreens,
      },
      after: {
        displayNameGranularity:
          body.displayNameGranularity !== undefined
            ? body.displayNameGranularity
            : lodge.displayNameGranularity,
        showGuestPhonesOnScreens:
          body.showGuestPhonesOnScreens !== undefined
            ? body.showGuestPhonesOnScreens
            : lodge.showGuestPhonesOnScreens,
      },
    },
  });

  return NextResponse.json({ ok: true });
}
