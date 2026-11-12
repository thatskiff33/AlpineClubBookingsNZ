import { adminHref } from "./index";

/** The query parameter Xero Setup reads to open a wizard step directly. */
export const XERO_SETUP_STEP_PARAM = "step";

/** Shared by the wizard's step definition and every mapping shortcut (INV-SSOT). */
export const XERO_MAPPING_STEP_ID = "mapping";

/** Open account mapping, with the wizard clamping to any unfinished prerequisite. */
export function xeroMappingHref(): string {
  return `${adminHref("xero-setup")}?${XERO_SETUP_STEP_PARAM}=${XERO_MAPPING_STEP_ID}`;
}
