/**
 * The request schemas of the Support area's system routes: the setup
 * checklist's progress, the provider connection tests, the privacy retention
 * settings' preview, and the problem reports' queue and decisions (ALP-724,
 * `INV-MCP-006`).
 *
 * In a pure lib module because each route parses with these and the AI app
 * action catalogue offers the same fields (`INV-SSOT`). No database or server
 * imports, so the catalogue can load it.
 */
import { z } from "zod";

import { adminListPageQueryFields } from "@/lib/admin-list-page";
import { SETUP_STEP_IDS } from "@/lib/setup-step-ids";

// ---------------------------------------------------------------------------
// The setup checklist
// ---------------------------------------------------------------------------

/** Marking one step of the checklist. */
export const setupStepProgressSchema = z.object({
  action: z
    .enum(["complete", "skip", "reopen"])
    .describe("`complete` ticks the step, `skip` sets it aside, `reopen` clears either."),
  stepId: z.enum(SETUP_STEP_IDS).describe("The check's `id` from `get_setup_readiness`."),
});

/**
 * `PATCH /api/admin/setup/progress`: one step, or the whole checklist
 * (`finish` it, or `reset` every step).
 */
export const setupProgressSchema = z.discriminatedUnion("action", [
  setupStepProgressSchema,
  z.object({ action: z.enum(["finish", "reset"]) }),
]);

/** `POST /api/admin/setup/provider-test`. Each test reads or checks; none sends to a member. */
export const providerTestSchema = z.object({
  provider: z
    .enum(["stripe", "smtp", "sentry", "xero"])
    .describe(
      "`stripe` reads the card account's balance, `smtp` checks the email connection without sending, `sentry` sends one diagnostic event, `xero` checks the accounting connection's token.",
    ),
});

// ---------------------------------------------------------------------------
// Privacy retention
// ---------------------------------------------------------------------------

/** How many rows each paged list of the privacy retention preview answers. */
export const PRIVACY_RETENTION_PREVIEW_PAGE_SIZE = 25;

/** `GET /api/admin/privacy-retention`: which page of what the retention jobs would remove. */
export const privacyRetentionPreviewQuerySchema = z.object({
  page: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      `Page of the email, application and undated member lists, ${PRIVACY_RETENTION_PREVIEW_PAGE_SIZE} to a page, from 1.`,
    ),
  memberAfter: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("The former member list's cursor: `memberNextCursor` from the previous page."),
});

// ---------------------------------------------------------------------------
// Problem reports
// ---------------------------------------------------------------------------

/** `GET /api/admin/issue-reports`. */
export const issueReportListQuerySchema = z.object({
  status: z
    .enum(["OPEN", "RESOLVED", "ALL"])
    .optional()
    .default("OPEN")
    .describe("Which reports: `OPEN` (the default), `RESOLVED` or `ALL`."),
  ...adminListPageQueryFields,
});

/** Resolving a report, without the `action` discriminator. */
export const issueReportResolveBodySchema = z.object({
  note: z.string().trim().max(1000).optional().describe("What was done, shown on the report."),
});

/** Deleting a report's screenshot ahead of its expiry, without the `action` discriminator. */
export const issueReportDeleteScreenshotBodySchema = z.object({
  reason: z.string().trim().max(300).optional().describe("Why the screenshot is deleted early; recorded in the audit log."),
});

/** `PATCH /api/admin/issue-reports/[id]`: resolve, reopen, or delete the screenshot. */
export const issueReportActionSchema = z.discriminatedUnion("action", [
  issueReportResolveBodySchema.extend({ action: z.literal("resolve") }),
  z.object({ action: z.literal("reopen") }),
  issueReportDeleteScreenshotBodySchema.extend({ action: z.literal("deleteScreenshot") }),
]);
