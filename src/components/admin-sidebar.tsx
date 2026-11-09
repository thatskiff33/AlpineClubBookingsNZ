"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import { pluralHutLeaderLabel } from "@/config/hut-leader-label";
import {
  LayoutDashboard,
  Users,
  ArrowRightLeft,
  BookOpen,
  CalendarDays,
  Clock,
  Tag,
  ClipboardCheck,
  ClipboardList,
  XCircle,
  BarChart2,
  RefreshCw,
  Menu,
  Mountain,
  CreditCard,
  FileText,
  Shield,
  Stethoscope,
  Activity,
  Mail,
  MessageSquare,
  Newspaper,
  UserCheck,
  Trash2,
  Sliders,
  House,
  Tablet,
  Tv,
  UsersRound,
  Bell,
  Bug,
  AlertTriangle,
  RotateCcw,
  ListChecks,
  Puzzle,
  UserX,
  BedDouble,
  Hammer,
  Wrench,
  Palette,
  UserPlus,
  Plug,
  ChevronRight,
  Landmark,
  BadgeCheck,
  Building2,
  DatabaseBackup,
  DollarSign,
  LockKeyhole,
  Search,
  Bot,
  Coins,
  Globe,
  ServerCog,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { isFeatureHrefVisible } from "@/config/feature-routes";
import {
  ADMIN_HUBS,
  ADMIN_MENU_DESTINATIONS,
  ADMIN_RETIRED_PAGES,
  activeAdminHref,
  getAdminPage,
  type AdminPageId,
} from "@/lib/admin-hubs";
import type { AdminHubPage } from "@/lib/admin-hubs/define";
import type { FeatureFlags } from "@/config/schema";
import {
  canAccessConsolidatedFeesPage,
  canOpenAdminPathWithMatrix,
  canViewAdminHrefWithMatrix,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";
import type { CalendarDate } from "@/lib/club-time";
import { useClubTime } from "@/components/club-time-provider";
import {
  buildUnpaidFinishedStaysHref,
  buildUnsettledAdditionalStaysHref,
} from "@/lib/unpaid-finished-stays-hrefs";
import { openAdminCommandPalette } from "@/lib/admin-command-palette-events";

interface NavSection {
  label?: string;
  items: Array<{
    href: string;
    label: string;
    icon: typeof LayoutDashboard;
    /** Shown only to Full Admins (e.g. access-role management). */
    fullAdminOnly?: boolean;
    /**
     * Custom visibility predicate replacing the single-area prefix check. Used
     * by the consolidated /admin/fees console (#1933, E7), whose admission is OR
     * (bookings OR finance) and cannot be expressed by canViewAdminHrefWithMatrix.
     */
    orAccess?: (matrix: AdminPermissionMatrix) => boolean;
  }>;
}

/**
 * Label of the queue-driven section whose items are shown only when they have
 * something pending. The section (and its header) disappears entirely once all
 * its queues are clear, so it never implies work that isn't there.
 */
const NEEDS_ATTENTION_LABEL = "Needs Attention";

/**
 * localStorage key holding the admin's per-section expand/collapse state, as a
 * `{ [sectionLabel]: boolean }` map. Sections default to expanded; a label the
 * user has collapsed is persisted as `false`.
 */
const SIDEBAR_COLLAPSE_STORAGE_KEY = "admin-sidebar:expanded-sections";

/**
 * Deep link for the unsettled-additions queue (#1723 path 2, widened by #2350):
 * every booking whose upward modification delta was never collected, whether the
 * stay has finished or is still ahead. Unlike the queue above this needs no date
 * in the URL — the owed filter alone is the queue — so the two halves the badge
 * sums both land here. Same drift rule: href from src/lib/unpaid-finished-stays-hrefs.ts,
 * count from the shared predicate in src/lib/unpaid-finished-stays.ts.
 */
const UNSETTLED_ADDITIONS_HREF = buildUnsettledAdditionalStaysHref();

/**
 * The pre-filtered queue views: Bookings deep links that are not pages of their
 * own, so the hub registry cannot list them. The sidebar shows them under
 * "Needs Attention" while their queue has something in it; the command palette
 * always offers them, under the hub of `page` (S2 #4797). One list, so the two
 * surfaces cannot carry different dated hrefs (#3123).
 */
const buildAdminQueueViews = (clubToday: CalendarDate) =>
  [
    {
      href: buildUnpaidFinishedStaysHref(clubToday),
      label: "Unpaid Finished Stays",
      icon: DollarSign,
      page: "bookings",
    },
    {
      href: UNSETTLED_ADDITIONS_HREF,
      label: "Unpaid Stay Additions",
      icon: DollarSign,
      page: "bookings",
    },
  ] as const satisfies ReadonlyArray<
    NavSection["items"][number] & { page: AdminPageId }
  >;

/**
 * Every admin nav section, for a given club day.
 *
 * A FUNCTION, not a constant, and both halves of that matter (#3123).
 *
 * The unpaid-finished-stays entry is a deep link whose `checkOutTo` bound is the
 * club's own day, and it is simultaneously a nav href, the key of the badge map
 * in `SidebarLinks`, and (through `buildAdminQueueViews`) what the command
 * palette navigates to. It used to be a
 * module-level `const` built from the environment timezone — which was wrong
 * twice over. It answered from the CONTAINER's day rather than the club's
 * persisted one (`INV-CONFIG-002`), and a module body is evaluated ONCE per
 * bundle load, so the cutoff was frozen for the life of the browser tab: an
 * administrator who left the tab open overnight got yesterday's filter beside
 * today's badge count, in every timezone on earth. Threading the day in means
 * both surfaces recompute it per render, from the one authority
 * `ClubTimeProvider` carries, and the href and the count are built in the same
 * render pass from the same value.
 */
const buildAdminNavSections = (clubToday: CalendarDate): NavSection[] => [
  {
    items: [
      {
        href: "/admin/dashboard",
        label: "Admin Dashboard",
        icon: LayoutDashboard,
      },
    ],
  },
  {
    // Queue-driven alerts. Every item here is also reachable from its natural
    // section below (Unpaid Finished Stays as a pre-filtered Bookings view);
    // these are duplicate links that surface only while their queue has
    // something pending (see the filtering in SidebarLinks).
    label: NEEDS_ATTENTION_LABEL,
    items: [
      { href: "/admin/xero", label: "Silent Xero Webhook", icon: Bell },
      {
        href: "/admin/booking-requests",
        label: "Booking Requests",
        icon: ClipboardList,
      },
      ...buildAdminQueueViews(clubToday).map(({ href, label, icon }) => ({
        href,
        label,
        icon,
      })),
      {
        href: "/admin/member-applications",
        label: "Applications",
        icon: ClipboardList,
      },
      { href: "/admin/family-groups", label: "Family Groups", icon: Users },
      {
        href: "/admin/refund-requests",
        label: "Refunds & Credits",
        icon: RotateCcw,
      },
      {
        href: "/admin/membership-cancellations",
        label: "Cancellation Requests",
        icon: UserX,
      },
      {
        href: "/admin/deletion-requests",
        label: "Deletion Requests",
        icon: Trash2,
      },
      { href: "/admin/issue-reports", label: "Issue Reports", icon: Bug },
      { href: "/admin/hut-leaders", label: "Hut Leaders", icon: Bell },
    ],
  },
  {
    label: "Bookings & Beds",
    items: [
      { href: "/admin/bookings", label: "Bookings", icon: BookOpen },
      {
        href: "/admin/booking-requests",
        label: "Booking Requests",
        icon: ClipboardList,
      },
      { href: "/admin/book", label: "Book on Behalf", icon: UserPlus },
      {
        href: "/admin/bed-allocation",
        label: "Bed Allocation",
        icon: BedDouble,
      },
      { href: "/admin/waitlist", label: "Waitlist", icon: Clock },
    ],
  },
  {
    label: "Rates & Policies",
    items: [
      // Hut nightly rates now live in the consolidated Fees console (#1933, E7,
      // see the Finance group "Fees" entry); /admin/seasons is reduced to season
      // windows and stays lodge-scoped (#130, ADR-005) — reached from Fees → Hut
      // Fees and the lodge hub's "Seasons & Rates" card, not a standalone entry.
      // The command palette offers it (S2 #4797); the page picks a lodge itself.
      {
        href: "/admin/age-tier-settings",
        label: "Age Groups",
        icon: Sliders,
      },
      {
        href: "/admin/promo-codes",
        label: "Promo Codes",
        icon: Tag,
      },
      {
        href: "/admin/booking-policies",
        label: "Booking Policies",
        icon: XCircle,
      },
    ],
  },
  {
    label: "Finance",
    items: [
      // Consolidated fee console (#1933, E7): Hut Fees (bookings) + Joining &
      // Annual Fees (finance). Shown to anyone with view on either area via the
      // OR predicate, since its prefix resolves to bookings only.
      {
        href: "/admin/fees",
        label: "Fees",
        icon: DollarSign,
        orAccess: canAccessConsolidatedFeesPage,
      },
      {
        href: "/admin/payments",
        label: "Payments",
        icon: CreditCard,
      },
      {
        href: "/admin/internet-banking",
        label: "Internet Banking",
        icon: Landmark,
      },
      {
        href: "/admin/refund-requests",
        label: "Refunds & Credits",
        icon: RotateCcw,
      },
      {
        href: "/admin/reports",
        label: "Reports",
        icon: BarChart2,
      },
      {
        href: "/admin/xero",
        label: "Xero Sync",
        icon: RefreshCw,
      },
      {
        href: "/admin/xero/member-grouping",
        label: "Xero Member Grouping",
        icon: Users,
      },
    ],
  },
  {
    label: "Members",
    items: [
      {
        href: "/admin/members",
        label: "Members",
        icon: Users,
      },
      { href: "/admin/subscriptions", label: "Subscriptions", icon: FileText },
      {
        href: "/admin/member-applications",
        label: "Applications",
        icon: ClipboardList,
      },
      {
        href: "/admin/membership-cancellations",
        label: "Cancellation Requests",
        icon: UserX,
      },
      { href: "/admin/induction", label: "Induction", icon: ClipboardCheck },
      {
        href: "/admin/communications",
        label: "Communications",
        icon: Mail,
      },
      {
        href: "/admin/message-board",
        label: "Message Board",
        icon: MessageSquare,
      },
      {
        href: "/admin/notices",
        label: "Member Notices",
        icon: Newspaper,
      },
      // Lockers is lodge-scoped (#130, ADR-005) — reached via the lodge hub's
      // "Lockers" card, not a standalone sidebar entry. The command palette
      // offers it (S2 #4797); the page picks a lodge itself.
      {
        href: "/admin/family-groups",
        label: "Family Groups",
        icon: Users,
      },
    ],
  },
  {
    label: "Lodge Operations",
    items: [
      { href: "/admin/hut-leaders", label: "Hut Leaders", icon: UserCheck },
      { href: "/admin/roster", label: "Roster", icon: ClipboardList },
      {
        href: "/admin/lodge",
        label: "Lodge Kiosk",
        icon: Tablet,
      },
      {
        href: "/admin/calendar",
        label: "Calendar",
        icon: CalendarDays,
      },
      { href: "/admin/work-parties", label: "Work Parties", icon: Hammer },
      {
        href: "/admin/lodge-instructions",
        label: "Lodge Instructions",
        icon: BookOpen,
      },
      {
        // Maintenance reports (#2780). No explicit flag needed:
        // `isFeatureHrefVisible` derives visibility from the href against
        // FEATURE_ROUTE_RULES, and "/admin/maintenance-reports" is registered
        // under the `maintenanceReports` rule — so with the module off this entry
        // disappears from the sidebar, matching the 404 the route returns.
        href: "/admin/maintenance-reports",
        label: "Lodge Maintenance",
        icon: Wrench,
      },
      // Lobby Display (fork issue #109): one Lodge Operations entry opens the
      // hub landing page (/admin/display), which lays out cards for Devices,
      // Layouts, Templates, and Reference rather than scattering its leaves
      // through the sidebar. Per-lodge display config remains on each lodge in
      // the lodge configuration hub (/admin/lodges/[id]) since LTV-035/#81.
      {
        href: "/admin/display",
        label: "Lobby Display",
        icon: Tv,
      },
    ],
  },
  {
    label: "Monitoring & Support",
    items: [
      { href: "/admin/issue-reports", label: "Issue Reports", icon: Bug },
      {
        href: "/admin/stuck-states",
        label: "Stuck States",
        icon: AlertTriangle,
      },
      {
        href: "/admin/health",
        label: "System Health",
        icon: Activity,
      },
      {
        href: "/admin/email-deliverability",
        label: "Email Deliverability",
        icon: Mail,
      },
      { href: "/admin/background-jobs", label: "Background Jobs", icon: Clock },
      {
        href: "/admin/privacy-retention",
        label: "Privacy & Retention",
        icon: Shield,
      },
      {
        href: "/admin/backups",
        label: "Database Backups",
        icon: DatabaseBackup,
      },
      {
        href: "/admin/ai-assistant",
        label: "AI help assistant",
        icon: Bot,
      },
      {
        // AI Diagnostics (AID-7, #2378) — a separate read-only investigation
        // product, not the help assistant above. Listed here because "why is this
        // booking stuck" is a support question, and this is where an admin already
        // comes looking.
        //
        // No explicit flag is needed: `isFeatureHrefVisible` derives visibility
        // from the href against FEATURE_ROUTE_RULES, and this PR registered
        // "/admin/ai-diagnostics" under the `aiDiagnostics` rule — so with the
        // module off the entry disappears from the sidebar, matching the 404 the
        // route itself now returns.
        //
        // ADMISSION, NOT AN AREA (ADR-002 §1, owner-ratified #2370): any admitted
        // administrator may open the shell, and the link follows that rule with
        // no flag here: `canViewAdminHrefWithMatrix` answers every
        // `ANY_ADMIN_ADMISSION_PATHS` entry as `canOpenAdminPath` does (#3596).
        // The href's `overview` map area stopped meaning "any admin" when #2984
        // made portal standing any one of the seven areas.
        href: "/admin/ai-diagnostics",
        label: "AI Diagnostics",
        icon: Stethoscope,
      },
      {
        href: "/admin/audit-log",
        label: "Audit Log",
        icon: Shield,
      },
      {
        href: "/admin/deletion-requests",
        label: "Deletion Requests",
        icon: Trash2,
      },
    ],
  },
  {
    label: "Setup & Configuration",
    items: [
      { href: "/admin/setup", label: "Setup", icon: ListChecks },
      { href: "/admin/modules", label: "Modules", icon: Puzzle },
      {
        href: "/admin/security",
        label: "Login & Security",
        icon: LockKeyhole,
      },
      { href: "/admin/lodges", label: "Lodges", icon: Building2 },
      {
        href: "/admin/membership-setup",
        label: "Membership & Members",
        icon: BadgeCheck,
      },
      {
        href: "/admin/appearance",
        label: "Site Appearance & Content",
        icon: Palette,
      },
      {
        href: "/admin/bookings-setup",
        label: "Bookings Setup",
        icon: BedDouble,
      },
      {
        href: "/admin/integrations",
        label: "Integrations",
        icon: Plug,
      },
      {
        href: "/admin/notifications",
        label: "Notifications & Email",
        icon: Bell,
      },
      // Chores is lodge-scoped (#130, ADR-005) — reached via the lodge hub's
      // "Chores" card, not a standalone sidebar entry. The command palette
      // offers it (S2 #4797); the page picks a lodge itself.
      {
        href: "/admin/access-roles",
        label: "Access Roles",
        icon: Shield,
        fullAdminOnly: true,
      },
      {
        href: "/admin/config-transfer",
        label: "Export & Import",
        icon: ArrowRightLeft,
        fullAdminOnly: true,
      },
      {
        // The one persisted IANA club timezone (CT-1 #2989, epic #2988). Full
        // Admin like Access Roles and Export & Import beside it, and the route
        // enforces that itself.
        href: "/admin/club-time",
        label: "Club Time Zone",
        icon: Globe,
        fullAdminOnly: true,
      },
      {
        // The one persisted currency and locale (#3563). UNLIKE its Full-Admin
        // neighbours, any admin sees it (#3596): all may VIEW, only a Full Admin
        // may change. It is an `ANY_ADMIN_ADMISSION_PATHS` entry, so the matrix
        // check admits every admin, not just its `support` map area.
        href: "/admin/club-format",
        label: "Club Currency & Locale",
        icon: Coins,
      },
      {
        // Is this the club's live site or a copy (ENV-SAFETY 1 #3034, epic
        // #2986)? Full Admin like Access Roles, Export & Import and Club Time
        // Zone beside it, and the route enforces that itself.
        href: "/admin/environment",
        label: "Environment Safety",
        icon: ServerCog,
        fullAdminOnly: true,
      },
      { href: "/admin/committee", label: "Committee", icon: UsersRound },
    ],
  },
];

/**
 * `clubToday` is FIRST and REQUIRED on all three of these exports, and it is
 * required rather than defaulted deliberately (#3123). One nav href is a dated
 * deep link, so a default here would be a second, quieter way to get the club's
 * day — and a wrong one, since neither reader can run in a browser. Leading with
 * it also makes the compiler enumerate every call site, which is how the sidebar
 * and the command palette were kept on one value instead of two.
 */
// test seam
export function getVisibleAdminNavSections(
  clubToday: CalendarDate,
  features: FeatureFlags,
  permissionMatrix?: AdminPermissionMatrix,
  isFullAdmin?: boolean,
  hutLeaderLabel = "Hut Leader",
): NavSection[] {
  return buildAdminNavSections(clubToday)
    .map((section) => ({
      ...section,
      items: section.items
        .filter(
          (item) =>
            isFeatureHrefVisible(item.href, features) &&
            (!item.fullAdminOnly || isFullAdmin) &&
            (!permissionMatrix ||
              (item.orAccess
                ? item.orAccess(permissionMatrix)
                : canViewAdminHrefWithMatrix(permissionMatrix, item.href))),
        )
        .map((item) =>
          item.href === "/admin/hut-leaders"
            ? { ...item, label: pluralHutLeaderLabel(hutLeaderLabel) }
            : item,
        ),
    }))
    .filter((section) => section.items.length > 0);
}

/** A single searchable page in the admin feature palette (#2092). */
export interface AdminFeatureSearchEntry {
  /** Destination the palette navigates to on selection. */
  href: string;
  /** Visible label, already relabelled (e.g. hut-leader term). */
  label: string;
  /** The label of the hub the page belongs to: the palette's group heading. */
  section: string;
  /** Extra match terms: the page's registry keywords and retired page names. */
  keywords?: readonly string[];
}

/** The palette's group headings, in menu order: one per hub (S2 #4797). */
export const ADMIN_FEATURE_SEARCH_GROUP_ORDER: readonly string[] = ADMIN_HUBS.map(
  (hub) => hub.label,
);

const HUB_LABEL_BY_KEY: ReadonlyMap<string, string> = new Map(
  ADMIN_HUBS.map((hub) => [hub.key, hub.label]),
);

/**
 * A page's palette keywords: its registry keywords, then the name of every page
 * merged into it (S1 #4796), so an officer who still types "Booking Rules" finds
 * Bookings Setup. Case-insensitively de-duplicated.
 */
function paletteKeywords(page: AdminHubPage): readonly string[] {
  const words = [
    ...page.keywords,
    ...ADMIN_RETIRED_PAGES.filter((retired) => retired.mergedInto === page.id).map(
      (retired) => retired.label,
    ),
  ];
  const seen = new Set<string>();
  return words.filter((word) => {
    const key = word.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The admin feature palette's index (#2092), built from the hub registry (S2
 * #4797): every menu destination (`ADMIN_MENU_DESTINATIONS`, so never a detail,
 * print, stub, test or retired page), linked at its `adminHref`, grouped by its
 * hub and carrying its keywords; then the sidebar's pre-filtered queue views
 * (`buildAdminQueueViews`), under the hub of the page they filter. It is no
 * longer the sidebar's list: the sidebar links only some pages, and the palette
 * offers every page this admin may open.
 *
 * Every entry passes all of these, so the palette fails CLOSED:
 * - a permission matrix was supplied (none yields an EMPTY index; the sidebar's
 *   `getVisibleAdminNavSections` keeps its older fail-open contract);
 * - `isFeatureHrefVisible`: no disabled module gates its path;
 * - a `fullAdminOnly` page only for a Full Admin;
 * - `canOpenAdminPathWithMatrix`: the layout guard's own admission rule, so an
 *   OR admission (the fee console, Rooms & Beds) and an any-admin page answer
 *   exactly as the page will.
 */
export function getAdminFeatureSearchIndex(
  clubToday: CalendarDate,
  features: FeatureFlags,
  permissionMatrix?: AdminPermissionMatrix,
  isFullAdmin?: boolean,
  hutLeaderLabel = "Hut Leader",
): AdminFeatureSearchEntry[] {
  if (!permissionMatrix) {
    return [];
  }
  const offers = (href: string, page: AdminHubPage) =>
    isFeatureHrefVisible(href, features) &&
    (!page.fullAdminOnly || isFullAdmin === true) &&
    canOpenAdminPathWithMatrix(permissionMatrix, href);
  const hubLabel = (page: AdminHubPage) => HUB_LABEL_BY_KEY.get(page.hub) ?? page.hub;

  const pages = ADMIN_MENU_DESTINATIONS.filter(({ page, href }) =>
    offers(href, page),
  ).map(({ page, href }) => ({
    href,
    label:
      page.id === "hut-leaders" ? pluralHutLeaderLabel(hutLeaderLabel) : page.label,
    section: hubLabel(page),
    keywords: paletteKeywords(page),
  }));
  const queueViews = buildAdminQueueViews(clubToday).flatMap((view) => {
    const page = getAdminPage(view.page);
    return offers(view.href, page)
      ? [{ href: view.href, label: view.label, section: hubLabel(page) }]
      : [];
  });
  return [...pages, ...queueViews];
}

type AdminNavBadgeMap = Record<string, number>;

// test seam
export function getRenderedAdminNavSections(
  clubToday: CalendarDate,
  features: FeatureFlags,
  badges: AdminNavBadgeMap,
  permissionMatrix?: AdminPermissionMatrix,
  isFullAdmin?: boolean,
  hutLeaderLabel = "Hut Leader",
): NavSection[] {
  return getVisibleAdminNavSections(
    clubToday,
    features,
    permissionMatrix,
    isFullAdmin,
    hutLeaderLabel,
  )
    .map((section) =>
      section.label === NEEDS_ATTENTION_LABEL
        ? {
            ...section,
            items: section.items.filter((item) => (badges[item.href] ?? 0) > 0),
          }
        : section,
    )
    .filter((section) => section.items.length > 0);
}

import type { AdminPendingCounts } from "@/lib/admin-pending-counts";

const ZERO_PENDING_COUNTS: AdminPendingCounts = {
  familyRequests: 0,
  memberApplications: 0,
  refundAppeals: 0,
  manualRefundTasks: 0,
  creditApprovals: 0,
  bookingReviews: 0,
  bookingChangeRequests: 0,
  newBookingPolicyExceptionRequests: 0,
  publicBookingRequests: 0,
  unpaidFinishedStays: 0,
  unsettledAdditionalFinishedStays: 0,
  unsettledAdditionalUpcomingStays: 0,
  membershipCancellations: 0,
  archiveRequests: 0,
  deletionRequests: 0,
  memberDeleteRequests: 0,
  issueReports: 0,
  unassignedHutLeaderDates: 0,
};

/** Fetch every queue count for the sidebar badges in a single request. */
function usePendingCounts(): AdminPendingCounts {
  const [counts, setCounts] = useState<AdminPendingCounts>(ZERO_PENDING_COUNTS);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/admin/pending-counts")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled && data) {
          setCounts({ ...ZERO_PENDING_COUNTS, ...data });
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  return counts;
}

function SidebarLinks({
  features,
  permissionMatrix,
  isFullAdmin,
  hutLeaderLabel = "Hut Leader",
  onNavigate,
}: {
  features: FeatureFlags;
  permissionMatrix?: AdminPermissionMatrix;
  isFullAdmin?: boolean;
  hutLeaderLabel?: string;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const counts = usePendingCounts();
  /*
    ONE club day for this render, and everything dated below is built from it
    (#3123, `INV-CONFIG-002`). The nav href and the badge-map key are produced by
    the SAME shared builder (`buildUnpaidFinishedStaysHref`) from the SAME value,
    so the deep link's check-out cutoff and the count beside it cannot describe
    different days — which is what the old module-level constant made possible,
    because it was evaluated once per bundle load while the counts are fetched
    per mount.

    `useClubTime()` and not a server prop: a prop resolved in `(admin)/layout.tsx`
    would be re-resolved only on a hard page load, since the App Router keeps a
    layout's server render across client navigations — which is the same
    staleness in a different place. A browser cannot read the persisted zone
    itself, so the provider is the only legitimate source
    (`club-time-provider.tsx`); the admin tree is wrapped by `AppProviders`,
    which `club-time-provider-mount-census.test.tsx` enforces.
  */
  const clubToday = useClubTime().today();

  // Per-section expand state, keyed by label. Starts as an empty map (every
  // section open) so server and first client render match; the stored
  // preference is applied after mount. "Needs Attention" is never collapsible.
  const [expandedSections, setExpandedSections] = useState<
    Record<string, boolean>
  >({});

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SIDEBAR_COLLAPSE_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object") {
          setExpandedSections(parsed as Record<string, boolean>);
        }
      }
    } catch {
      // Unavailable or malformed storage; fall back to all expanded.
    }
  }, []);

  const toggleSection = (label: string) => {
    setExpandedSections((prev) => {
      // An absent entry means "open by default", so negate the effective state.
      const next = { ...prev, [label]: !(prev[label] ?? true) };
      try {
        window.localStorage.setItem(
          SIDEBAR_COLLAPSE_STORAGE_KEY,
          JSON.stringify(next),
        );
      } catch {
        // Storage unavailable; state still updates for this session.
      }
      return next;
    });
  };

  // Map href -> badge count
  const badges: Record<string, number> = {};
  if (counts.memberApplications > 0) {
    badges["/admin/member-applications"] = counts.memberApplications;
  }
  if (counts.familyRequests > 0) {
    badges["/admin/family-groups"] = counts.familyRequests;
  }
  const bookingRequestCount =
    counts.bookingReviews +
    counts.bookingChangeRequests +
    // #2526: a NEW-booking policy exception lives in its own table, so it is a
    // separate term; a MODIFICATION exception is already a BookingChangeRequest
    // and is inside the term above.
    counts.newBookingPolicyExceptionRequests +
    counts.publicBookingRequests;
  if (bookingRequestCount > 0) {
    badges["/admin/booking-requests"] = bookingRequestCount;
  }
  if (counts.unpaidFinishedStays > 0) {
    badges[buildUnpaidFinishedStaysHref(clubToday)] = counts.unpaidFinishedStays;
  }
  // #2350: both halves of the unsettled-additions queue behind one badge. The
  // predicates are disjoint by construction (check-out before/after today), so
  // the sum counts every owing booking exactly once.
  const unsettledAdditionsCount =
    counts.unsettledAdditionalFinishedStays +
    counts.unsettledAdditionalUpcomingStays;
  if (unsettledAdditionsCount > 0) {
    badges[UNSETTLED_ADDITIONS_HREF] = unsettledAdditionsCount;
  }
  if (counts.refundAppeals + counts.creditApprovals > 0) {
    badges["/admin/refund-requests"] =
      counts.refundAppeals + counts.creditApprovals;
  }
  // B5 (#2262): open cash hand-back tasks live on the payments board, which is
  // where an admin closes them once the money has actually been paid back.
  if (counts.manualRefundTasks > 0) {
    badges["/admin/payments"] = counts.manualRefundTasks;
  }
  if (counts.membershipCancellations + counts.archiveRequests > 0) {
    badges["/admin/membership-cancellations"] =
      counts.membershipCancellations + counts.archiveRequests;
  }
  // The deletion-requests page hosts two flows: self-service account deletions
  // (deletionRequests, status PENDING) and admin-initiated hard-delete review
  // (memberDeleteRequests, DELETE requests status REQUESTED). Merge both into
  // one attention badge, mirroring the cancellations+archive merge above (#1938).
  if (counts.deletionRequests + counts.memberDeleteRequests > 0) {
    badges["/admin/deletion-requests"] =
      counts.deletionRequests + counts.memberDeleteRequests;
  }
  if (counts.issueReports > 0) {
    badges["/admin/issue-reports"] = counts.issueReports;
  }
  if (counts.unassignedHutLeaderDates > 0) {
    badges["/admin/hut-leaders"] = counts.unassignedHutLeaderDates;
  }

  if ((counts.xeroSilentWebhook ?? 0) > 0) {
    badges["/admin/xero"] = counts.xeroSilentWebhook!;
  }

  const renderedNavSections = getRenderedAdminNavSections(
    clubToday,
    features,
    badges,
    permissionMatrix,
    isFullAdmin,
    hutLeaderLabel,
  );
  const visibleNavSections = getVisibleAdminNavSections(
    clubToday,
    features,
    permissionMatrix,
    isFullAdmin,
    hutLeaderLabel,
  );

  const navHrefs = visibleNavSections.flatMap((s) => s.items.map((i) => i.href));
  // The deepest nav item the path is at or under (/admin/xero/setup lights Xero
  // Setup, not Xero Sync too), by the registry (C3 #4800), which reads a moved
  // page's old and hub URL as one page. Never compare `pathname` with an href.
  const activeHref = activeAdminHref(pathname, navHrefs);

  return (
    <nav aria-label="Admin sections" className="flex flex-col gap-0.5">
      <Link
        href="/dashboard"
        onClick={onNavigate}
        className="flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        <House className="h-4 w-4 shrink-0 text-muted-foreground" />
        Member Dashboard
      </Link>
      <div className="my-1.5 border-t border-border" />
      {renderedNavSections.map((section, sIdx) => {
        // Every labeled section collapses except "Needs Attention"; the
        // label-less top section (Admin Dashboard) is always shown.
        const collapsible =
          Boolean(section.label) && section.label !== NEEDS_ATTENTION_LABEL;
        const open =
          !collapsible || (expandedSections[section.label as string] ?? true);

        return (
          <div key={sIdx}>
            {section.label &&
              (collapsible ? (
                <button
                  type="button"
                  onClick={() => toggleSection(section.label as string)}
                  aria-expanded={open}
                  className="flex w-full items-center gap-1 rounded-md px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
                >
                  <ChevronRight
                    className={cn(
                      "h-3 w-3 shrink-0 transition-transform",
                      open && "rotate-90",
                    )}
                  />
                  <span>{section.label}</span>
                </button>
              ) : (
                <p className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {section.label}
                </p>
              ))}
            {open &&
              section.items.map(({ href, label, icon: Icon }) => {
                const active = href === activeHref;
                const badgeCount = badges[href];
                const badgeClasses =
                  href === "/admin/refund-requests"
                    ? "bg-danger text-danger-foreground"
                    : "bg-warning text-warning-foreground";

                return (
                  <Link
                    key={href}
                    href={href}
                    onClick={onNavigate}
                    className={cn(
                      "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                      active
                        ? "app-nav-link-active"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                    )}
                  >
                    <Icon
                      className={cn(
                        "h-4 w-4 shrink-0",
                        active ? "text-current" : "text-muted-foreground",
                      )}
                    />
                    <span className="flex-1">{label}</span>
                    {badgeCount != null && badgeCount > 0 && (
                      <span
                        className={cn(
                          "ml-auto inline-flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-[11px] font-semibold",
                          badgeClasses,
                        )}
                      >
                        {badgeCount > 99 ? "99+" : badgeCount}
                      </span>
                    )}
                  </Link>
                );
              })}
          </div>
        );
      })}
    </nav>
  );
}

