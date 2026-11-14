"use client";

import { useCallback, useMemo, useState } from "react";
import { useDebouncedMemberSearch } from "@/hooks/use-debounced-member-search";
import type { EmailInheritanceSearchResult } from "../_types";

interface UseInheritEmailSearchParams {
  memberId: string | undefined;
  /** Search only runs while the notification-recipient block is visible. */
  enabled: boolean;
}

// Debounced search for an eligible primary adult to receive a no-login
// member's notifications. The debounce/fetch/stale-guard mechanics live in
// the shared useDebouncedMemberSearch (#1758); this hook keeps the
// inherit-email specifics — the eligibility params, the selected-source
// bookkeeping, and filtering the current selection out of the results.
export function useInheritEmailSearch({
  memberId,
  enabled,
}: UseInheritEmailSearchParams) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] =
    useState<EmailInheritanceSearchResult | null>(null);

  const {
    results: rawResults,
    searching,
    error,
  } = useDebouncedMemberSearch<EmailInheritanceSearchResult>({
    query: search,
    enabled: enabled && Boolean(memberId),
    params: {
      pageSize: "8",
      inheritEmailEligible: "true",
      excludeId: memberId ?? "",
    },
    errorFallback: "Failed to search eligible adult members",
  });

  const results = useMemo(
    () =>
      rawResults
        .map((candidate) => ({
          id: candidate.id,
          firstName: candidate.firstName,
          lastName: candidate.lastName,
          email: candidate.email,
          active: candidate.active,
        }))
        .filter((candidate) => candidate.id !== selected?.id),
    [rawResults, selected?.id],
  );

  // Clearing the query is all it takes: the shared hook derives empty
  // results and a blank error for an inactive query in the same render.
  const resetSearch = useCallback(() => {
    setSearch("");
  }, []);

  const select = useCallback(
    (source: EmailInheritanceSearchResult) => {
      setSelected(source);
      resetSearch();
    },
    [resetSearch],
  );

  const clear = useCallback(() => {
    setSelected(null);
    resetSearch();
  }, [resetSearch]);

  /** Re-seed on entering edit mode from the member's current inheritance. */
  const resetTo = useCallback(
    (source: EmailInheritanceSearchResult | null) => {
      setSelected(source);
      resetSearch();
    },
    [resetSearch],
  );

  return {
    search,
    setSearch,
    results,
    error,
    searching,
    selected,
    select,
    clear,
    resetTo,
  };
}
