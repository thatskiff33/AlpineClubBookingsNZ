import { NextRequest, NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { validateLayoutForSave } from "@/lib/lodge-display/authoring-validation";
import { isBuiltInDisplayLayoutKey } from "@/lib/lodge-display/built-in-seeds";

// Built-in boards are code-managed scaffolding, refreshed from code on every
// re-seed (built-in-seeds.ts). Duplicate-to-customise is the ADR-004 property; a
// PUT to a built-in row is therefore rejected server-side, not just hidden in the
// UI. Note the seed and config-transfer import paths write via prisma directly
// (not this route), so this guard does not affect them.
const BUILT_IN_READ_ONLY = "Built-in boards are read-only — duplicate to customise";

// Admin lobby-display LAYOUT read / update / delete (fork issue hoppers99/AlpineClubBookingsNZ#78, LTV-032):
//  • GET    — the full authored row (feeds the editor).
//  • PUT    — update every authored field, re-validated by the save contract;
//             the key is IMMUTABLE after creation (template bindings and seeds
//             key off it) so a key change is rejected with 400.
//  • DELETE — a Layout still referenced by a Template cannot go (schema
//             Restrict). We pre-check templateCount and 409 with a clear
//             message, and still translate the FK violation as a fallback.

const putSchema = z.object({
  // Present so a stale editor can round-trip it, but immutable: a value that
  // disagrees with the stored key is rejected below rather than silently kept.
  key: z.string().trim().max(80).optional(),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).nullish(),
  bodyHtml: z.string().max(100_000),
  defaultCss: z.string().max(100_000),
  areas: z.array(z.unknown()),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const layout = await prisma.displayLayout.findUnique({
    where: { id },
    select: {
      id: true,
      key: true,
      name: true,
      description: true,
      bodyHtml: true,
      defaultCss: true,
      areas: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { templates: true } },
    },
  });
  if (!layout) {
    return NextResponse.json({ error: "Layout not found" }, { status: 404 });
  }

  return NextResponse.json({
    layout: {
      id: layout.id,
      key: layout.key,
      name: layout.name,
      description: layout.description,
      bodyHtml: layout.bodyHtml,
      defaultCss: layout.defaultCss,
      areas: layout.areas,
      createdAt: layout.createdAt.toISOString(),
      updatedAt: layout.updatedAt.toISOString(),
      templateCount: layout._count.templates,
    },
  });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  let body: z.infer<typeof putSchema>;
  const jsonBody = await parseJsonRequestBody(req);
  if (!jsonBody.ok) return jsonBody.response;
  try {
    body = putSchema.parse(jsonBody.body);
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const { id } = await params;
  const existing = await prisma.displayLayout.findUnique({
    where: { id },
    select: { id: true, key: true, name: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "Layout not found" }, { status: 404 });
  }

  // Built-in rows are read-only (duplicate-to-customise, ADR-004). Refuse before
  // any other check so the reason is unambiguous.
  if (isBuiltInDisplayLayoutKey(existing.key)) {
    return NextResponse.json({ error: BUILT_IN_READ_ONLY }, { status: 409 });
  }

  // Key is immutable once bindings/seeds reference it.
  if (body.key !== undefined && body.key !== existing.key) {
    return NextResponse.json(
      { error: "Layout key cannot be changed after creation" },
      { status: 400 }
    );
  }

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

  const layout = await prisma.displayLayout.update({
    where: { id },
    data: {
      name: body.name,
      description: body.description ?? null,
      bodyHtml: body.bodyHtml,
      defaultCss: body.defaultCss,
      areas: body.areas as Prisma.InputJsonValue,
    },
    select: { id: true, key: true, name: true },
  });

  logAudit({
    action: "DISPLAY_LAYOUT_UPDATED",
    category: "lodge",
    entityType: "DisplayLayout",
    entityId: layout.id,
    targetId: layout.id,
    actorMemberId: guard.session.user.id,
    details: `Updated lobby display layout "${layout.name}" (${layout.key})`,
  });

  return NextResponse.json({ layout, warnings: verdict.warnings });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const layout = await prisma.displayLayout.findUnique({
    where: { id },
    select: {
      id: true,
      key: true,
      name: true,
      _count: { select: { templates: true } },
    },
  });
  if (!layout) {
    return NextResponse.json({ error: "Layout not found" }, { status: 404 });
  }

  // Pre-check the Restrict FK so the author gets a clear reason rather than a
  // raw constraint error.
  if (layout._count.templates > 0) {
    return NextResponse.json(
      {
        error:
          `This layout is used by ${layout._count.templates} template` +
          `${layout._count.templates === 1 ? "" : "s"} and cannot be deleted. ` +
          `Reassign or delete those templates first.`,
      },
      { status: 409 }
    );
  }

  try {
    await prisma.displayLayout.delete({ where: { id } });
  } catch (error) {
    // Fallback: a template was bound between the pre-check and the delete.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2003"
    ) {
      return NextResponse.json(
        { error: "This layout is used by a template and cannot be deleted." },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: "Failed to delete layout" },
      { status: 500 }
    );
  }

  logAudit({
    action: "DISPLAY_LAYOUT_DELETED",
    category: "lodge",
    entityType: "DisplayLayout",
    entityId: layout.id,
    targetId: layout.id,
    actorMemberId: guard.session.user.id,
    details: `Deleted lobby display layout "${layout.name}" (${layout.key})`,
  });

  return NextResponse.json({ ok: true });
}
