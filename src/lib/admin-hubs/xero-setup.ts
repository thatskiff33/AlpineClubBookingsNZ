import { adminHref } from "./index";

/** The query parameter Xero Setup reads to open a wizard step directly. */
export const XERO_SETUP_STEP_PARAM = "step";

/**
 * The wizard steps a shortcut opens. Each id is defined here once and used by the
 * wizard's step definition and by its shortcut below (INV-SSOT), so a renamed
 * step breaks a type or a test, not a link that quietly opens the first step.
 */
export const XERO_WEBHOOKS_STEP_ID = "webhooks";
export const XERO_MAPPING_STEP_ID = "mapping";

type XeroSetupLinkedStepId = typeof XERO_WEBHOOKS_STEP_ID | typeof XERO_MAPPING_STEP_ID;

function xeroSetupStepHref(stepId: XeroSetupLinkedStepId): string {
  return `${adminHref("xero-setup")}?${XERO_SETUP_STEP_PARAM}=${stepId}`;
}

/** Open account mapping, with the wizard clamping to any unfinished prerequisite. */
export function xeroMappingHref(): string {
  return xeroSetupStepHref(XERO_MAPPING_STEP_ID);
}

/** Open the webhooks step, with the wizard clamping to any unfinished prerequisite. */
export function xeroWebhooksHref(): string {
  return xeroSetupStepHref(XERO_WEBHOOKS_STEP_ID);
}
