import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { parseJsonRequestBody } from "@/lib/api-json";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  buildUniqueSubscriptionCategoryKey,
  normalizeSubscriptionCategoryText,
  serializeSubscriptionCategory,
  subscriptionCategoryOrderBy,
  subscriptionCategorySelect,
} from "@/lib/subscription-categories";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { subscriptionCategoryCreateSchema } from "@/lib/admin-membership-api/config-structure";
import { connectionJson } from "@/lib/mcp-connection-request";
import {
  SUBSCRIPTION_CATEGORY_CONNECTION_SHAPE,
  SUBSCRIPTION_CATEGORY_LIST_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/membership-config";

/**
 * GET|POST /api/admin/subscription-categories. Also the AI app actions
 * `list_subscription_categories` and `create_subscription_category` (ALP-720).
 */

async function loadSubscriptionCategories() {
  const subscriptionCategories = await prisma.subscriptionCategory.findMany({
    orderBy: subscriptionCategoryOrderBy(),
    select: subscriptionCategorySelect,
  });

  return {
    subscriptionCategories: subscriptionCategories.map(serializeSubscriptionCategory),
  };
}

export async function GET(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "view" },
  });
  if (!guard.ok) {
    return guard.response;
  }

  return connectionJson(request, await loadSubscriptionCategories(), SUBSCRIPTION_CATEGORY_LIST_CONNECTION_SHAPE);
}

export async function POST(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) {
    return guard.response;
  }
  const session = guard.session;

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = subscriptionCategoryCreateSchema.safeParse(body);
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

  return connectionJson(
    request,
    { subscriptionCategory: serializeSubscriptionCategory(created) },
    SUBSCRIPTION_CATEGORY_CONNECTION_SHAPE,
    { status: 201 },
  );
}
