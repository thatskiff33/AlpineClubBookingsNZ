/**
 * #4336: the live Xero side of the revived refund-note report
 * (`xero-revived-refund-note-report.ts`): a credentials preflight and the one
 * credit-note reader.
 *
 * The reader follows the credit-note mirror sweep (#4270): one `getCreditNote`
 * per note through the metered `callXeroApi`, outside any transaction, with
 * `armTransientBreaker: false`, so its failures never arm the outage pause.
 * That pause lives in memory, per process: the report's process and the
 * running app never see each other's, so the flag guards anything else this
 * process might do after a report read. A minute-limit 429 waits and retries
 * (`withXeroRetry`); a server error is not retried, it fails that note and
 * counts toward the walk's three-in-a-row stop. Xero's daily limit, the app's
 * deferrable share of it, and a lost connection end the walk
 * (`RevivedReportStop`).
 *
 * Writes: no booking, payment, credit, link or Xero record. Like every metered
 * Xero call, each read writes API-usage rows (`XeroApiUsageEvent`,
 * `XeroApiUsageDaily`). If the token needs refreshing, the shared client
 * (`getAuthenticatedXeroClient`) stores the new token, its refresh lease and a
 * credential audit row, and a failed refresh alerts the admins by email, as it
 * would for the app.
 */
import { getXeroErrorStatusCode } from "@/lib/xero-error-shape";
import { getOperationalXeroConfig } from "@/lib/xero-config";
import { getXeroTokenReadability, type XeroTokenReadability } from "@/lib/xero-token-store";
import { xeroDailyBudgetAllowsDeferrableCall } from "@/lib/xero-api-usage";
import { readString } from "@/lib/xero-json";
import { xeroInstant } from "@/lib/xero-provider-dates";
import {
  callXeroApi,
  getAuthenticatedXeroClient,
  XeroDailyLimitError,
  XeroReconnectRequiredError,
} from "@/lib/xero-api-client";
import { RevivedReportStop, type CreditNoteReader } from "@/lib/xero-revived-refund-note-report";

/** The workflow name on each usage row, so the meter shows what spent the calls. */
export const REVIVED_REFUND_NOTE_REPORT_WORKFLOW = "xeroRevivedRefundNoteReport";

/**
 * The read's retry options. Exported so the breaker test pins what the reader
 * actually passes. `armTransientBreaker: false` is the issue's requirement.
 */
export const REVIVED_REPORT_READ_OPTIONS = {
  maxRetries: 3,
  maxTransientRetries: 0,
  armTransientBreaker: false,
} as const;

/** Thrown by the preflight with a fixed sentence: it names no secret, value or path. */
export class XeroReportPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XeroReportPreflightError";
  }
}

export const XERO_UNREADABLE_HERE_MESSAGE =
  "Xero credentials can't be read here: run with the application's AUTH_SECRET and DATABASE_URL. See docs/MAINTENANCE.md, \"Find refund notes Xero voided that the app still counts (#4336)\".";

export const XERO_NOT_CONNECTED_MESSAGE =
  "Xero is not connected on this database, so there is nothing to ask. Check DATABASE_URL points at the right database, and that Xero is connected in the admin panel.";

/**
 * Before any link is walked: is Xero connected, and can this process read its
 * stored login and the app's client credentials? Both are encrypted under a key
 * rooted in `AUTH_SECRET`, so a shell without the app's secret cannot. Both
 * checks decrypt and discard; neither writes a row nor calls Xero.
 */
export async function assertXeroReadableHere(
  deps: {
    tokenReadability?: () => Promise<XeroTokenReadability>;
    clientConfig?: () => Promise<{ clientId: string; clientSecret: string }>;
  } = {},
): Promise<void> {
  const readability = await (deps.tokenReadability ?? getXeroTokenReadability)();
  if (readability === "no_tokens") throw new XeroReportPreflightError(XERO_NOT_CONNECTED_MESSAGE);
  if (readability === "unreadable") throw new XeroReportPreflightError(XERO_UNREADABLE_HERE_MESSAGE);
  const config = await (deps.clientConfig ?? getOperationalXeroConfig)();
  // An unreadable credential resolves to "": a token refresh could not authenticate.
  if (!config.clientId || !config.clientSecret) throw new XeroReportPreflightError(XERO_UNREADABLE_HERE_MESSAGE);
}

/** A failed read's description: the HTTP status only, never Xero's body, which can carry contact details. */
function describeReadFailure(error: unknown): string {
  const status = getXeroErrorStatusCode(error);
  return status !== undefined ? `Xero answered HTTP ${status}` : "no answer from Xero";
}

/** A read failure that ends the walk, or null for one that fails only this note. */
function stopFor(error: unknown): RevivedReportStop | null {
  if (error instanceof XeroDailyLimitError) {
    return new RevivedReportStop("daily-limit", "Xero's daily limit was reached; run the report again tomorrow.");
  }
  if (error instanceof XeroReconnectRequiredError) {
    return new RevivedReportStop("reconnect", "Xero needs reconnecting in the admin panel before the report can run.");
  }
  return null;
}

/**
 * The live reader. `budgetAllows` defaults to the app's deferrable-call budget
 * check, which leaves the last share of Xero's daily limit to the outbox and the
 * inbound sync.
 */
export function createXeroCreditNoteReader(
  deps: { budgetAllows?: () => Promise<boolean> } = {},
): CreditNoteReader {
  const budgetAllows = deps.budgetAllows ?? xeroDailyBudgetAllowsDeferrableCall;
  return async (creditNoteId) => {
    try {
      if (!(await budgetAllows())) {
        throw new RevivedReportStop("daily-limit", "The app's share of today's Xero calls is used up; run the report again tomorrow.");
      }
      const { xero, tenantId } = await getAuthenticatedXeroClient();
      const response = await callXeroApi(() => xero.accountingApi.getCreditNote(tenantId, creditNoteId), {
        operation: "getCreditNote",
        resourceType: "CREDIT_NOTE",
        workflow: REVIVED_REFUND_NOTE_REPORT_WORKFLOW,
        context: `${REVIVED_REFUND_NOTE_REPORT_WORKFLOW}(${creditNoteId})`,
        ...REVIVED_REPORT_READ_OPTIONS,
      });
      const note = response.body.creditNotes?.[0];
      if (!note?.creditNoteID) return null;
      return {
        status: readString(note.status),
        number: readString(note.creditNoteNumber),
        updatedAt: xeroInstant(note.updatedDateUTC),
      };
    } catch (error) {
      if (error instanceof RevivedReportStop) throw error;
      if (getXeroErrorStatusCode(error) === 404) return null;
      const stop = stopFor(error);
      if (stop) throw stop;
      throw new Error(describeReadFailure(error));
    }
  };
}