/**
 * "Search…" trigger shown in the sidebar header (#2092). Opens the same command
 * palette as Ctrl/Cmd-K via a window event, so mouse users get a discoverable
 * entry point. The keyboard hint resolves to ⌘K on macOS and Ctrl K elsewhere,
 * computed after mount to avoid a hydration mismatch.
 */
function SidebarSearchButton({ onOpen }: { onOpen?: () => void }) {
  const [isMac, setIsMac] = useState(false);

  useEffect(() => {
    setIsMac(/Mac|iP(hone|ad|od)/.test(window.navigator.platform));
  }, []);

  return (
    <button
      type="button"
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
      className="mb-2 flex w-full items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
    >
      <Search className="h-4 w-4 shrink-0" />
      <span className="flex-1 text-left">Search…</span>
      <kbd
        aria-hidden
        className="pointer-events-none hidden items-center gap-0.5 rounded border border-border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground sm:inline-flex"
      >
        {isMac ? "⌘" : "Ctrl"} K
      </kbd>
    </button>
  );
}

export function AdminSidebar({
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
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col border-r bg-background print:hidden md:sticky md:top-16 md:flex md:h-[calc(100vh-4rem)]">
        <div className="flex h-16 shrink-0 items-center gap-2 border-b px-4 font-bold text-foreground">
          <span className="app-brand-mark h-9 w-9">
            <Mountain className="h-5 w-5" />
          </span>
          <span>Admin Panel</span>
        </div>
        <div className="flex-1 overflow-y-auto p-3 pb-8">
          <SidebarSearchButton />
          <SidebarLinks
            features={features}
            permissionMatrix={permissionMatrix}
            isFullAdmin={isFullAdmin}
            hutLeaderLabel={hutLeaderLabel}
          />
        </div>
      </aside>

      {/* Mobile header bar with toggle */}
      <div className="flex h-14 items-center gap-3 border-b bg-background px-4 print:hidden md:hidden">
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Open admin menu">
              <Menu className="h-5 w-5" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="flex w-64 flex-col p-0">
            <SheetHeader className="flex h-16 shrink-0 flex-row items-center gap-2 border-b px-4">
              <span className="app-brand-mark h-9 w-9">
                <Mountain className="h-5 w-5" />
              </span>
              <SheetTitle>Admin Panel</SheetTitle>
            </SheetHeader>
            <div className="flex-1 overflow-y-auto p-3 pb-8">
              <SidebarSearchButton onOpen={() => setMobileOpen(false)} />
              <SidebarLinks
                features={features}
                permissionMatrix={permissionMatrix}
                isFullAdmin={isFullAdmin}
                hutLeaderLabel={hutLeaderLabel}
                onNavigate={() => setMobileOpen(false)}
              />
            </div>
          </SheetContent>
        </Sheet>
        <span className="font-semibold text-foreground">Admin Panel</span>
      </div>
    </>
  );
}
