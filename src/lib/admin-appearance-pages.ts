import {
  BadgeInfo,
  FilePenLine,
  Images,
  Megaphone,
  Mountain,
  Palette,
  PanelBottom,
  type LucideIcon,
} from "lucide-react";
import type { AdminHubSection } from "@/components/admin-hub-page";
import { isFeatureHrefVisible } from "@/config/feature-routes";
import type { FeatureFlags } from "@/config/schema";
import { adminHref, getAdminPage } from "@/lib/admin-hubs";
import type { WEBSITE_HUB } from "@/lib/admin-hubs/hubs/website";
import {
  canOpenAdminPathWithMatrix,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";

type WebsitePageId = (typeof WEBSITE_HUB)["pages"][number]["id"];

/** The hub page itself: its cards are the Website hub's other pages. */
const WEBSITE_HUB_PAGE = "appearance" satisfies WebsitePageId;

/**
 * Each card's text and icon, keyed by the page's registry id, in card order.
 * Exhaustive over the Website hub (`satisfies Record`): a page the registry
 * adds to the hub does not compile until it has a card, and a card for a page
 * the hub lost does not compile either. Href and title come from the registry.
 */
const WEBSITE_PAGE_CARDS = {
  "club-identity": {
    description:
      "Set the club name, short name, hut-leader label, and your lodge's public details.",
    icon: BadgeInfo,
  },
  "site-style": {
    description:
      "Set the public theme, logo, colours, fonts, and first-run style completion.",
    icon: Palette,
  },
  "site-content": {
    description:
      "Edit shared public site chrome such as footer columns and reusable site text.",
    icon: PanelBottom,
  },
  "page-content": {
    description:
      "Manage public website pages, menus, rich text, tokens, and publishing state.",
    icon: FilePenLine,
  },
  "site-banners": {
    description:
      "Publish dated notice banners for public visitors and signed-in members.",
    icon: Megaphone,
  },
  "mountain-conditions": {
    description:
      "Configure Snow.nz condition widgets and public mountain condition content.",
    icon: Mountain,
  },
  "image-manager": {
    description:
      "Upload and organise filesystem images used by public content editors.",
    icon: Images,
  },
} as const satisfies Record<
  Exclude<WebsitePageId, typeof WEBSITE_HUB_PAGE>,
  { description: string; icon: LucideIcon }
>;

type WebsiteCardPageId = keyof typeof WEBSITE_PAGE_CARDS;

/** Each card's registry page beside its card. */
const WEBSITE_CARDS = (Object.keys(WEBSITE_PAGE_CARDS) as WebsiteCardPageId[]).map(
  (id) => {
    const page = getAdminPage(id);
    const card: AdminHubSection = {
      href: adminHref(id),
      title: page.label,
      ...WEBSITE_PAGE_CARDS[id],
    };
    return { page, card };
  },
);

/**
 * The Site Appearance & Content hub's cards, a view over the hub registry's
 * Website pages: the hub page and the Content sidebar panel (#108) both read
 * it, so a page the registry adds to the hub appears in both, linked wherever
 * its hub serves it.
 */
export const ADMIN_APPEARANCE_PAGES: AdminHubSection[] = WEBSITE_CARDS.map(
  ({ card }) => card,
);

/** The hub page's own title, from the registry: the Content panel's heading. */
const ADMIN_APPEARANCE_HUB_TITLE = getAdminPage(WEBSITE_HUB_PAGE).label;

/**
 * The Content panel's section: the catalogue reaches these pages through one
 * hub link, so the panel lists them under the rule the hub's cards use
 * (`AdminHubPage`: module flags, then `canOpenAdminPathWithMatrix`), plus the
 * page's registry `fullAdminOnly`.
 */
export function getContentPanelSections(
  features: FeatureFlags,
  permissionMatrix?: AdminPermissionMatrix,
  isFullAdmin?: boolean,
) {
  const items = WEBSITE_CARDS.filter(
    ({ page, card }) =>
      isFeatureHrefVisible(card.href, features) &&
      (!page.fullAdminOnly || isFullAdmin === true) &&
      (!permissionMatrix ||
        canOpenAdminPathWithMatrix(permissionMatrix, card.href)),
  ).map(({ card: { href, title, icon } }) => ({ href, label: title, icon }));
  return items.length > 0 ? [{ label: ADMIN_APPEARANCE_HUB_TITLE, items }] : [];
}
