"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
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
import type { FeatureFlags } from "@/config/schema";
import {
  canAccessConsolidatedFeesPage,
  canViewAdminHrefWithMatrix,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";
import { formatDateOnly, getTodayDateOnly } from "@/lib/date-only";
import {
  buildUnpaidFinishedStaysHref,
  buildUnsettledAdditionalStaysHref,
} from "@/lib/unpaid-finished-stays";
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
    /**
     * Extra search terms (synonyms, acronyms, sibling concepts) that should
     * surface this page in the admin feature palette (#2092) even when they
     * don't appear in the label. Purely additive — never affects sidebar
     * rendering or visibility, only the fuzzy match in the command palette.
     */
    keywords?: string[];
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
 * Deep link for the unpaid-finished-stays queue (#1731), shared with the
 * dashboard attention card via src/lib/unpaid-finished-stays.ts. Evaluated at
 * page load — the same moment the badge counts are fetched — so the link's
 * check-out cutoff and the fetched count describe the same NZ day.
 */
const UNPAID_FINISHED_STAYS_HREF = buildUnpaidFinishedStaysHref(
  formatDateOnly(getTodayDateOnly()),
);

/**
 * Deep link for the unsettled-additions queue (#1723 path 2, widened by #2350):
 * every booking whose upward modification delta was never collected, whether the
 * stay has finished or is still ahead. Unlike the queue above this needs no date
 * in the URL — the owed filter alone is the queue — so the two halves the badge
 * sums both land here. Same drift rule: the href and the count come from the
 * shared helpers in src/lib/unpaid-finished-stays.ts.
 */
const UNSETTLED_ADDITIONS_HREF = buildUnsettledAdditionalStaysHref();

const navSections: NavSection[] = [
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
      {
        href: "/admin/booking-requests",
        label: "Booking Requests",
        icon: ClipboardList,
      },
      {
        href: UNPAID_FINISHED_STAYS_HREF,
        label: "Unpaid Finished Stays",
        icon: DollarSign,
      },
      {
        href: UNSETTLED_ADDITIONS_HREF,
        label: "Unpaid Stay Additions",
        icon: DollarSign,
      },
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
        keywords: ["rooms", "beds", "assign", "bunks"],
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
      {
        href: "/admin/age-tier-settings",
        label: "Age Groups",
        icon: Sliders,
        keywords: ["age tiers", "child pricing", "youth", "senior"],
      },
      {
        href: "/admin/promo-codes",
        label: "Promo Codes",
        icon: Tag,
        keywords: ["discount", "coupon", "voucher"],
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
        keywords: [
          "hut fees",
          "joining fees",
          "annual fees",
          "rates",
          "pricing",
        ],
      },
      {
        href: "/admin/payments",
        label: "Payments",
        icon: CreditCard,
        keywords: ["stripe", "transactions", "receipts"],
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
        keywords: ["statements", "export", "analytics", "revenue"],
      },
      {
        href: "/admin/xero",
        label: "Xero Sync",
        icon: RefreshCw,
        keywords: ["accounting", "invoices", "reconcile"],
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
        keywords: ["users", "people", "contacts", "membership"],
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
        keywords: ["email", "newsletter", "bulk message", "broadcast"],
      },
      {
        href: "/admin/notices",
        label: "Member Notices",
        icon: Newspaper,
        keywords: ["news", "recent news", "notice", "announcement", "committee"],
      },
      // Lockers is lodge-scoped (#130, ADR-005) — reached via the lodge hub's
      // "Lockers" card, not a standalone sidebar entry.
      { href: "/admin/family-groups", label: "Family Groups", icon: Users },
      {
        href: "/admin/family-suggestions",
        label: "Family Suggestions",
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
        keywords: ["check-in", "kiosk", "arrivals"],
      },
      {
        href: "/admin/calendar",
        label: "Calendar",
        icon: CalendarDays,
        keywords: ["events", "meetings", "committee", "schedule"],
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
        // disappears from the sidebar and the command palette, matching the 404
        // the route returns.
        href: "/admin/maintenance-reports",
        label: "Lodge Maintenance",
        icon: Wrench,
        keywords: ["maintenance", "fault", "repair", "broken", "qr", "fix"],
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
        keywords: ["signage", "screen", "tv", "devices"],
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
        keywords: ["status", "diagnostics", "uptime", "monitoring"],
      },
      {
        href: "/admin/email-deliverability",
        label: "Email Deliverability",
        icon: Mail,
      },
      { href: "/admin/background-jobs", label: "Background Jobs", icon: Clock },
      {
        href: "/admin/backups",
        label: "Database Backups",
        icon: DatabaseBackup,
        keywords: ["backup", "s3", "restore", "disaster recovery", "pg_dump"],
      },
      {
        href: "/admin/ai-assistant",
        label: "AI help assistant",
        icon: Bot,
        keywords: ["ai", "assistant", "anthropic", "llm", "help", "spend cap"],
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
        // module off the entry disappears from the sidebar AND the command palette
        // (which builds its index from this same function), matching the 404 the
        // route itself now returns.
        href: "/admin/ai-diagnostics",
        label: "AI Diagnostics",
        icon: Stethoscope,
        keywords: [
          "diagnose",
          "investigate",
          "why",
          "blocked",
          "evidence",
          "troubleshoot",
          "explain",
        ],
      },
      {
        href: "/admin/audit-log",
        label: "Audit Log",
        icon: Shield,
        keywords: ["history", "activity", "changes", "trail"],
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
        keywords: ["password", "2fa", "two-factor", "sign-in", "magic link"],
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
        // "google analytics", "analytics" and "ga4" ride on the HUB href because
        // the Google Analytics configuration has no href of its own — #2573 put it
        // in a dialog on this hub, and the search index is built from the hrefs the
        // sidebar would show (`getAdminFeatureSearchIndex`), so a card inside a page
        // can only be found through the page that carries it. Without them the
        // palette answered "analytics" with Financial Reports, whose own keywords
        // already claim the word, and "google analytics" and "ga4" with nothing at
        // all — for the screen that controls whether the club's public website
        // tracks visitors. Same reason Backups carries "s3"/"pg_dump" and the AI
        // help assistant carries "anthropic"/"spend cap".
        keywords: [
          "api",
          "connections",
          "third-party",
          "webhooks",
          "google analytics",
          "analytics",
          "ga4",
        ],
      },
      {
        href: "/admin/notifications",
        label: "Notifications & Email",
        icon: Bell,
      },
      // Chores is lodge-scoped (#130, ADR-005) — reached via the lodge hub's
      // "Chores" card, not a standalone sidebar entry.
      {
        href: "/admin/access-roles",
        label: "Access Roles",
        icon: Shield,
        fullAdminOnly: true,
        keywords: ["permissions", "rbac", "staff roles", "admin roles"],
      },
      {
        href: "/admin/config-transfer",
        label: "Export & Import",
        icon: ArrowRightLeft,
        fullAdminOnly: true,
        keywords: ["backup", "migration", "config transfer", "restore"],
      },
      {
        // The one persisted IANA club timezone (CT-1 #2989, epic #2988). Full
        // Admin like Access Roles and Export & Import beside it, and the route
        // enforces that itself. The keywords carry the words an operator would
        // actually type — "timezone" as one word and two, plus the daylight-saving
        // vocabulary and "IANA" — because the label alone matches none of them and
        // the palette index is built from these entries.
        href: "/admin/club-time",
        label: "Club Time Zone",
        icon: Globe,
        fullAdminOnly: true,
        keywords: [
          "timezone",
          "time zone",
          "clock",
          "daylight saving",
          "dst",
          "iana",
          "utc offset",
          "nzst",
          "nzdt",
        ],
      },
      {
        // Is this the club's live site or a copy (ENV-SAFETY 1 #3034, epic
        // #2986)? Full Admin like Access Roles, Export & Import and Club Time
        // Zone beside it, and the route enforces that itself. The keywords carry
        // the words an operator would actually type — "staging", "test site",
        // "copy", "live" — because the label matches none of them and the command
        // palette index is built from these entries.
        href: "/admin/environment",
        label: "Environment Safety",
        icon: ServerCog,
        fullAdminOnly: true,
        keywords: [
          "production",
          "non-production",
          "staging",
          "test site",
          "copy",
          "live site",
          "environment",
          "safe mode",
        ],
      },
      { href: "/admin/committee", label: "Committee", icon: UsersRound },
    ],
  },
];

