"use client";

/**
 * Small controls of the admin sidebar, kept apart from the nav catalogue in
 * `admin-sidebar.tsx` so that file stays within its size budget: the queue
 * counts behind the badges, the "Search…" trigger, the role-panel switcher
 * (#108), and the hub-menu role switcher (C14 #4811).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { ADMIN_HUBS } from "@/lib/admin-hubs";
import { hubRoot } from "@/lib/admin-hubs/define";
import { openAdminCommandPalette } from "@/lib/admin-command-palette-events";
import { ADMIN_QUEUE_CHANGED_EVENT } from "@/lib/admin-queue-events";
import {
  ZERO_ADMIN_PENDING_COUNTS,
  type AdminPendingCounts,
} from "@/lib/admin-work-queues";
import {
  ADMIN_NAV_PANELS,
  ADMIN_NAV_PANEL_STORAGE_KEY,
  pickStoredAdminNavPanel,
  type AdminNavPanelKey,
} from "@/lib/admin-nav-panels";

export type PendingCountsStatus = "loading" | "ok" | "error";

/**
 * The officer work-queue counts behind the Needs Attention badges (#4962).
 *
 * The admin layout is never remounted on a client navigation, so "fetch on
 * mount" meant "fetch once per hard reload": a decided request kept its badge
 * and new work never appeared. The counts are refetched instead
 * - whenever the pathname changes,
 * - when the tab regains focus or becomes visible again,
 * - when a queue page announces a decision (`notifyAdminQueueChanged`),
 * with at most one request in flight: a trigger during a request queues one
 * more after it, never a second concurrent one.
 *
 * A failed or non-OK load sets `status: "error"` and KEEPS the last good
 * counts, so the sidebar can say it could not load them rather than show a
 * false zero; `retry` asks again.
 */
export function usePendingCounts(): {
  counts: AdminPendingCounts;
  status: PendingCountsStatus;
  retry: () => void;
} {
  const pathname = usePathname();
  const [counts, setCounts] = useState<AdminPendingCounts>(ZERO_ADMIN_PENDING_COUNTS);
  const [status, setStatus] = useState<PendingCountsStatus>("loading");
  const load = useRef<() => void>(() => {});

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let again = false;

    const run = () => {
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = true;
      fetch("/api/admin/pending-counts", { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) throw new Error(`pending-counts ${response.status}`);
          const data = (await response.json()) as Partial<AdminPendingCounts>;
          if (disposed) return;
          setCounts({ ...ZERO_ADMIN_PENDING_COUNTS, ...data });
          setStatus("ok");
        })
        .catch(() => {
          if (!disposed) setStatus("error");
        })
        .finally(() => {
          inFlight = false;
          if (again && !disposed) {
            again = false;
            run();
          }
        });
    };
    load.current = run;

    const onVisible = () => {
      if (document.visibilityState === "visible") run();
    };
    window.addEventListener("focus", run);
    window.addEventListener(ADMIN_QUEUE_CHANGED_EVENT, run);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      window.removeEventListener("focus", run);
      window.removeEventListener(ADMIN_QUEUE_CHANGED_EVENT, run);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // Every navigation, the first render included.
  useEffect(() => {
    load.current();
  }, [pathname]);

  const retry = useCallback(() => load.current(), []);
  return { counts, status, retry };
}

/**
 * Shown in place of a silent, empty Needs Attention section when the counts
 * could not be loaded (#4962): a failure must never look like "nothing to do".
 */
export function PendingCountsError({
  retry,
  partial,
}: {
  retry: () => void;
  /** Some counts loaded and some did not, rather than the whole request failing. */
  partial?: boolean;
}) {
  return (
    <div
      role="alert"
      className="mx-3 my-1 flex items-center gap-2 rounded-md border border-warning-6 bg-warning-3 px-2 py-1.5 text-xs text-warning-11"
    >
      <span className="flex-1">
        {partial ? "Couldn't load some counts" : "Couldn't load counts"}
      </span>
      <button
        type="button"
        onClick={retry}
        className="font-semibold underline underline-offset-2 hover:no-underline"
      >
        Retry
      </button>
    </div>
  );
}

/**
 * "Search…" trigger shown in the sidebar header (#2092). Opens the same command
 * palette as Ctrl/Cmd-K via a window event, so mouse users get a discoverable
 * entry point. The keyboard hint resolves to ⌘K on macOS and Ctrl K elsewhere,
 * computed after mount to avoid a hydration mismatch.
 */
