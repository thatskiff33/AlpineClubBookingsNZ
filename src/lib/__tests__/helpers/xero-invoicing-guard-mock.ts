/**
 * A stand-in for `@/lib/xero-invoicing-guard` (#4986), so suites that mock
 * Prisma need not also fake the module-settings read. Xero reads as ON unless
 * a test turns it off:
 *
 *   vi.mock("@/lib/xero-invoicing-guard", () =>
 *     import("@/lib/__tests__/helpers/xero-invoicing-guard-mock"),
 *   );
 *   setXeroInvoicingEnabled(false); // reset with setXeroInvoicingEnabled(true)
 *
 * Plain functions, not `vi.fn`, so a suite's `vi.resetAllMocks()` cannot strip
 * the behaviour. The refusal is the real `XeroInvoicingOffError`.
 */
import { XeroInvoicingOffError } from "@/lib/xero-invoicing-off";

let enabled = true;

export function setXeroInvoicingEnabled(value: boolean): void {
  enabled = value;
}

export async function isXeroInvoicingEnabled(): Promise<boolean> {
  return enabled;
}

export async function assertSubscriptionInvoicingEnabled(): Promise<void> {
  if (!enabled) throw new XeroInvoicingOffError();
}
