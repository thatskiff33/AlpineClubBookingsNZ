/**
 * Pages, footer sections and site banners (Content admin area, ALP-723): what
 * an officer edits on Admin → Website → Pages, Footer and Banners. Every
 * change shows on the public website at once, replacing what another officer
 * may have written, so each is `destructive` (owner rule, #5305).
 *
 * The HTML an app sends is cleaned by the route's own sanitiser
 * (`sanitizePageContentHtml`) on save, exactly as the website's editor's is.
 */
import {
  pageContentCreateSchema,
  pageContentDeleteSchema,
  pageContentGetQuerySchema,
  pageContentPublishSchema,
  pageContentUpdateSchema,
} from "@/lib/admin-content-api/pages";
import { siteBannerCreateSchema, siteBannerUpdateSchema } from "@/lib/admin-content-api/banners";
import { siteContentUpdateSchema } from "@/lib/admin-content-api/site-content";
import {
  PAGE_CONTENT_DELETED_CONNECTION_SHAPE,
  PAGE_CONTENT_LIST_CONNECTION_SHAPE,
  PAGE_CONTENT_PAGE_CONNECTION_SHAPE,
  SITE_BANNER_CONNECTION_SHAPE,
  SITE_BANNER_DELETED_CONNECTION_SHAPE,
  SITE_BANNER_LIST_CONNECTION_SHAPE,
  SITE_CONTENT_LIST_CONNECTION_SHAPE,
  SITE_CONTENT_SAVED_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/content-pages";
import { routeIdParamsSchema } from "@/lib/route-id-params";

import type { McpAction } from "../catalogue";

/** Said wherever an app sends HTML the public site shows. */
const SANITISED =
  "The HTML is cleaned by the site's sanitiser on save, so scripts and unsafe markup are dropped. Text tokens such as `{{facebook-url}}` are kept and filled in on the public page.";

export const CONTENT_PAGE_MCP_ACTIONS: readonly McpAction[] = [
  // --- Pages ---------------------------------------------------------------
  {
    id: "list_site_pages",
    title: "List the website's pages",
    summary:
      "Every page of the public website, in menu order, with its `id`, address (`path`), menu title and whether it is published, but not its HTML: read one page's HTML with `get_site_page`. A page with a blank `menuTitle` is left out of the menu.",
    method: "GET",
    path: "/api/admin/page-content",
    kind: "read",
    returns: PAGE_CONTENT_LIST_CONNECTION_SHAPE,
    core: true,
  },
  {
    id: "get_site_page",
    title: "Show a website page",
    summary:
      "One page (`id` from `list_site_pages`) with every field `update_site_page` takes, including its stored HTML (`headerText` and `contentHtml`).",
    method: "GET",
    path: "/api/admin/page-content",
    query: pageContentGetQuerySchema,
    kind: "read",
    returns: PAGE_CONTENT_PAGE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "create_site_page",
    title: "Add a website page",
    summary:
      "Adds a page at `/<slug>` (lowercase letters, numbers and hyphens, with optional `/` between parts). It is published at once with an empty body, and shows in the menu if `menuTitle` is not blank; fill it in with `update_site_page`. Refused if the address is taken or reserved for part of the site. " +
      SANITISED,
    method: "POST",
    path: "/api/admin/page-content",
    body: pageContentCreateSchema,
    kind: "destructive",
    returns: PAGE_CONTENT_PAGE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_site_page",
    title: "Edit a website page",
    summary:
      "Replaces every field of a page at once, live on the public site: read it with `get_site_page`, then send all of its fields back, changing only what you mean to. If that answer was cut short, do not save: edit the page on the website instead. Refused if a system page's slug or menu order changes, or the slug is reserved or taken by another page. " +
      SANITISED,
    method: "PUT",
    path: "/api/admin/page-content",
    body: pageContentUpdateSchema,
    kind: "destructive",
    returns: PAGE_CONTENT_PAGE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "set_site_page_published",
    title: "Publish or hide a website page",
    summary:
      "Shows (`published: true`) or hides a page on the public website. System and built-in pages always stay published.",
    method: "PATCH",
    path: "/api/admin/page-content",
    body: pageContentPublishSchema,
    kind: "destructive",
    returns: PAGE_CONTENT_PAGE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "delete_site_page",
    title: "Delete a website page",
    summary:
      "Deletes a page the club added; system and built-in pages cannot be deleted. This cannot be undone. The answer lists the pages and footer sections that still link to it, and whether it was the Book Now target.",
    method: "DELETE",
    path: "/api/admin/page-content",
    body: pageContentDeleteSchema,
    kind: "destructive",
    returns: PAGE_CONTENT_DELETED_CONNECTION_SHAPE,
    core: false,
  },

  // --- Footer sections -------------------------------------------------------
  {
    id: "list_footer_sections",
    title: "List the website's footer sections",
    summary:
      "The footer columns shown on every public page, by `key`, with what each is for and its stored HTML.",
    method: "GET",
    path: "/api/admin/site-content",
    kind: "read",
    returns: SITE_CONTENT_LIST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_footer_section",
    title: "Edit a footer section",
    summary:
      "Replaces one footer column's HTML (`key` from `list_footer_sections`), live on every public page. If that list was cut short, do not save: edit the footer on the website instead. " +
      SANITISED,
    method: "PUT",
    path: "/api/admin/site-content",
    body: siteContentUpdateSchema,
    kind: "destructive",
    returns: SITE_CONTENT_SAVED_CONNECTION_SHAPE,
    core: false,
  },

  // --- Site banners ----------------------------------------------------------
  {
    id: "list_site_banners",
    title: "List website banners",
    summary:
      "The notices shown across the top of the public website: those showing now (`current`), `upcoming` and `past`. Dates are New Zealand days, inclusive.",
    method: "GET",
    path: "/api/admin/site-banners",
    kind: "read",
    returns: SITE_BANNER_LIST_CONNECTION_SHAPE,
    core: true,
  },
  {
    id: "create_site_banner",
    title: "Add a website banner",
    summary:
      "Adds a plain-text notice across the top of every public page from `startDate` to `endDate` (YYYY-MM-DD, New Zealand days, inclusive). `priority` sets its colour and order. It shows at once if today is in the window, unless `active` is false.",
    method: "POST",
    path: "/api/admin/site-banners",
    body: siteBannerCreateSchema,
    kind: "destructive",
    returns: SITE_BANNER_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_site_banner",
    title: "Edit a website banner",
    summary:
      "Changes a banner's message, priority, dates or whether it is `active`; a field left out keeps its value. The end date may not fall before the start date.",
    method: "PATCH",
    path: "/api/admin/site-banners/[id]",
    params: routeIdParamsSchema,
    body: siteBannerUpdateSchema,
    kind: "destructive",
    returns: SITE_BANNER_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "delete_site_banner",
    title: "Delete a website banner",
    summary: "Deletes a banner. This cannot be undone; to take one down for now, set `active` to false instead.",
    method: "DELETE",
    path: "/api/admin/site-banners/[id]",
    params: routeIdParamsSchema,
    kind: "destructive",
    returns: SITE_BANNER_DELETED_CONNECTION_SHAPE,
    core: false,
  },
];
