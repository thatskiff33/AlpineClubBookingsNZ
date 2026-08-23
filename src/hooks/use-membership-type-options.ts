"use client";

import { useEffect, useState } from "react";

export interface MembershipTypeOption {
  id: string;
  /**
   * The stable identifier (`FULL`, `NON_MEMBER`, …), which `name` is not:
   * `name` is club-editable. #2978 needs it to answer "what does THIS club call
   * the type a non-member category falls back to".
   */
  key: string;
  name: string;
  isActive: boolean;
}

/**
 * The club's DB membership types, for surfaces that must show the club's own
 * wording rather than the seed's.
 *
 * Sourced from GET /api/admin/membership-types (already ordered by the API).
 * Returns an empty list until the fetch resolves or if it fails, so a caller
 * always has a defined list to fall back from. Mirrors the fetch-with-fallback
 * shape of {@link useAccessRoleOptions}.
 *
 * IT RETURNS EVERY TYPE, ACTIVE OR NOT, and each caller filters. The members
 * list's "Membership Type" picker offers only the active ones, as it always has;
 * #2978's Type–Tier label wants the club's name for a key whatever its active
 * state, since a deactivated type's rows still read by that name elsewhere.
 */
export function useMembershipTypeOptions(): MembershipTypeOption[] {
  const [options, setOptions] = useState<MembershipTypeOption[]>([]);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/admin/membership-types")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled && Array.isArray(data?.membershipTypes)) {
          setOptions(
            (
              data.membershipTypes as Array<{
                id: string;
                key: string;
                name: string;
                isActive: boolean;
              }>
            ).map((type) => ({
              id: type.id,
              key: type.key,
              name: type.name,
              isActive: type.isActive,
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
