import { NextRequest, NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";
import { logAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { connectionJson } from "@/lib/mcp-connection-request";
import {
  INDUCTION_TEMPLATE_CONNECTION_SHAPE,
  INDUCTION_TEMPLATE_DETAIL_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/membership-committee";
import { CONFIG_OK_CONNECTION_SHAPE } from "@/lib/connection-shapes/membership-config";
import {
  inductionTemplateActivateSchema,
  inductionTemplateUpdateSchema,
} from "@/lib/admin-membership-api/config-structure";

const TEMPLATE_INCLUDE = {
  sections: {
    orderBy: { sortOrder: "asc" as const },
    include: { items: { orderBy: { sortOrder: "asc" as const } } },
  },
};

async function templateUsed(id: string): Promise<boolean> {
  const count = await prisma.memberInduction.count({ where: { templateId: id } });
  return count > 0;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "view" },
  });
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const template = await prisma.inductionChecklistTemplate.findUnique({
    where: { id },
    include: TEMPLATE_INCLUDE,
  });
  if (!template) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }

  const body = { template, used: await templateUsed(id) };
  return connectionJson(req, body, INDUCTION_TEMPLATE_DETAIL_CONNECTION_SHAPE);
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const parsedJson = await parseJsonRequestBody(req, { error: "Invalid JSON" });
  if (!parsedJson.ok) return parsedJson.response;
  const body = parsedJson.body;

  const parsed = inductionTemplateUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const existing = await prisma.inductionChecklistTemplate.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }

  if (await templateUsed(id)) {
    return NextResponse.json(
      {
        error:
          "This template has already been used for an induction and cannot be edited. Duplicate it as a new version instead.",
      },
      { status: 409 }
    );
  }

  const template = await prisma.$transaction(async (tx) => {
    await tx.inductionChecklistSection.deleteMany({ where: { templateId: id } });
    await tx.inductionChecklistTemplate.update({
      where: { id },
      data: {
        ...(parsed.data.name ? { name: parsed.data.name } : {}),
        ...(parsed.data.version ? { version: parsed.data.version } : {}),
        ...(parsed.data.kind ? { kind: parsed.data.kind } : {}),
        sections: {
          create: parsed.data.sections.map((section, sectionIndex) => ({
            title: section.title,
            description: section.description ?? null,
            priority: section.priority,
            sortOrder: sectionIndex,
            items: {
              create: section.items.map((item, itemIndex) => ({
                label: item.label,
                competencyPrompt: item.competencyPrompt ?? null,
                notesPrompt: item.notesPrompt ?? null,
                isMandatory: item.isMandatory ?? false,
                requiresDemonstration: item.requiresDemonstration ?? false,
                sortOrder: itemIndex,
              })),
            },
          })),
        },
      },
    });
    return tx.inductionChecklistTemplate.findUnique({
      where: { id },
      include: TEMPLATE_INCLUDE,
    });
  });

  logAudit({
    action: "INDUCTION_TEMPLATE_UPDATED",
    memberId: guard.session.user.id,
    targetId: id,
    entityType: "InductionChecklistTemplate",
    entityId: id,
    category: "admin",
    severity: "important",
  });

  return connectionJson(req, { template }, INDUCTION_TEMPLATE_CONNECTION_SHAPE);
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const jsonBody = await parseJsonRequestBody(req, { error: "Invalid JSON" });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = inductionTemplateActivateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const existing = await prisma.inductionChecklistTemplate.findUnique({
    where: { id },
    select: { id: true, kind: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }

  await prisma.$transaction([
    prisma.inductionChecklistTemplate.updateMany({
      where: { id: { not: id }, kind: existing.kind },
      data: { isActive: false },
    }),
    prisma.inductionChecklistTemplate.update({
      where: { id },
      data: { isActive: true },
    }),
  ]);

  logAudit({
    action: "INDUCTION_TEMPLATE_ACTIVATED",
    memberId: guard.session.user.id,
    targetId: id,
    entityType: "InductionChecklistTemplate",
    entityId: id,
    category: "admin",
    severity: "important",
  });

  return connectionJson(req, { ok: true }, CONFIG_OK_CONNECTION_SHAPE);
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const template = await prisma.inductionChecklistTemplate.findUnique({
    where: { id },
    select: { id: true, isActive: true },
  });
  if (!template) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }
  if (template.isActive) {
    return NextResponse.json(
      { error: "The active template cannot be deleted" },
      { status: 409 }
    );
  }
  if (await templateUsed(id)) {
    return NextResponse.json(
      { error: "A template used for inductions cannot be deleted" },
      { status: 409 }
    );
  }

  await prisma.inductionChecklistTemplate.delete({ where: { id } });

  logAudit({
    action: "INDUCTION_TEMPLATE_DELETED",
    memberId: guard.session.user.id,
    targetId: id,
    entityType: "InductionChecklistTemplate",
    entityId: id,
    category: "admin",
    severity: "important",
  });

  return connectionJson(req, { ok: true }, CONFIG_OK_CONNECTION_SHAPE);
}
