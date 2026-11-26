/**
 * The footer section route's request schema (`PUT /api/admin/site-content`),
 * shared with the AI app action that calls it (ALP-723, `INV-SSOT`). The HTML
 * is sanitised by the route itself (`sanitizePageContentHtml`), never here.
 */
import { z } from "zod";

import { SITE_CONTENT_KEYS, SITE_CONTENT_LIMITS } from "@/lib/page-content";

export const siteContentUpdateSchema = z
  .object({
    key: z.enum(SITE_CONTENT_KEYS),
    contentHtml: z.string().max(SITE_CONTENT_LIMITS.contentHtmlMax),
  })
  .strict();
