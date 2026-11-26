/**
 * The page content route's request schemas (`/api/admin/page-content`),
 * shared with the AI app actions that call it (ALP-723, `INV-SSOT`): the app
 * is described exactly the fields the route enforces. The HTML fields are
 * sanitised by the route itself (`sanitizePageContentHtml`), never here.
 */
import { z } from "zod";

import { PAGE_CONTENT_LIMITS } from "@/lib/page-content";

const pageFields = {
  caption: z.string().trim().max(PAGE_CONTENT_LIMITS.captionMax),
  menuTitle: z.string().trim().max(PAGE_CONTENT_LIMITS.menuTitleMax),
  title: z.string().trim().min(1).max(PAGE_CONTENT_LIMITS.titleMax),
  headerText: z.string().max(PAGE_CONTENT_LIMITS.headerTextMax),
  slug: z.string().trim().min(1).max(PAGE_CONTENT_LIMITS.slugMax),
  sortOrder: z
    .number()
    .int()
    .min(PAGE_CONTENT_LIMITS.sortOrderMin)
    .max(PAGE_CONTENT_LIMITS.sortOrderMax),
};

// The id travels in the body on every change, matching how PUT and PATCH
// address a page on this collection route (#2352 D-B7(a)).
const pageId = z.string().trim().min(1);

/**
 * `GET ?id=`: one page with its stored HTML. The list leaves the HTML out of
 * an AI app's answer, so a long page is always read on its own (ALP-723).
 */
export const pageContentGetQuerySchema = z.object({ id: pageId });

/** `POST`: a new page, published at once with an empty body. */
export const pageContentCreateSchema = z.object(pageFields).strict();

/** `PUT`: every field of the page, replaced together. */
export const pageContentUpdateSchema = z
  .object({
    id: pageId,
    ...pageFields,
    contentHtml: z.string().max(PAGE_CONTENT_LIMITS.contentHtmlMax),
  })
  .strict();

/** `PATCH`: shows or hides a page on the public site. */
export const pageContentPublishSchema = z
  .object({
    id: pageId,
    published: z.boolean(),
  })
  .strict();

/** `DELETE`. */
export const pageContentDeleteSchema = z
  .object({
    id: pageId,
  })
  .strict();
