import { NextRequest, NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { validateTemplateForSave } from "@/lib/lodge-display/authoring-validation";
import { isBuiltInDisplayTemplateKey } from "@/lib/lodge-display/built-in-seeds";

// Built-in boards are code-managed scaffolding, refreshed from code on every
// re-seed (built-in-seeds.ts). Duplicate-to-customise is the ADR-004 property; a
// PUT to a built-in row is therefore rejected server-side, not just hidden in the
// UI. Note the seed and config-transfer import paths write via prisma directly
// (not this route), so this guard does not affect them.
const BUILT_IN_READ_ONLY = "Built-in boards are read-only — duplicate to customise";

// Admin lobby-display TEMPLATE read / update / delete (fork issue hoppers99/AlpineClubBookingsNZ#79, LTV-033):
//  • GET    — the full authored row PLUS its layout's areas, so the editor can
//             build one slot box per declared slot seeded from the layout.
//  • PUT    — update the authored fields, re-validated by the save contract
//             against the bound layout; the key is IMMUTABLE after creation
//             (device bindings key off it) and the layout binding cannot change
//             (changing layouts would orphan slot content) — both are rejected.
//  • DELETE — a Template still bound to a device cannot go. The schema would
//             SetNull the device's templateId on row deletion, but the ADMIN
//             flow is explicit and protective (mirrors the layouts stance): we
//             pre-check deviceCount and 409 rather than silently unbinding live
//             walls.

const putSchema = z.object({
  // Present so a stale editor can round-trip them, but immutable: a value that
  // disagrees with the stored row is rejected below rather than silently kept.
  key: z.string().trim().max(80).optional(),
  layoutId: z.string().optional(),
  name: z.string().trim().min(1).max(120),
  slotContent: z.record(z.string(), z.unknown()),
  cssOverrides: z.string().max(100_000),
  footerHtml: z.string().max(100_000),
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
  const template = await prisma.displayTemplate.findUnique({
    where: { id },
    select: {
      id: true,
      key: true,
      name: true,
      slotContent: true,
      cssOverrides: true,
      footerHtml: true,
      createdAt: true,
      updatedAt: true,
      layout: {
        select: { id: true, key: true, name: true, bodyHtml: true, areas: true },
      },
      _count: { select: { devices: true } },
    },
  });
  if (!template) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }

  return NextResponse.json({
    template: {
      id: template.id,
      key: template.key,
      name: template.name,
      layout: template.layout,
      slotContent: template.slotContent,
      cssOverrides: template.cssOverrides,
      footerHtml: template.footerHtml,
      createdAt: template.createdAt.toISOString(),
      updatedAt: template.updatedAt.toISOString(),
      deviceCount: template._count.devices,
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

  const jsonBody = await parseJsonRequestBody(req);
  if (!jsonBody.ok) return jsonBody.response;
  const parsedBody = putSchema.safeParse(jsonBody.body);
  if (!parsedBody.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const body = parsedBody.data;

  const { id } = await params;
  const existing = await prisma.displayTemplate.findUnique({
    where: { id },
    select: {
      id: true,
      key: true,
      layoutId: true,
      layout: { select: { bodyHtml: true, areas: true } },
    },
  });
  if (!existing) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }

  // Built-in rows are read-only (duplicate-to-customise, ADR-004). Refuse before
  // any other check so the reason is unambiguous.
  if (isBuiltInDisplayTemplateKey(existing.key)) {
    return NextResponse.json({ error: BUILT_IN_READ_ONLY }, { status: 409 });
  }

  // Key is immutable once device bindings reference it.
  if (body.key !== undefined && body.key !== existing.key) {
    return NextResponse.json(
      { error: "Template key cannot be changed after creation" },
      { status: 400 }
    );
  }
  // Layout binding is immutable — changing it would orphan slot content that was
  // authored against the original layout's areas.
  if (body.layoutId !== undefined && body.layoutId !== existing.layoutId) {
    return NextResponse.json(
      { error: "Template layout cannot be changed after creation" },
      { status: 400 }
    );
  }

  const verdict = validateTemplateForSave({
    layout: {
      bodyHtml: existing.layout.bodyHtml,
      areas: existing.layout.areas,
    },
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

  const template = await prisma.displayTemplate.update({
    where: { id },
    data: {
      name: body.name,
      slotContent: body.slotContent as Prisma.InputJsonValue,
      cssOverrides: body.cssOverrides,
      footerHtml: body.footerHtml,
    },
    select: { id: true, key: true, name: true },
  });

  logAudit({
    action: "DISPLAY_TEMPLATE_UPDATED",
    category: "lodge",
    entityType: "DisplayTemplate",
    entityId: template.id,
    targetId: template.id,
    actorMemberId: guard.session.user.id,
    details: `Updated lobby display template "${template.name}" (${template.key})`,
  });

  return NextResponse.json({ template, warnings: verdict.warnings });
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
  const template = await prisma.displayTemplate.findUnique({
    where: { id },
    select: {
      id: true,
      key: true,
      name: true,
      _count: { select: { devices: true } },
    },
  });
  if (!template) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }

  // Protective stance (mirrors layouts): a bound device would be SetNull'd back
  // to the club default by the schema, but the admin flow refuses rather than
  // silently unbinding a live wall.
  if (template._count.devices > 0) {
    return NextResponse.json(
      {
        error:
          `This template is bound to ${template._count.devices} device` +
          `${template._count.devices === 1 ? "" : "s"} and cannot be deleted. ` +
          `Reassign those devices first.`,
      },
      { status: 409 }
    );
  }

  try {
    await prisma.displayTemplate.delete({ where: { id } });
  } catch (error) {
    // Fallback: a device was bound between the pre-check and the delete.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2003"
    ) {
      return NextResponse.json(
        { error: "This template is bound to a device and cannot be deleted." },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: "Failed to delete template" },
      { status: 500 }
    );
  }

  logAudit({
    action: "DISPLAY_TEMPLATE_DELETED",
    category: "lodge",
    entityType: "DisplayTemplate",
    entityId: template.id,
    targetId: template.id,
    actorMemberId: guard.session.user.id,
    details: `Deleted lobby display template "${template.name}" (${template.key})`,
  });

  return NextResponse.json({ ok: true });
}