export function SidebarSearchButton({ onOpen }: { onOpen?: () => void }) {
  const [isMac, setIsMac] = useState(false);

  useEffect(() => {
    setIsMac(/Mac|iP(hone|ad|od)/.test(window.navigator.platform));
  }, []);

  return (
    <Button
      type="button"
      variant="outline"
      onClick={() => {
        // The mobile Sheet closes (onOpen -> setMobileOpen(false)) at the same
        // moment the palette opens. The Sheet's exit focus handling and the
        // palette's focus trap briefly compete, and the palette captures its
        // focus-restore target (this button) just before the Sheet unmounts it.
        // The palette guards the restore with document.contains, so restoring to
        // a detached node is a no-op. This stacked-layer focus race is not
        // meaningfully reproducible in jsdom — it is a manual mobile check.
        onOpen?.();
        openAdminCommandPalette();
      }}
      // The ⌘K / Ctrl K glyphs are decorative (aria-hidden); expose the shortcut
      // semantically instead so the accessible name stays just "Search…".
      aria-keyshortcuts="Meta+K Control+K"
      className="mb-2 w-full justify-start px-3 font-normal text-muted-foreground shadow-none"
    >
      <Search className="h-4 w-4 shrink-0" />
      <span className="flex-1 text-left">Search…</span>
      <kbd
        aria-hidden
        className="pointer-events-none hidden items-center gap-0.5 rounded border border-border bg-muted px-1.5 font-mono text-xs font-medium text-muted-foreground sm:inline-flex"
      >
        {isMac ? "⌘" : "Ctrl"} K
      </kbd>
    </Button>
  );
}

/**
 * Switch between the menus this person's roles give (#108): the full Admin
 * menu is one of them only when a role earns it. Rendered only when there is
 * more than one choice.
 */
export function PanelSwitcher({
  choices,
  current,
  onChange,
}: {
  choices: readonly AdminNavPanelKey[];
  current: AdminNavPanelKey;
  onChange: (key: AdminNavPanelKey) => void;
}) {
  if (choices.length < 2) return null;
  return (
    <div
      role="group"
      aria-label="Admin menu"
      className="mb-2 flex flex-wrap gap-1 rounded-md bg-muted p-1"
    >
      {choices.map((key) => (
        <Button
          key={key}
          type="button"
          variant="ghost"
          size="sm"
          aria-pressed={key === current}
          onClick={() => onChange(key)}
          className={cn(
            "h-auto flex-1 rounded px-2 py-1",
            key === current
              ? "bg-background text-foreground shadow-sm hover:bg-background"
              : "text-muted-foreground hover:bg-transparent hover:text-foreground",
          )}
        >
          {ADMIN_NAV_PANELS[key].switcherLabel}
        </Button>
      ))}
    </div>
  );
}

/** Sentinel for "All my roles". Not a role token; the save posts null. */
const ALL_MY_ROLES = "all-my-roles";

/**
 * The role whose hub menu is showing (C14 #4811). Rendered only when the
 * caller has already decided this officer holds two or more menu roles and is
 * not a Full Admin. "All my roles" clears the preference.
 */
export function MenuRoleSwitcher({
  roles,
  selected,
}: {
  roles: readonly { token: string; label: string }[];
  selected: string | null;
}) {
  const router = useRouter();
  return (
    <div className="mb-2 space-y-1">
      <p className="text-xs font-medium text-muted-foreground">Show menu for</p>
      <Select
        value={selected ?? ALL_MY_ROLES}
        onValueChange={(value) => {
          const role = value === ALL_MY_ROLES ? null : value;
          void fetch("/api/admin/menu-role", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ role }),
          })
            .then((response) => {
              if (response.ok) router.refresh();
            })
            .catch(() => undefined);
        }}
      >
        <SelectTrigger aria-label="Show menu for">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_MY_ROLES}>All my roles</SelectItem>
          {roles.map((role) => (
            <SelectItem key={role.token} value={role.token}>
              {role.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * One link per hub the role menu kept, in registry order (C14 #4811). The hub
 * list C13 would render is not in this tree, so this is that list.
 */
export function HubMenuLinks({
  keys,
  onNavigate,
}: {
  keys: readonly string[];
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const hubs = ADMIN_HUBS.filter((hub) => keys.includes(hub.key));
  return (
    <nav aria-label="Admin sections" className="flex flex-col gap-0.5">
      {hubs.map((hub) => {
        const href = hubRoot(hub.prefix);
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={hub.key}
            href={href}
            onClick={onNavigate}
            className={cn(
              "flex items-center rounded-md px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "app-nav-link-active"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            {hub.label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * The panel shown, and the switcher's choices (#108). Starts on the person's
 * default panel so server and first client render agree; a remembered choice
 * is applied after mount, and only if it is still one of their choices. A
 * LAYOUT effect, so it lands before the first paint: an admin who chose another
 * menu never sees the default flash on a hard load or on the remount between
 * the /admin and /finance layouts.
 */
export function useAdminNavPanel(choices: readonly AdminNavPanelKey[]) {
  const choicesKey = choices.join(",");
  const [panelKey, setPanelKey] = useState<AdminNavPanelKey>(
    choices[0] ?? "admin",
  );

  useLayoutEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(ADMIN_NAV_PANEL_STORAGE_KEY);
    } catch {
      // Storage unavailable; keep the default panel.
    }
    setPanelKey(
      pickStoredAdminNavPanel(
        stored,
        choicesKey.split(",") as AdminNavPanelKey[],
      ),
    );
  }, [choicesKey]);

  const choose = (key: AdminNavPanelKey) => {
    setPanelKey(key);
    try {
      window.localStorage.setItem(ADMIN_NAV_PANEL_STORAGE_KEY, key);
    } catch {
      // Storage unavailable; the choice still applies for this page.
    }
  };

  return { choices, panelKey, choose, title: ADMIN_NAV_PANELS[panelKey].title };
}
