import { z } from "zod";

export const DEFAULT_SILENT_WEBHOOK_HOURS = 24;
export const MIN_SILENT_WEBHOOK_HOURS = 1;
export const MAX_SILENT_WEBHOOK_HOURS = 720;
export const silentWebhookHoursSchema = z.number().int()
  .min(MIN_SILENT_WEBHOOK_HOURS).max(MAX_SILENT_WEBHOOK_HOURS);
