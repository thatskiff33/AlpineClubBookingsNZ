"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CornerDownLeft } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import {
  ADMIN_FEATURE_SEARCH_GROUP_ORDER,
  getAdminFeatureSearchIndex,
  type AdminFeatureSearchEntry,
} from "@/components/admin-sidebar";
import { useClubTime } from "@/components/club-time-provider";
import type { FeatureFlags } from "@/config/schema";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";
import { ADMIN_COMMAND_PALETTE_OPEN_EVENT } from "@/lib/admin-command-palette-events";

function groupBySection(
  entries: AdminFeatureSearchEntry[],
): Array<{ section: string; entries: AdminFeatureSearchEntry[] }> {
  // Bucket entries by hub first. We deliberately do NOT let bucket-creation
  // order decide group order: the index lists the queue views after every page,
  // so a hub first seen there would otherwise land in the wrong position.
  const bucketBySection = new Map<string, AdminFeatureSearchEntry[]>();
  for (const entry of entries) {
    const section = entry.section;
    const bucket = bucketBySection.get(section);
    if (bucket) {
      bucket.push(entry);
    } else {
      bucketBySection.set(section, [entry]);
    }
  }

  // Emit groups in hub (menu) order. Any heading not in that list is appended
  // in first-encounter order as a defensive fallback.
  const groups: Array<{ section: string; entries: AdminFeatureSearchEntry[] }> =
    [];
  const emitted = new Set<string>();
  for (const section of ADMIN_FEATURE_SEARCH_GROUP_ORDER) {
    const bucket = bucketBySection.get(section);
    if (bucket && !emitted.has(section)) {
      groups.push({ section, entries: bucket });
      emitted.add(section);
    }
  }
  for (const [section, bucket] of bucketBySection) {
    if (!emitted.has(section)) {
      groups.push({ section, entries: bucket });
      emitted.add(section);
    }
  }

  return groups;
}

/**
 * The string cmdk fuzzy-matches against for an entry. Deliberately built from
 * human-readable fields (label, section, keywords) and NOT the href: several
 * hrefs are deep links carrying query strings (e.g. the unpaid-stays views
 * whose href contains `PAYMENT_PENDING`), and scoring against that raw href
 * would surface them for unrelated searches like "payments". Navigation still
 * uses the real href via the onSelect closure.
 */
function searchValue(entry: AdminFeatureSearchEntry): string {
  return [entry.label, entry.section, ...(entry.keywords ?? [])]
    .filter(Boolean)
    .join(" ");
}

export function AdminCommandPalette({
  features,
  permissionMatrix,
  isFullAdmin,
  hutLeaderLabel = "Hut Leader",
}: {
  features: FeatureFlags;
  permissionMatrix?: AdminPermissionMatrix;
  isFullAdmin?: boolean;
  hutLeaderLabel?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  // The control that had focus when the palette opened, so we can restore focus
  // there on close (a11y). Radix cannot do this itself without a DialogTrigger,
  // and this palette opens from a keyboard shortcut or a detached window event.
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  // getAdminFeatureSearchIndex builds the index from the hub registry and keeps
  // only the pages this admin may open (the layout guard's own admission rule,
  // module visibility and Full Admin), so every href here opens, on any
  // interaction path. It offers more than the sidebar renders — every admin
  // page, and the queue views even when their queue is empty — never a page
  // the admin may not open (S2 #4797).
  /*
    The SAME authority the sidebar uses, for the same reason (#3123). One entry
    in this index — the unpaid-finished-stays queue — is a deep link whose
    `checkOutTo` bound is the club's own day, and the sidebar renders that link
    beside its badge count. Both surfaces now derive it from
    `buildAdminQueueViews`, one definition, fed the club's day from THIS
    provider; before #3123 the day came from a module-level constant evaluated
    once per bundle load, so the palette and the sidebar could only ever agree by
    both being stale together. `admin-sidebar-club-time.test.tsx` pins the two
    against each other.
  */
  const clubToday = useClubTime().today();

  const index = useMemo(
    () =>
      getAdminFeatureSearchIndex(
        clubToday,
        features,
        permissionMatrix,
        isFullAdmin,
        hutLeaderLabel,
      ),
    [clubToday, features, permissionMatrix, isFullAdmin, hutLeaderLabel],
  );

  const groups = useMemo(() => groupBySection(index), [index]);

  const openPalette = useCallback(() => {
    restoreFocusRef.current =
      (document.activeElement as HTMLElement | null) ?? null;
    setOpen(true);
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        if (openRef.current) {
          setOpen(false);
        } else {
          openPalette();
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openPalette]);

  useEffect(() => {
    window.addEventListener(ADMIN_COMMAND_PALETTE_OPEN_EVENT, openPalette);
    return () =>
      window.removeEventListener(ADMIN_COMMAND_PALETTE_OPEN_EVENT, openPalette);
  }, [openPalette]);

  const handleSelect = useCallback(
    (href: string) => {
      // Navigating away: drop the restore target so onCloseAutoFocus lets the
      // destination page take focus naturally instead of bouncing back to the
      // opener button. Only an Escape/overlay dismiss (which leaves
      // restoreFocusRef set) restores focus to where the admin was.
      restoreFocusRef.current = null;
      setOpen(false);
      router.push(href);
    },
    [router],
  );

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Search admin features"
      description="Search the admin panel and jump straight to any page you can access."
      onCloseAutoFocus={(event) => {
        const target = restoreFocusRef.current;
        if (target && document.contains(target)) {
          event.preventDefault();
          target.focus();
        }
      }}
    >
      <CommandInput placeholder="Search admin features…" />
      <CommandList>
        <CommandEmpty>No matching admin pages.</CommandEmpty>
        {groups.map(({ section, entries }) => (
          <CommandGroup key={section} heading={section}>
            {entries.map((entry) => (
              <CommandItem
                key={entry.href}
                value={searchValue(entry)}
                onSelect={() => handleSelect(entry.href)}
                className="group"
              >
                <span className="flex-1">{entry.label}</span>
                <CommandShortcut className="opacity-0 transition-opacity group-data-[selected=true]:opacity-100">
                  <CornerDownLeft className="h-3.5 w-3.5" aria-hidden />
                </CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
