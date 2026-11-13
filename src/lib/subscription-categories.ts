import type { Prisma } from "@prisma/client";

import { buildUniqueCatalogueKey, normalizeCatalogueText } from "@/lib/catalogue-key";

/** The one row shape both admin category routes read and serialise. */
export const subscriptionCategorySelect = {
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

/** The fields a PATCH actually changed, for the audit row. */
export function subscriptionCategoryChangedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  return Object.keys(after).filter((key) => before[key] !== after[key]);
}

/** Which audit action a PATCH records: archive, reactivate or plain update. */
export function subscriptionCategoryAuditActionForUpdate(
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

type SubscriptionCategoryWithCounts = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isActive: boolean;
  isBuiltIn: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  _count?: { assignments?: number; fees?: number };
};

export function serializeSubscriptionCategory(category: SubscriptionCategoryWithCounts) {
  return {
    id: category.id,
    key: category.key,
    name: category.name,
    description: category.description,
    isActive: category.isActive,
    isBuiltIn: category.isBuiltIn,
    sortOrder: category.sortOrder,
    createdAt: category.createdAt.toISOString(),
    updatedAt: category.updatedAt.toISOString(),
    assignmentCount: category._count?.assignments ?? 0,
    feeCount: category._count?.fees ?? 0,
  };
}

export function normalizeSubscriptionCategoryText(
  value: string | null | undefined,
): string | null {
  return normalizeCatalogueText(value);
}

// One key rule for every admin catalogue (src/lib/catalogue-key.ts).
export async function buildUniqueSubscriptionCategoryKey(
  db: {
    subscriptionCategory: {
      findUnique(args: {
        where: { key: string };
        select: { id: true };
      }): Promise<{ id: string } | null>;
    };
  },
  name: string,
): Promise<string> {
  return buildUniqueCatalogueKey(name, async (key) =>
    Boolean(await db.subscriptionCategory.findUnique({ where: { key }, select: { id: true } })));
}

export function subscriptionCategoryOrderBy(): Prisma.SubscriptionCategoryOrderByWithRelationInput[] {
  return [{ sortOrder: "asc" }, { name: "asc" }, { id: "asc" }];
}
