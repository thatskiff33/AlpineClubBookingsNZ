import { adminHref } from "./index";

/** Shared by the wizard's step definition and every mapping shortcut (INV-SSOT). */
export const XERO_MAPPING_STEP_ID = "mapping";

/** Open account mapping, with the wizard clamping to any unfinished prerequisite. */
export function xeroMappingHref(): string {
  return adminHref("xero-setup") + "?step=" + XERO_MAPPING_STEP_ID;
}
