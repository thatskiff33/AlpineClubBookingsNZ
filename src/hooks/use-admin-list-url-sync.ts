"use client";

import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { servedAdminPathname } from "@/lib/admin-hubs";

/**
 * Keeps an admin list's address bar at `target`, the address its filters,
 * sort and page would write (#5295). The one place for this sync, so every
 * list compares the same way.
 *
 * It replaces only when the address shown differs from `target`. A replace to
 * the address the officer is already on is still a soft navigation: Next drops
 * the page's `<title>` until the server streams it back, so screen readers hear
 * no page name and the E2E axe audit intermittently failed `document-title`
 * (#5155). The path is compared in its served form (`servedAdminPathname`,
 * docs/ARCHITECTURE.md), the form `adminHref` builds `target` in, so either
 * address of a moved page counts as already there.
 */
export function useAdminListUrlSync(target: string): void {
  const router = useRouter();
  const pathname = servedAdminPathname(usePathname());
  const currentSearch = useSearchParams().toString();
  const current = currentSearch ? `${pathname}?${currentSearch}` : pathname;

  useEffect(() => {
    if (target !== current) router.replace(target, { scroll: false });
  }, [current, router, target]);
}