/**
 * Distinct sidebar section labels in canonical `navSections` order (#2092). The
 * command palette orders its groups by this list so that a page first
 * encountered under "Needs Attention" during href de-duplication doesn't drag
 * its natural group to the wrong position. `undefined` marks the label-less
 * Admin Dashboard section whose palette entry falls under the "General"
 * heading.
 */
export const ADMIN_NAV_SECTION_ORDER: ReadonlyArray<string | undefined> = [
  ...new Set(navSections.map((section) => section.label)),
];

// test seam
export function getVisibleAdminNavSections(
  features: FeatureFlags,
  permissionMatrix?: AdminPermissionMatrix,
  isFullAdmin?: boolean,
  hutLeaderLabel = "Hut Leader",
): NavSection[] {
  return navSections
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
            ? { ...item, label: `${hutLeaderLabel}s` }
            : item,
        ),
    }))
    .filter((section) => section.items.length > 0);
}

/** A single searchable page in the admin feature palette (#2092). */
export interface AdminFeatureSearchEntry {
  /** Destination the palette navigates to on selection. */
  href: string;
  /** Visible label, already relabelled (e.g. hut-leader term) by the source. */
  label: string;
  /** Owning sidebar section label, if any (top-level entries have none). */
  section?: string;
  /** Optional extra match terms carried from the nav entry. */
  keywords?: string[];
}

