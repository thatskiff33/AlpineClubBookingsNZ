import type { Prisma } from "@prisma/client";

const SUBSCRIPTION_CATEGORY_KEY_MAX_LENGTH = 80;

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
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

// test seam
export function normalizeSubscriptionCategoryKey(name: string): string {
  const normalized = name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, SUBSCRIPTION_CATEGORY_KEY_MAX_LENGTH);
  return normalized || "CUSTOM";
}

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
  const base = normalizeSubscriptionCategoryKey(name);
  let candidate = base;
  let suffix = 2;

  while (
    await db.subscriptionCategory.findUnique({
      where: { key: candidate },
      select: { id: true },
    })
  ) {
    const suffixText = `_${suffix}`;
    candidate = `${base.slice(
      0,
      SUBSCRIPTION_CATEGORY_KEY_MAX_LENGTH - suffixText.length,
    )}${suffixText}`;
    suffix += 1;
  }

  return candidate;
}

export function subscriptionCategoryOrderBy(): Prisma.SubscriptionCategoryOrderByWithRelationInput[] {
  return [{ sortOrder: "asc" }, { name: "asc" }, { id: "asc" }];
}
