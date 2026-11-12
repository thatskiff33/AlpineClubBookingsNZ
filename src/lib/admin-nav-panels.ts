/**
 * Role-driven admin sidebar PANELS (#108).
 *
 * A panel is a VIEW over the one admin nav catalogue (`buildAdminNavSections`
 * in `src/components/admin-sidebar.tsx`), never a second copy of it
 * (`INV-SSOT`): it names whole catalogue sections, a few pages borrowed from
 * other sections, and which "Needs Attention" queues it keeps. A page added to
 * a section therefore appears in every panel that shows that section.
 *
 * A panel only ever NARROWS. It is applied to sections the sidebar has already
 * filtered item by item (module flags, `fullAdminOnly`, `orAccess`, the
 * permission matrix), and a borrowed page is looked up in those same filtered
 * sections — so no panel can show a link the full sidebar would hide. Opening a
 * page is still decided by `guardAdminLayout` and `requireAdmin`; nothing here
 * is authorization.
 *
 * Which panels a person is offered comes from the permission MATRIX of each
 * role they hold, never from a role's name (`INV-CONFIG-001`): roles are
 * club-editable and clubs create their own, so "Treasurer" is not a stable
 * input but `finance: edit` is.
 */
import {
  canonicalAdminPathname,
  getAdminPage,
  type AdminPageId,
} from "@/lib/admin-hubs";
import {
  ADMIN_PERMISSION_AREAS,
  getAdminPermissionMatrix,
  type AdminPermissionArea,
  type AdminPermissionInput,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";

/**
 * Label of the queue-driven sidebar section whose items are shown only while
 * their queue has something pending. Lives here because the panel projection
 * and the sidebar both have to recognise it.
 */
export const NEEDS_ATTENTION_LABEL = "Needs Attention";

/** localStorage key holding the panel the viewer last picked in the switcher. */
export const ADMIN_NAV_PANEL_STORAGE_KEY = "admin-sidebar:panel";

/** Switcher order; the first panel a person holds is the one they open on. */
export const ADMIN_NAV_PANEL_KEYS = [
  "admin",
  "bookings",
  "membership",
  "content",
  "finance",
  "treasurer",
] as const;
export type AdminNavPanelKey = (typeof ADMIN_NAV_PANEL_KEYS)[number];

export interface AdminNavPanelDefinition {
  key: AdminNavPanelKey;
  /** Sidebar heading while this panel is shown. */
  title: string;
  /** Button text in the panel switcher. */
  switcherLabel: string;
  /** A role that can EDIT any of these areas is offered this panel. */
  editAreas: readonly AdminPermissionArea[];
  /** A role that edits nothing and views only these areas gets this panel. */
  viewAreas: readonly AdminPermissionArea[];
  /** Catalogue sections shown whole, by label; `"all"` for the full menu. */
  sections: readonly string[] | "all";
  /** Pages borrowed from other catalogue sections, appended to `into`. */
  borrowed: ReadonlyArray<{ page: AdminPageId; into: string }>;
  /**
   * The "Needs Attention" queues this panel keeps, by the page each links (a
   * queue's query string is ignored, so both unpaid-stay deep links are the
   * `bookings` page).
   */
  attentionPages: readonly AdminPageId[] | "all";
  /** Opens its Finance section with a link to the `/finance` workspace. */
  financeWorkspace?: boolean;
}

export const ADMIN_NAV_PANELS: Readonly<
  Record<AdminNavPanelKey, AdminNavPanelDefinition>
> = {
  admin: {
    key: "admin",
    title: "Admin Panel",
    switcherLabel: "Admin",
    editAreas: [],
    viewAreas: [],
    sections: "all",
    borrowed: [],
    attentionPages: "all",
  },
  bookings: {
    key: "bookings",
    title: "Bookings Panel",
    switcherLabel: "Bookings",
    // Lodge Operations rides with bookings: the seeded Booking Officer holds
    // `lodge: edit` (issue #108, decided 2026-11-05).
    editAreas: ["bookings", "lodge"],
    viewAreas: ["bookings", "lodge"],
    sections: [
      "Bookings & Beds",
      "Rates & Policies",
      "Finance",
      "Lodge Operations",
    ],
    borrowed: [{ page: "bookings-setup", into: "Bookings & Beds" }],
    attentionPages: ["booking-requests", "bookings", "hut-leaders"],
  },
  membership: {
    key: "membership",
    title: "Membership Panel",
    switcherLabel: "Membership",
    editAreas: ["membership"],
    viewAreas: ["membership"],
    sections: ["Members"],
    borrowed: [{ page: "membership-setup", into: "Members" }],
    attentionPages: [
      "member-applications",
      "family-groups",
      "membership-cancellations",
      "deletion-requests",
    ],
  },
  content: {
    key: "content",
    title: "Content Panel",
    switcherLabel: "Content",
    editAreas: ["content"],
    viewAreas: ["content"],
    // The catalogue reaches these pages through one hub link, so the sidebar
    // lists the Website hub's own pages here (`ADMIN_APPEARANCE_PAGES`).
    sections: [],
    borrowed: [],
    attentionPages: [],
  },
  // Finance and Treasurer differ by LEVEL: viewing finance is the short menu,
  // editing it adds the pages and queues a treasurer works.
  finance: {
    key: "finance",
    title: "Finance Panel",
    switcherLabel: "Finance",
    editAreas: [],
    viewAreas: ["finance"],
    sections: ["Finance"],
    borrowed: [],
    attentionPages: [],
    financeWorkspace: true,
  },
  treasurer: {
    key: "treasurer",
    title: "Treasurer Panel",
    switcherLabel: "Treasurer",
    editAreas: ["finance"],
    viewAreas: [],
    sections: ["Finance"],
    borrowed: [
      { page: "subscriptions", into: "Finance" },
      { page: "integrations", into: "Finance" },
    ],
    attentionPages: ["refund-requests", "bookings"],
    financeWorkspace: true,
  },
};

/**
 * `overview` is the dashboard and cross-area entry points; every seeded admin
 * role holds it, so it never decides which panel someone works in.
 */
const PANEL_NEUTRAL_AREAS: readonly AdminPermissionArea[] = ["overview"];

const ROLE_PANELS = ADMIN_NAV_PANEL_KEYS.filter((key) => key !== "admin");

/**
 * The panels one role gives.
 *
 * - A role that edits everything (Full Admin) → the Admin panel alone.
 * - A role that edits something → each panel serving an area it edits, plus the
 *   Admin panel if it edits an area no role panel serves (support), because
 *   only the full menu shows that area.
 * - A role that edits nothing → the one panel covering everything it views, or
 *   the Admin panel when it views across panels (Read-only Admin).
 * - A role with no admin area at all → nothing.
 */
function panelsForRole(matrix: AdminPermissionMatrix): AdminNavPanelKey[] {
  const areas = ADMIN_PERMISSION_AREAS.map((area) => area.key);
  const editAreas = areas.filter((area) => matrix[area] === "edit");
  if (editAreas.length === areas.length) return ["admin"];

  if (editAreas.length > 0) {
    const panels = ROLE_PANELS.filter((key) =>
      ADMIN_NAV_PANELS[key].editAreas.some((area) => editAreas.includes(area)),
    );
    const uncovered = editAreas.some(
      (area) =>
        !PANEL_NEUTRAL_AREAS.includes(area) &&
        !panels.some((key) => ADMIN_NAV_PANELS[key].editAreas.includes(area)),
    );
    return uncovered || panels.length === 0 ? [...panels, "admin"] : panels;
  }

  const viewed = areas.filter((area) => matrix[area] !== "none");
  if (viewed.length === 0) return [];
  const worked = viewed.filter((area) => !PANEL_NEUTRAL_AREAS.includes(area));
  const single =
    worked.length > 0
      ? ROLE_PANELS.find((key) =>
          worked.every((area) => ADMIN_NAV_PANELS[key].viewAreas.includes(area)),
        )
      : undefined;
  return [single ?? "admin"];
}

/**
 * The panels a person is offered, in switcher order, the one they open on
 * first: the union over the roles they hold, each judged by that role's OWN
 * matrix so that holding a role is what earns its menu (a Full Admin who is
 * also the Treasurer sees both, and a Full Admin alone sees only Admin).
 *
 * Anything that yields no panel falls back to the Admin panel, the sidebar's
 * historical fail-open contract: the menu is display only and is still
 * filtered item by item.
 */
export function resolveAdminNavPanels(
  roleMatrices: readonly AdminPermissionMatrix[],
): AdminNavPanelKey[] {
  const held = new Set(roleMatrices.flatMap(panelsForRole));
  const panels = ADMIN_NAV_PANEL_KEYS.filter((key) => held.has(key));
  return panels.length > 0 ? panels : ["admin"];
}

/** {@link resolveAdminNavPanels} for a member, one matrix per assigned role. */
export function resolveMemberAdminNavPanels(member: AdminPermissionInput) {
  return resolveAdminNavPanels(
    (member.accessRoles ?? []).map((role) =>
      getAdminPermissionMatrix({
        canLogin: member.canLogin,
        accessRoles: [role],
      }),
    ),
  );
}

/** A stored switcher choice, accepted only if it is still one of `choices`. */
export function pickStoredAdminNavPanel(
  stored: string | null,
  choices: readonly AdminNavPanelKey[],
): AdminNavPanelKey {
  return choices.find((key) => key === stored) ?? choices[0] ?? "admin";
}

/**
 * The registry key of the page an href links: its pathname (query and fragment
 * dropped) in old-path form, the same whether the href is a moved page's old or
 * hub URL.
 */
export function adminNavPageKey(href: string): string {
  return canonicalAdminPathname(href.split(/[?#]/)[0] ?? href);
}

/** The key {@link adminNavPageKey} gives any href of registry page `id`. */
const pageKeyOf = (id: AdminPageId) => getAdminPage(id).oldPath;

/**
 * Project already-filtered sidebar sections onto one panel.
 *
 * `leadingItems` are panel-only links that are not admin catalogue pages (the
 * Finance and Treasurer panels' link to the `/finance` workspace), keyed by the
 * section they open; the caller filters them, as it filters everything else.
 */
export function projectAdminNavPanel<
  I extends { href: string },
  S extends { label?: string; items: I[] },
>(
  sections: readonly S[],
  panelKey: AdminNavPanelKey,
  leadingItems: Readonly<Record<string, readonly I[]>> = {},
): S[] {
  const panel = ADMIN_NAV_PANELS[panelKey];
  if (panel.sections === "all") return [...sections];
  const shown = panel.sections;
  const keep =
    panel.attentionPages === "all"
      ? "all"
      : new Set(panel.attentionPages.map(pageKeyOf));

  const byPage = new Map<string, I>();
  for (const section of sections) {
    if (section.label === NEEDS_ATTENTION_LABEL) continue;
    for (const item of section.items) {
      const key = adminNavPageKey(item.href);
      if (!byPage.has(key)) byPage.set(key, item);
    }
  }

  return sections
    .filter(
      (section) =>
        section.label === undefined ||
        section.label === NEEDS_ATTENTION_LABEL ||
        shown.includes(section.label),
    )
    .map((section) => {
      if (section.label === NEEDS_ATTENTION_LABEL) {
        return {
          ...section,
          items: section.items.filter(
            (item) => keep === "all" || keep.has(adminNavPageKey(item.href)),
          ),
        };
      }
      if (section.label === undefined) return section;
      const label = section.label;
      const own = new Set(section.items.map((item) => adminNavPageKey(item.href)));
      const borrowed = panel.borrowed
        .filter((entry) => entry.into === label && !own.has(pageKeyOf(entry.page)))
        .map((entry) => byPage.get(pageKeyOf(entry.page)))
        .filter((item): item is I => item !== undefined);
      return {
        ...section,
        items: [...(leadingItems[label] ?? []), ...section.items, ...borrowed],
      };
    })
    .filter((section) => section.items.length > 0);
}