/**
 * Flat, de-duplicated search index for the admin feature palette (#2092),
 * derived at runtime from {@link getVisibleAdminNavSections}. Reusing that
 * function — rather than re-reading `navSections` or re-implementing the
 * predicate — is deliberate and load-bearing: it guarantees the palette
 * applies EXACTLY the same four visibility conditions the sidebar does
 * (module-flag visibility, `fullAdminOnly`, `orAccess`, and the permission
 * matrix) plus the hut-leader relabel, so the palette can never reveal an href
 * an admin is not permitted to open.
 *
 * Superset, not "exactly what the sidebar shows": the index lists every page
 * the sidebar COULD show this admin, which is deliberately more than the
 * sidebar renders at any given moment. The two queue-driven "Needs Attention"
 * deep links (Unpaid Finished Stays / Unpaid Stay Additions) appear here
 * unconditionally — they are useful, always-accessible, pre-filtered views —
 * whereas the sidebar reveals them only while their queue is non-empty. This is
 * never a superset in permission terms: an href the admin may not open is never
 * indexed.
 *
 * Fail-closed: unlike {@link getVisibleAdminNavSections} (whose fail-OPEN
 * missing-matrix contract predates this and is shared with other callers), a
 * missing `permissionMatrix` yields an EMPTY index here, so the search surface
 * denies by default rather than exposing every page — defence in depth (#2092).
 *
 * De-duplication: a handful of hrefs appear twice in `navSections` — once in
 * the queue-driven "Needs Attention" section and once in their natural home
 * section. We key by href and let later (natural) sections overwrite the
 * earlier "Needs Attention" copy, so every page appears exactly once, labelled
 * by its natural section where it has one.
 */
export function getAdminFeatureSearchIndex(
  features: FeatureFlags,
  permissionMatrix?: AdminPermissionMatrix,
  isFullAdmin?: boolean,
  hutLeaderLabel = "Hut Leader",
): AdminFeatureSearchEntry[] {
  // Palette-scoped defence in depth: deny (empty index) when no matrix is
  // supplied, rather than inheriting getVisibleAdminNavSections' fail-open.
  if (!permissionMatrix) {
    return [];
  }
  const byHref = new Map<string, AdminFeatureSearchEntry>();
  for (const section of getVisibleAdminNavSections(
    features,
    permissionMatrix,
    isFullAdmin,
    hutLeaderLabel,
  )) {
    for (const item of section.items) {
      byHref.set(item.href, {
        href: item.href,
        label: item.label,
        section: section.label,
        keywords: item.keywords,
      });
    }
  }
  return [...byHref.values()];
}

type AdminNavBadgeMap = Record<string, number>;

// test seam
export function getRenderedAdminNavSections(
  features: FeatureFlags,
  badges: AdminNavBadgeMap,
  permissionMatrix?: AdminPermissionMatrix,
  isFullAdmin?: boolean,
  hutLeaderLabel = "Hut Leader",
): NavSection[] {
  return getVisibleAdminNavSections(
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
    badges[UNPAID_FINISHED_STAYS_HREF] = counts.unpaidFinishedStays;
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

  const renderedNavSections = getRenderedAdminNavSections(
    features,
    badges,
    permissionMatrix,
    isFullAdmin,
    hutLeaderLabel,
  );
  const visibleNavSections = getVisibleAdminNavSections(
    features,
    permissionMatrix,
    isFullAdmin,
    hutLeaderLabel,
  );

  // Highlight the most specific nav item whose href is a prefix of the current
  // path, so nested routes (e.g. /admin/xero/setup) activate the deepest match
  // rather than every ancestor (e.g. both "Xero Sync" and "Xero Setup").
  const activeHref = visibleNavSections
    .flatMap((section) => section.items.map((item) => item.href))
    .filter((href) => pathname === href || pathname.startsWith(`${href}/`))
    .reduce((best, href) => (href.length > best.length ? href : best), "");

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
