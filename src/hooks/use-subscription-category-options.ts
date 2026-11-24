"use client";

import { useEffect, useState } from "react";

export interface SubscriptionCategoryOption {
  id: string;
  key: string;
  name: string;
  isActive: boolean;
}

/**
 * The club's subscription categories for the members list's filter and bulk
 * action, from GET /api/admin/subscription-categories (already ordered by the
 * API). The built-in Individual row is left out: it is never assigned, and
 * "no category" is how a picker offers it. Archived categories are returned so
 * the filter can still find members left in one; each caller decides whether
 * to offer them. Returns an empty list until the fetch resolves or if it fails,
 * the same fetch-with-fallback shape as `useMembershipTypeOptions`.
 */
export function useSubscriptionCategoryOptions(): SubscriptionCategoryOption[] {
  const [options, setOptions] = useState<SubscriptionCategoryOption[]>([]);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/admin/subscription-categories")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled && Array.isArray(data?.subscriptionCategories)) {
          setOptions(
            (
              data.subscriptionCategories as Array<
                SubscriptionCategoryOption & { isBuiltIn: boolean }
              >
            )
              .filter((category) => !category.isBuiltIn)
              .map((category) => ({
                id: category.id,
                key: category.key,
                name: category.name,
                isActive: category.isActive,
              })),
          );
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  return options;
}

/** An option's label, marking an archived category. */
export function subscriptionCategoryOptionLabel(option: SubscriptionCategoryOption): string {
  return option.isActive ? option.name : `${option.name} (archived)`;
}
