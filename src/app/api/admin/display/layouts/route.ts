import { NextRequest, NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";
import { Prisma } from "@prisma/client";
import { isPrismaKnownUniqueConstraintError } from "@/lib/prisma-known-errors";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { validateLayoutForSave } from "@/lib/lodge-display/authoring-validation";
import { isBuiltInDisplayLayoutKey } from "@/lib/lodge-display/built-in-seeds";

// Admin lobby-display LAYOUT management (fork issue hoppers99/AlpineClubBookingsNZ#78, LTV-032, ADR-003 §1):
// list and create authored Layouts (an HTML body with `{{area:key}}`
// placeholders, a default CSS block, and the area/slot descriptors). Every
// authored field is judged by the shared save contract
// (`validateLayoutForSave`) BEFORE it is persisted — a lobby wall is unattended,
// so a structurally-broken layout must never reach the database (ADR-003 §5).
// The contract splits its findings: structural ERRORS refuse the save (400);
// CSS-sanitiser WARNINGS ride along on an accepted save so the author sees what
// serve-time will neutralise. A Layout still referenced by a Template cannot be
// deleted (schema Restrict) — the list exposes `templateCount` so the UI can
// warn first.

// Layout keys are stable slugs: template bindings and seeds key off them, so
// they are validated on create and immutable after (see [id]/route.ts PUT).
const keyField = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "key must be a lower-case slug (a-z, 0-9, -)");

// Authored HTML/CSS caps are generous — safety comes from the save contract and
// the serve-time sanitiser, not from a length limit. defaultCss is allowed past
// MAX_AUTHORED_CSS_CHARS so the contract's over-length truncation warning can
// surface rather than being pre-rejected here.
const bodyField = z.object({
  key: keyField,
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).nullish(),
  bodyHtml: z.string().max(100_000),
  defaultCss: z.string().max(100_000),
  // areas structure is owned by the contract (validateDisplayLayoutDefinition);
  // keep it loose here so its rich errors surface with a `layout` path.
  areas: z.array(z.unknown()),
});

// The seven built-in KEYS are ordinary slugs (`everyday-board`, `welcome-kiosk`,
// …) — only the seeded ROW ID carries the `builtin-` prefix. So on a database
// that was never seeded, nothing stopped an admin authoring their own layout
// under one of those keys; "Restore built-in boards" (#2247) would then upsert
// BY KEY straight over their content, while its dialog promises that custom
// layouts are untouched. Reserving the keys on create is what makes that
// promise true. The PUT path already 409s on a built-in (see [id]/route.ts).
function builtInKeyReserved(key: string): string {
  return (
    `"${key}" is reserved for a built-in board. Restoring the built-in ` +
    `boards overwrites whatever is saved under a reserved key, so a layout ` +
    `of your own must use a different key.`
  );
}

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const layouts = await prisma.displayLayout.findMany({
    orderBy: [{ name: "asc" }],
    select: {
      id: true,
      key: true,
      name: true,
      description: true,
      updatedAt: true,
      _count: { select: { templates: true } },
    },
  });

  return NextResponse.json({
    layouts: layouts.map((layout) => ({
      id: layout.id,
      key: layout.key,
      name: layout.name,
      description: layout.description,
      updatedAt: layout.updatedAt.toISOString(),
      templateCount: layout._count.templates,
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

  // Reserved-key gate BEFORE anything is validated or written (#2247).
  if (isBuiltInDisplayLayoutKey(body.key)) {
    return NextResponse.json(
      { error: builtInKeyReserved(body.key) },
      { status: 409 }
    );
  }

  // Structural gate BEFORE persistence — the contract refuses a layout whose
  // body/areas disagree or whose default slot embeds an unknown module.
  const verdict = validateLayoutForSave({
    bodyHtml: body.bodyHtml,
    defaultCss: body.defaultCss,
    areas: body.areas,
  });
  if (!verdict.ok) {
    return NextResponse.json(
      { errors: verdict.errors, warnings: verdict.warnings },
      { status: 400 }
    );
  }

  try {
    const layout = await prisma.displayLayout.create({
      data: {
        key: body.key,
        name: body.name,
        description: body.description ?? null,
        bodyHtml: body.bodyHtml,
        defaultCss: body.defaultCss,
        areas: body.areas as Prisma.InputJsonValue,
      },
      select: { id: true, key: true, name: true },
    });

    logAudit({
      action: "DISPLAY_LAYOUT_CREATED",
      category: "lodge",
      entityType: "DisplayLayout",
      entityId: layout.id,
      targetId: layout.id,
      actorMemberId: guard.session.user.id,
      details: `Created lobby display layout "${layout.name}" (${layout.key})`,
    });

    return NextResponse.json(
      { layout, warnings: verdict.warnings },
      { status: 201 }
    );
  } catch (error) {
    if (isPrismaKnownUniqueConstraintError(error)) {
      return NextResponse.json(
        { error: `A layout with key "${body.key}" already exists` },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: "Failed to create layout" },
      { status: 500 }
    );
  }
}
