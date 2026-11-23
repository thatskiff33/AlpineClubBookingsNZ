import { NextRequest, NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";
import { Prisma } from "@prisma/client";
import { isPrismaKnownUniqueConstraintError } from "@/lib/prisma-known-errors";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { validateTemplateForSave } from "@/lib/lodge-display/authoring-validation";
import { isBuiltInDisplayTemplateKey } from "@/lib/lodge-display/built-in-seeds";

// Admin lobby-display TEMPLATE management (fork issue hoppers99/AlpineClubBookingsNZ#79, LTV-033, ADR-003 §1).
// A Template is built on a Layout: it fills each declared slot with content or
// an embedded module, layers CSS overrides on the layout default, carries the
// footer, and renders dynamically against whichever lodge its display is bound
// to.
//
// This GET lists the v2 DisplayTemplate rows (bindable by `templateId`) for the
// devices picker and the templates authoring page. Since LTV-038 the three
// legacy code built-ins are seeded as ordinary v2 Template rows, so they appear
// here as normal templates — the picker no longer offers a separate built-ins
// group and the devices PATCH no longer accepts `templateKey`.
//
// POST creates a v2 Template. Every authored field is judged by the shared save
// contract (`validateTemplateForSave`) BEFORE it is persisted — a lobby wall is
// unattended, so a structurally-broken template must never reach the database
// (ADR-003 §5). The contract needs the BOUND LAYOUT (its areas gate which slot
// keys are valid), so the route loads it first. Structural ERRORS refuse the
// save (400); CSS-sanitiser WARNINGS ride along on an accepted save (201).

// Template keys are stable slugs (device bindings key off them), validated on
// create and immutable after (see [id]/route.ts PUT).
const keyField = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "key must be a lower-case slug (a-z, 0-9, -)");

// Authored HTML/CSS caps are generous — safety comes from the save contract and
// the serve-time sanitiser, not a length limit. slotContent/footer/css shapes
// are owned by the contract (validateTemplateForSave); keep them loose here so
// the contract's rich errors surface with the right path.
const bodyField = z.object({
  key: keyField,
  name: z.string().trim().min(1).max(120),
  layoutId: z.string().min(1),
  slotContent: z.record(z.string(), z.unknown()),
  cssOverrides: z.string().max(100_000),
  footerHtml: z.string().max(100_000),
});

// The seven built-in KEYS are ordinary slugs (`everyday-board`, `welcome-kiosk`,
// …) — only the seeded ROW ID carries the `builtin-` prefix. So on a database
// that was never seeded, nothing stopped an admin authoring their own template
// under one of those keys; "Restore built-in boards" (#2247) would then upsert
// BY KEY straight over their content, while its dialog promises that custom
// templates are untouched. Reserving the keys on create is what makes that
// promise true. The PUT path already 409s on a built-in (see [id]/route.ts).
function builtInKeyReserved(key: string): string {
  return (
    `"${key}" is reserved for a built-in board. Restoring the built-in ` +
    `boards overwrites whatever is saved under a reserved key, so a template ` +
    `of your own must use a different key.`
  );
}

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const rows = await prisma.displayTemplate.findMany({
    orderBy: [{ name: "asc" }],
    select: {
      id: true,
      key: true,
      name: true,
      updatedAt: true,
      layout: { select: { id: true, key: true, name: true } },
      _count: { select: { devices: true } },
    },
  });

  return NextResponse.json({
    templates: rows.map((row) => ({
      id: row.id,
      key: row.key,
      name: row.name,
      layout: row.layout,
      updatedAt: row.updatedAt.toISOString(),
      deviceCount: row._count.devices,
    })),
  });
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  let body: z.infer<typeof bodyField>;
  const jsonBody = await parseJsonRequestBody(req);
  if (!jsonBody.ok) return jsonBody.response;
  try {
    body = bodyField.parse(jsonBody.body);
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  // Reserved-key gate BEFORE anything is loaded or written (#2247).
  if (isBuiltInDisplayTemplateKey(body.key)) {
    return NextResponse.json(
      { error: builtInKeyReserved(body.key) },
      { status: 409 }
    );
  }

  // The save contract validates slotContent against the bound layout's areas, so
  // the layout must exist and be loaded first.
  const layout = await prisma.displayLayout.findUnique({
    where: { id: body.layoutId },
    select: { bodyHtml: true, areas: true },
  });
  if (!layout) {
    return NextResponse.json({ error: "Layout not found" }, { status: 404 });
  }

  // Structural gate BEFORE persistence — the contract refuses a template whose
  // slots reference an unknown key/module or whose footer embeds a bad module.
  const verdict = validateTemplateForSave({
    layout: { bodyHtml: layout.bodyHtml, areas: layout.areas },
    slotContent: body.slotContent,
    cssOverrides: body.cssOverrides,
    footerHtml: body.footerHtml,
  });
  if (!verdict.ok) {
    return NextResponse.json(
      { errors: verdict.errors, warnings: verdict.warnings },
      { status: 400 }
    );
  }

  try {
    const template = await prisma.displayTemplate.create({
      data: {
        key: body.key,
        name: body.name,
        layoutId: body.layoutId,
        slotContent: body.slotContent as Prisma.InputJsonValue,
        cssOverrides: body.cssOverrides,
        footerHtml: body.footerHtml,
      },
      select: { id: true, key: true, name: true },
    });

    logAudit({
      action: "DISPLAY_TEMPLATE_CREATED",
      category: "lodge",
      entityType: "DisplayTemplate",
      entityId: template.id,
      targetId: template.id,
      actorMemberId: guard.session.user.id,
      details: `Created lobby display template "${template.name}" (${template.key})`,
    });

    return NextResponse.json(
      { template, warnings: verdict.warnings },
      { status: 201 }
    );
  } catch (error) {
    if (isPrismaKnownUniqueConstraintError(error)) {
      return NextResponse.json(
        { error: `A template with key "${body.key}" already exists` },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: "Failed to create template" },
      { status: 500 }
    );
  }
}
