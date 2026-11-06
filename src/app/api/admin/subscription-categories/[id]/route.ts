import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  normalizeSubscriptionCategoryText,
  serializeSubscriptionCategory,
} from "@/lib/subscription-categories";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

const subscriptionCategorySelect = {
  id: true,
  key: true,
  name: true,
  description: true,
  isActive: true,
  isBuiltIn: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { assignments: true, fees: true } },
} satisfies Prisma.SubscriptionCategorySelect;

const paramsSchema = z.object({
  id: z.string().min(1),
});

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(100000).optional(),
  })
  .strict();

function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  return Object.keys(after).filter((key) => before[key] !== after[key]);
}

function auditActionForUpdate(
  before: { isActive: boolean },
  data: { isActive?: boolean },
) {
  if (data.isActive === false && before.isActive) {
    return {
      action: "SUBSCRIPTION_CATEGORY_ARCHIVED",
      summary: "Subscription category archived",
    };
  }
  if (data.isActive === true && !before.isActive) {
    return {
      action: "SUBSCRIPTION_CATEGORY_REACTIVATED",
      summary: "Subscription category reactivated",
    };
  }
  return {
    action: "SUBSCRIPTION_CATEGORY_UPDATED",
    summary: "Subscription category updated",
  };
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) {
    return guard.response;
  }
  const session = guard.session;

  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json(
      { error: "Invalid route parameters", details: parsedParams.error.flatten() },
      { status: 400 },
    );
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

  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json(
      { error: "At least one subscription category field is required" },
      { status: 400 },
    );
  }

  const existing = await prisma.subscriptionCategory.findUnique({
    where: { id: parsedParams.data.id },
    select: subscriptionCategorySelect,
  });
  if (!existing) {
    return NextResponse.json(
      { error: "Subscription category not found" },
      { status: 404 },
    );
  }

  // The built-in "Individual" sentinel's key/active state is routing-load-bearing
  // (see the schema comment on SubscriptionCategory) — name/description/sortOrder
  // may still be edited, but it can never be archived or renamed away from its
  // seeded identity's active state.
  if (existing.isBuiltIn && parsed.data.isActive === false) {
    return NextResponse.json(
      { error: "The built-in Individual category cannot be archived." },
      { status: 409 },
    );
  }

  const data: Prisma.SubscriptionCategoryUpdateInput = {};
  if (parsed.data.name !== undefined) {
    const name = parsed.data.name.trim();
    const duplicate = await prisma.subscriptionCategory.findFirst({
      where: {
        id: { not: existing.id },
        name: { equals: name, mode: "insensitive" },
      },
      select: { id: true, name: true },
    });
    if (duplicate) {
      return NextResponse.json(
        {
          error: `A subscription category named "${duplicate.name}" already exists.`,
        },
        { status: 409 },
      );
    }
    data.name = name;
  }
  if (parsed.data.description !== undefined) {
    data.description = normalizeSubscriptionCategoryText(parsed.data.description);
  }
  if (parsed.data.isActive !== undefined) {
    data.isActive = parsed.data.isActive;
  }
  if (parsed.data.sortOrder !== undefined) {
    data.sortOrder = parsed.data.sortOrder;
  }

  const auditAction = auditActionForUpdate(existing, parsed.data);
  const updated = await prisma.$transaction(async (tx) => {
    const subscriptionCategory = await tx.subscriptionCategory.update({
      where: { id: existing.id },
      data,
      select: subscriptionCategorySelect,
    });

    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: auditAction.action,
        actor: { memberId: session.user.id },
        entity: { type: "SubscriptionCategory", id: existing.id },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: auditAction.summary,
        metadata: {
          changedFields: changedFields(existing, data as Record<string, unknown>),
          previousSubscriptionCategory: serializeSubscriptionCategory(existing),
          newSubscriptionCategory: serializeSubscriptionCategory(subscriptionCategory),
        },
        request: getAuditRequestContext(request),
      }),
    );

    return subscriptionCategory;
  });
  revalidatePath("/", "layout");

  return NextResponse.json({
    subscriptionCategory: serializeSubscriptionCategory(updated),
  });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) {
    return guard.response;
  }
  const session = guard.session;

  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json(
      { error: "Invalid route parameters", details: parsedParams.error.flatten() },
      { status: 400 },
    );
  }

  const existing = await prisma.subscriptionCategory.findUnique({
    where: { id: parsedParams.data.id },
    select: subscriptionCategorySelect,
  });
  if (!existing) {
    return NextResponse.json(
      { error: "Subscription category not found" },
      { status: 404 },
    );
  }

  if (existing.isBuiltIn) {
    return NextResponse.json(
      { error: "The built-in Individual category cannot be deleted" },
      { status: 409 },
    );
  }

  if ((existing._count?.assignments ?? 0) > 0) {
    return NextResponse.json(
      {
        error:
          "Subscription categories with member assignments cannot be deleted. Re-assign those members' subscription category first, or archive it instead.",
      },
      { status: 409 },
    );
  }

  if ((existing._count?.fees ?? 0) > 0) {
    return NextResponse.json(
      { error: "Subscription categories with fee history cannot be deleted. Archive the category instead." },
      { status: 409 },
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.subscriptionCategory.delete({ where: { id: existing.id } });
    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "SUBSCRIPTION_CATEGORY_DELETED",
        actor: { memberId: session.user.id },
        entity: { type: "SubscriptionCategory", id: existing.id },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: "Subscription category deleted",
        metadata: {
          previousSubscriptionCategory: serializeSubscriptionCategory(existing),
        },
        request: getAuditRequestContext(request),
      }),
    );
  });
  revalidatePath("/", "layout");

  return NextResponse.json({ ok: true });
}
