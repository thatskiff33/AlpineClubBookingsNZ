import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonRequestBody } from "@/lib/api-json";
import { logAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

const TEMPLATE_INCLUDE = {
  sections: {
    orderBy: { sortOrder: "asc" as const },
    include: { items: { orderBy: { sortOrder: "asc" as const } } },
  },
};

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  version: z.string().trim().min(1).max(50),
  kind: z
    .enum(["NEW_MEMBER", "HUT_LEADER", "YOUTH_TO_FULL", "RE_INDUCTION"])
    .optional(),
  cloneFromId: z.string().min(1).optional(),
});

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const templates = await prisma.inductionChecklistTemplate.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { inductions: true, sections: true } },
    },
  });

  return NextResponse.json({
    templates: templates.map((template) => ({
      id: template.id,
      name: template.name,
      version: template.version,
      kind: template.kind,
      sourceLabel: template.sourceLabel,
      isActive: template.isActive,
      createdAt: template.createdAt,
      sectionCount: template._count.sections,
      inductionCount: template._count.inductions,
      used: template._count.inductions > 0,
    })),
  });
}

export async function POST(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  let sectionsCreate: object | undefined;
  let templateKind = parsed.data.kind ?? "NEW_MEMBER";
  if (parsed.data.cloneFromId) {
    const source = await prisma.inductionChecklistTemplate.findUnique({
      where: { id: parsed.data.cloneFromId },
      include: TEMPLATE_INCLUDE,
    });
    if (!source) {
      return NextResponse.json(
        { error: "Template to clone was not found" },
        { status: 404 }
      );
    }
    templateKind = parsed.data.kind ?? source.kind;
    sectionsCreate = {
      create: source.sections.map((section) => ({
        title: section.title,
        description: section.description,
        priority: section.priority,
        sortOrder: section.sortOrder,
        items: {
          create: section.items.map((item) => ({
            label: item.label,
            competencyPrompt: item.competencyPrompt,
            notesPrompt: item.notesPrompt,
            isMandatory: item.isMandatory,
            requiresDemonstration: item.requiresDemonstration,
            sortOrder: item.sortOrder,
            legacySourceText: item.legacySourceText,
          })),
        },
      })),
    };
  }

  const template = await prisma.inductionChecklistTemplate.create({
    data: {
      name: parsed.data.name,
      version: parsed.data.version,
      kind: templateKind,
      isActive: false,
      ...(sectionsCreate ? { sections: sectionsCreate } : {}),
    },
    include: TEMPLATE_INCLUDE,
  });

  logAudit({
    action: "INDUCTION_TEMPLATE_CREATED",
    memberId: guard.session.user.id,
    targetId: template.id,
    entityType: "InductionChecklistTemplate",
    entityId: template.id,
    category: "admin",
    severity: "important",
    details: JSON.stringify({
      name: template.name,
      version: template.version,
      kind: template.kind,
      clonedFrom: parsed.data.cloneFromId ?? null,
    }),
  });

  return NextResponse.json({ template }, { status: 201 });
}
