import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  buildUniqueSubscriptionCategoryKey,
  normalizeSubscriptionCategoryText,
  serializeSubscriptionCategory,
  subscriptionCategoryOrderBy,
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

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).nullable().optional(),
    isActive: z.boolean().optional().default(true),
    sortOrder: z.number().int().min(0).max(100000).optional(),
  })
  .strict();

async function loadSubscriptionCategories() {
  const subscriptionCategories = await prisma.subscriptionCategory.findMany({
    orderBy: subscriptionCategoryOrderBy(),
    select: subscriptionCategorySelect,
  });

  return {
    subscriptionCategories: subscriptionCategories.map(serializeSubscriptionCategory),
  };
}

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "view" },
  });
  if (!guard.ok) {
    return guard.response;
  }

  return NextResponse.json(await loadSubscriptionCategories());
}

export async function POST(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) {
    return guard.response;
  }
  const session = guard.session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Reject duplicate display names (case-insensitive exact match) before the
  // key builder silently suffixes a unique key for the same visible name —
  // mirrors membership-types' own create guard.
  const name = parsed.data.name.trim();
  const duplicate = await prisma.subscriptionCategory.findFirst({
    where: { name: { equals: name, mode: "insensitive" } },
    select: { id: true, name: true },
  });
  if (duplicate) {
    return NextResponse.json(
      { error: `A subscription category named "${duplicate.name}" already exists.` },
      { status: 409 },
    );
  }

  const key = await buildUniqueSubscriptionCategoryKey(prisma, name);
  const lastCategory = await prisma.subscriptionCategory.findFirst({
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  const sortOrder = parsed.data.sortOrder ?? (lastCategory?.sortOrder ?? -1) + 1;
  const data = {
    key,
    name,
    description: normalizeSubscriptionCategoryText(parsed.data.description),
    isActive: parsed.data.isActive,
    isBuiltIn: false,
    sortOrder,
  };

  const created = await prisma.$transaction(async (tx) => {
    const subscriptionCategory = await tx.subscriptionCategory.create({
      data,
      select: subscriptionCategorySelect,
    });

    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "SUBSCRIPTION_CATEGORY_CREATED",
        actor: { memberId: session.user.id },
        entity: { type: "SubscriptionCategory", id: subscriptionCategory.id },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: "Subscription category created",
        metadata: {
          newSubscriptionCategory: serializeSubscriptionCategory(subscriptionCategory),
        },
        request: getAuditRequestContext(request),
      }),
    );

    return subscriptionCategory;
  });
  revalidatePath("/", "layout");

  return NextResponse.json(
    {
      subscriptionCategory: serializeSubscriptionCategory(created),
    },
    { status: 201 },
  );
}
