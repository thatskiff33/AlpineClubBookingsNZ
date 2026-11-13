"use client";

import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiErrorMessageFromBody } from "@/lib/api-error-message";

// The full admin CRUD shape from /api/admin/subscription-categories — a
// superset of the slim SubscriptionCategorySummary embedded on an assignment
// (which carries only what the preview/save flow needs).
interface SubscriptionCategoryOption {
  id: string;
  key: string;
  name: string;
  isActive: boolean;
  isBuiltIn: boolean;
}

interface SubscriptionCategoriesResponse {
  subscriptionCategories: SubscriptionCategoryOption[];
}

/**
 * The member's subscription category on the seasonal-membership card: an
 * independent billing axis that never affects booking rights or rate (those
 * are decided by the membership type). "Individual" is the empty-string value,
 * sent as null, meaning unchanged per-type billing. The built-in Individual
 * row is never offered as a real option; an archived category stays visible
 * (disabled) only while it is the member's current one.
 */
export function MemberSubscriptionCategoryField({
  value,
  onChange,
  currentCategoryId,
  onLoadError,
}: {
  value: string;
  onChange: (value: string) => void;
  currentCategoryId: string | null;
  onLoadError: (message: string) => void;
}) {
  const [categories, setCategories] = useState<SubscriptionCategoryOption[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const response = await fetch("/api/admin/subscription-categories", {
          credentials: "same-origin",
        });
        const body = (await response.json()) as
          | SubscriptionCategoriesResponse
          | { error?: string };
        if (!response.ok || !("subscriptionCategories" in body)) {
          throw new Error(
            apiErrorMessageFromBody(body, "Failed to load subscription categories"),
          );
        }
        if (!cancelled) setCategories(body.subscriptionCategories);
      } catch (loadError) {
        if (!cancelled) {
          onLoadError(
            loadError instanceof Error
              ? loadError.message
              : "Failed to load subscription categories",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
    // Loaded once per mount, like the membership-type list beside it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)]">
      <div className="space-y-2">
        <Label htmlFor="seasonal-membership-subscription-category">Subscription Category</Label>
        <Select
          value={value || "individual"}
          onValueChange={(next) => onChange(next === "individual" ? "" : next)}
          disabled={loading}
        >
          <SelectTrigger id="seasonal-membership-subscription-category">
            <SelectValue placeholder="Individual" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="individual">Individual</SelectItem>
            {categories
              .filter((category) => !category.isBuiltIn)
              .map((category) => (
                <SelectItem
                  key={category.id}
                  value={category.id}
                  disabled={!category.isActive && category.id !== currentCategoryId}
                >
                  {category.name}
                  {!category.isActive ? " (archived)" : ""}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Decides only how this member&apos;s subscription is billed — never their
          booking rights or rate. Set the flat amount on the Fees page.
        </p>
      </div>
    </div>
  );
}
