/**
 * What the page content, footer section and site banner actions send an AI
 * app connection (ALP-723, `INV-MCP-006`).
 *
 * A page and a footer section carry their stored HTML (`contentHtml`,
 * `headerText`), because the update actions replace it whole: an app editing
 * from a plain-text copy would strip the formatting on save. The footer
 * section list's `title` and `description` are the editor's labels for each
 * key, so the app knows which column it is changing.
 */
import type { AdminSiteBanner, AdminSiteBannerGroups } from "@/lib/site-banners";
import {
  completeConnectionShapeFor,
  type CompleteConnectionShapeFor,
  type ConnectionShape,
} from "@/lib/connection-projection";
import type { EditablePageRecord } from "@/lib/page-content";
import type { SiteContentDocument } from "@/lib/site-content";

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

const PAGE_SHAPE = {
  id: true,
  slug: true,
  caption: true,
  menuTitle: true,
  title: true,
  headerText: true,
  path: true,
  sortOrder: true,
  contentHtml: true,
  published: true,
  updatedAt: true,
  updatedByMemberId: true,
} as const satisfies CompleteConnectionShapeFor<EditablePageRecord>;

export const PAGE_CONTENT_LIST_CONNECTION_SHAPE: ConnectionShape = { pages: PAGE_SHAPE };

export const PAGE_CONTENT_PAGE_CONNECTION_SHAPE: ConnectionShape = { page: PAGE_SHAPE };

interface PageDeletedAnswer {
  ok: boolean;
  page: Pick<EditablePageRecord, "id" | "slug" | "path" | "title" | "published">;
  /** Pages whose HTML still links to the deleted one. */
  referencedBySlugs: string[];
  referencedByFooterSections: string[];
  wasBookNowTarget: boolean;
  bookNowPairRepaired: boolean;
  snapshotComplete: boolean;
  publicCacheCleared: boolean;
}

export const PAGE_CONTENT_DELETED_CONNECTION_SHAPE = completeConnectionShapeFor<PageDeletedAnswer>({
  ok: true,
  page: { id: true, slug: true, path: true, title: true, published: true },
  referencedBySlugs: true,
  referencedByFooterSections: true,
  wasBookNowTarget: true,
  bookNowPairRepaired: true,
  snapshotComplete: true,
  publicCacheCleared: true,
});

// ---------------------------------------------------------------------------
// Footer sections (keyed site content)
// ---------------------------------------------------------------------------

const SITE_CONTENT_SHAPE = {
  key: true,
  title: true,
  description: true,
  contentHtml: true,
  updatedAt: true,
} as const satisfies CompleteConnectionShapeFor<SiteContentDocument>;

export const SITE_CONTENT_LIST_CONNECTION_SHAPE: ConnectionShape = { documents: SITE_CONTENT_SHAPE };

export const SITE_CONTENT_SAVED_CONNECTION_SHAPE = completeConnectionShapeFor<{
  document: Pick<SiteContentDocument, "key" | "contentHtml"> & { updatedAt: string };
}>({
  document: { key: true, contentHtml: true, updatedAt: true },
});

// ---------------------------------------------------------------------------
// Site banners
// ---------------------------------------------------------------------------

const BANNER_SHAPE = {
  id: true,
  message: true,
  priority: true,
  startDate: true,
  endDate: true,
  active: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies CompleteConnectionShapeFor<AdminSiteBanner>;

export const SITE_BANNER_LIST_CONNECTION_SHAPE = completeConnectionShapeFor<AdminSiteBannerGroups>({
  current: BANNER_SHAPE,
  upcoming: BANNER_SHAPE,
  past: BANNER_SHAPE,
});

export const SITE_BANNER_CONNECTION_SHAPE: ConnectionShape = { banner: BANNER_SHAPE };

export const SITE_BANNER_DELETED_CONNECTION_SHAPE = completeConnectionShapeFor<{ ok: boolean }>({ ok: true });
