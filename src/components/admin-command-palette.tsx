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
  ADMIN_NAV_SECTION_ORDER,
  getAdminFeatureSearchIndex,
  type AdminFeatureSearchEntry,
} from "@/components/admin-sidebar";
import { useClubTime } from "@/components/club-time-provider";
import type { FeatureFlags } from "@/config/schema";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";
import { ADMIN_COMMAND_PALETTE_OPEN_EVENT } from "@/lib/admin-command-palette-events";

/** Fallback heading for entries whose sidebar section has no label. */
const UNGROUPED_SECTION = "General";

/** Group headings in canonical sidebar-section order (label-less -> General). */
const CANONICAL_GROUP_ORDER: string[] = ADMIN_NAV_SECTION_ORDER.map(
  (label) => label ?? UNGROUPED_SECTION,
);

function groupBySection(
  entries: AdminFeatureSearchEntry[],
): Array<{ section: string; entries: AdminFeatureSearchEntry[] }> {
  // Bucket entries by heading first. We deliberately do NOT let bucket-creation
  // order decide group order: getAdminFeatureSearchIndex de-duplicates by href
  // and a page first seen under "Needs Attention" keeps that early insertion
  // slot even after its natural-section label overwrites the value, which would
  // otherwise pull its natural group to the wrong position.
  const bucketBySection = new Map<string, AdminFeatureSearchEntry[]>();
  for (const entry of entries) {
    const section = entry.section ?? UNGROUPED_SECTION;
    const bucket = bucketBySection.get(section);
    if (bucket) {
      bucket.push(entry);
    } else {
      bucketBySection.set(section, [entry]);
    }
  }

  // Emit groups in canonical sidebar order (Needs Attention lands in its own
  // natural slot). Any heading not in the canonical list is appended in
  // first-encounter order as a defensive fallback.
  const groups: Array<{ section: string; entries: AdminFeatureSearchEntry[] }> =
    [];
  const emitted = new Set<string>();
  for (const section of CANONICAL_GROUP_ORDER) {
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

  // The index is derived from getVisibleAdminNavSections (via
  // getAdminFeatureSearchIndex), so every href here is one this admin is
  // permitted to open, on any interaction path. It is a deliberate superset of
  // what the sidebar renders right now — the queue-driven "Needs Attention"
  // deep links are always searchable even when their queue is empty — never a
  // permission superset.
  /*
    The SAME authority the sidebar uses, for the same reason (#3123). One entry
    in this index — the unpaid-finished-stays queue — is a deep link whose
    `checkOutTo` bound is the club's own day, and the sidebar renders that link
    beside its badge count. Both surfaces now derive it from
    `buildAdminNavSections`, one definition, fed the club's day from THIS
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
