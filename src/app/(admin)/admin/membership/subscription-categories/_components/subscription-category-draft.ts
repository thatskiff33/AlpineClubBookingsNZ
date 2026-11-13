// The category editor's row and draft shapes, and the pure helpers that turn
// a draft into the API payload. Kept beside the page so the page stays a shell.

export interface SubscriptionCategory {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isActive: boolean;
  isBuiltIn: boolean;
  sortOrder: number;
  assignmentCount: number;
  feeCount: number;
}

export interface SubscriptionCategoriesResponse {
  subscriptionCategories: SubscriptionCategory[];
}

export interface DraftSubscriptionCategory {
  name: string;
  description: string;
  isActive: boolean;
  sortOrder: string;
}

export type EditorTarget =
  | { mode: "new" }
  | { mode: "edit"; subscriptionCategoryId: string };

export function createEmptyDraft(): DraftSubscriptionCategory {
  return { name: "", description: "", isActive: true, sortOrder: "" };
}

export function draftFromCategory(category: SubscriptionCategory): DraftSubscriptionCategory {
  return {
    name: category.name,
    description: category.description ?? "",
    isActive: category.isActive,
    sortOrder: String(category.sortOrder),
  };
}

export function validateDraft(draft: DraftSubscriptionCategory): string | null {
  if (draft.name.trim().length === 0) {
    return "Enter a subscription category name.";
  }
  if (draft.sortOrder.trim().length > 0 && !/^\d+$/.test(draft.sortOrder.trim())) {
    return "Sort order must be a whole number.";
  }
  return null;
}

export function draftPayload(draft: DraftSubscriptionCategory) {
  const trimmedSortOrder = draft.sortOrder.trim();
  return {
    name: draft.name,
    description: draft.description,
    isActive: draft.isActive,
    ...(trimmedSortOrder.length > 0 ? { sortOrder: Number(trimmedSortOrder) } : {}),
  };
}
