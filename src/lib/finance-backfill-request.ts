/**
 * What an officer sends to rebuild the finance monthly fact table from Xero
 * (`POST /api/finance/sync/backfill-monthly-facts`). The route and its AI app
 * action read it (ALP-721, `INV-SSOT`).
 *
 * The route has always been lenient about what reaches it, and still is: a
 * body that is not an object, a `fromMonth` that is not a non-blank string,
 * and a missing or null `maxChunks` all mean "no limit given", and
 * `maxChunks` is read as a number (`"12"` is 12). What it then refuses, and
 * the words it refuses with, are unchanged. An app is offered the strict
 * fields only.
 */
import { z } from "zod";

import { isMonthKey } from "@/lib/finance-monthly-facts";

/**
 * Upper bound on 12-month chunks walked per report (30 years). A runaway
 * backstop only — real runs stop at organisation pre-history first.
 */
export const DEFAULT_FINANCE_BACKFILL_MAX_CHUNKS = 30;

const FROM_MONTH_MESSAGE = "fromMonth must be a YYYY-MM month key";
const MAX_CHUNKS_MESSAGE = "maxChunks must be a positive integer";

const fromMonthField = z.string().refine(isMonthKey, FROM_MONTH_MESSAGE);
const maxChunksField = z
  .number({ error: MAX_CHUNKS_MESSAGE })
  .int({ error: MAX_CHUNKS_MESSAGE })
  .min(1, { error: MAX_CHUNKS_MESSAGE });

/** The fields as an app sends them: an optional `YYYY-MM` lower bound and chunk limit. */
export const financeBackfillMonthlyFactsBodyFields = {
  fromMonth: fromMonthField.optional(),
  maxChunks: maxChunksField.optional(),
};

/** The route's reading of whatever body arrived; its first issue's message is the refusal. */
export const financeBackfillMonthlyFactsBodySchema = z.preprocess(
  (body) => {
    const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    return {
      fromMonth:
        typeof record.fromMonth === "string" && record.fromMonth.trim() ? record.fromMonth.trim() : null,
      maxChunks:
        record.maxChunks === undefined || record.maxChunks === null
          ? DEFAULT_FINANCE_BACKFILL_MAX_CHUNKS
          : Number(record.maxChunks),
    };
  },
  z.object({ fromMonth: fromMonthField.nullable(), maxChunks: maxChunksField }),
);
