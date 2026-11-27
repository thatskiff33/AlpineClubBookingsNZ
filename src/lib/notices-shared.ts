// Shared notice constants safe to import from client components
// (no server-only imports here).

export const NOTICE_TITLE_MAX_LENGTH = 200;
// Generous ceiling for authored HTML; the same order of magnitude as the CMS
// page-content limit. Sanitisation runs on top of this.
export const NOTICE_BODY_MAX_LENGTH = 50_000;

/**
 * The `[id]` of a member notice route. Shared with the AI app action
 * catalogue (ALP-718), which addresses a notice by the same field.
 */
export { routeIdParamsSchema as noticeIdParamsSchema } from "@/lib/route-id-params";
