"use client";

import { useEffect, useState } from "react";

/**
 * Fetches the distinct set of committee role/position names from the
 * committee table (CommitteeMember.role) for use in admin member dropdowns.
 * Only active committee members are included, and roles are returned in the
 * committee table's sortOrder ordering.
 */
export function useCommitteeRoleOptions(): string[] {
  const [roles, setRoles] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    fetch("/api/admin/committee")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!active || !data?.members) return;
        // The committee API returns members ordered by sortOrder ascending.
        // Keep that ordering, include only active members, and dedupe roles.
        const distinct = Array.from(
          new Set(
            (
              data.members as {
                role?: string | null;
                active?: boolean;
              }[]
            )
              .filter((m) => m.active)
              .map((m) => m.role?.trim())
              .filter((role): role is string => Boolean(role)),
          ),
        );
        setRoles(distinct);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  return roles;
}
