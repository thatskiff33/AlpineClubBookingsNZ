/**
 * Shared admin-member Xero action wrappers.
 *
 * Both the admin members list (`/admin/members`) and member detail
 * (`/admin/members/[id]`) pages call the same four Xero contact
 * endpoints — search, link, unlink, push (create) — with the same
 * request and response shapes. The pages keep their own state
 * machines and copy because the UX diverges, but the network calls
 * live here so the request/response contract stays in one place.
 *
 * Each function throws an `Error` with the server-provided message
 * when the response is not ok. Callers convert that into the local
 * error display (formError / xeroError / xeroDecisionError etc.).
 */
import type { XeroSearchResult } from "@/components/admin/xero-suggested-contact-card";
import type { XeroPartialSuccessKind } from "@/lib/xero-partial-success";
import { apiErrorMessageFromBody, readApiErrorBody } from "@/lib/api-error-message";

interface XeroEntranceFeeInvoicePushOptions {
  createEntranceFeeInvoice: boolean;
  entranceFeeInvoiceDecision?: "CREATE" | "SKIP";
  entranceFeeInvoiceSkipReason?: string;
  entranceFeeInvoiceAmountCents?: number;
  entranceFeeInvoiceNarration?: string;
}

export interface XeroPushOptions extends XeroEntranceFeeInvoicePushOptions {
  forceCreate?: boolean;
}

export interface XeroPushResponse {
  xeroContactId: string;
  xeroLink?: string;
  entranceFeeInvoiceQueued?: boolean;
  entranceFeeInvoiceMessage?: string;
  warning?: string;
  // Member detail returns additional fields the list page ignores; allow them through.
  [key: string]: unknown;
}

export type XeroPushResult =
  | { status: "created"; data: XeroPushResponse }
  | { status: "needsDecision"; suggestedContacts: XeroSearchResult[] };

export interface XeroLinkResponse {
  contactName?: string;
  [key: string]: unknown;
}

export interface XeroActionRecovery {
  recoveryKind?: XeroPartialSuccessKind;
  xeroLinkMayHaveChanged?: boolean;
  xeroContactCreated?: boolean;
  xeroContactLinked?: boolean;
  xeroContactUnlinked?: boolean;
  xeroContactId?: string;
  memberImported?: boolean;
  memberId?: string;
  subscriptionRefreshPending?: boolean;
  subscriptionCleanupPending?: boolean;
  /** #2623 T3: the member's CONTACT ledger rows may still be ACTIVE. */
  contactLinkRowsMayRemainActive?: boolean;
  /** #2623 T3: the action's audit entry may never have been written. */
  auditEntryMayBeMissing?: boolean;
  xeroPostProcessingPending?: boolean;
}

export class AdminMemberXeroActionError extends Error {
  readonly recovery: XeroActionRecovery;

  constructor(message: string, recovery: XeroActionRecovery = {}) {
    super(message);
    this.name = "AdminMemberXeroActionError";
    this.recovery = recovery;
  }
}

export const MEMBER_XERO_NETWORK_ERROR =
  "The service could not be reached. Your selections are still here. Check the member and Xero status, then try again.";

async function fetchXeroAction(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  try {
    return init === undefined ? await fetch(input) : await fetch(input, init);
  } catch {
    throw new AdminMemberXeroActionError(MEMBER_XERO_NETWORK_ERROR);
  }
}

async function readActionError(
  res: Response,
  fallback: string,
): Promise<AdminMemberXeroActionError> {
  const data = await readApiErrorBody(res);
  const message = apiErrorMessageFromBody(data, fallback);
  return typeof data === "object" && data !== null
    ? new AdminMemberXeroActionError(message, readRecovery(data as XeroActionRecovery))
    : new AdminMemberXeroActionError(message);
}

function readRecovery(data: XeroActionRecovery): XeroActionRecovery {
  return {
    ...(data.recoveryKind ? { recoveryKind: data.recoveryKind } : {}),
    ...(data.xeroLinkMayHaveChanged
      ? { xeroLinkMayHaveChanged: true }
      : {}),
    ...(data.xeroContactCreated ? { xeroContactCreated: true } : {}),
    ...(data.xeroContactLinked ? { xeroContactLinked: true } : {}),
    ...(data.xeroContactUnlinked ? { xeroContactUnlinked: true } : {}),
    ...(data.xeroContactId ? { xeroContactId: data.xeroContactId } : {}),
    ...(data.memberImported ? { memberImported: true } : {}),
    ...(data.memberId ? { memberId: data.memberId } : {}),
    ...(data.subscriptionRefreshPending
      ? { subscriptionRefreshPending: true }
      : {}),
    ...(data.subscriptionCleanupPending
      ? { subscriptionCleanupPending: true }
      : {}),
    ...(data.contactLinkRowsMayRemainActive
      ? { contactLinkRowsMayRemainActive: true }
      : {}),
    ...(data.auditEntryMayBeMissing ? { auditEntryMayBeMissing: true } : {}),
    ...(data.xeroPostProcessingPending
      ? { xeroPostProcessingPending: true }
      : {}),
  };
}

/**
 * Search Xero contacts by free-text query. Returns the raw contact list
 * including contacts already linked to other members; callers filter as
 * needed.
 */
export async function searchXeroContacts(query: string): Promise<XeroSearchResult[]> {
  const res = await fetchXeroAction(
    `/api/admin/xero/search-contacts?q=${encodeURIComponent(query)}`,
  );
  if (!res.ok) {
    throw await readActionError(res, "Failed to search Xero contacts");
  }
  const data = (await res.json()) as { contacts?: XeroSearchResult[] };
  return data.contacts ?? [];
}

/**
 * Link a local member to an existing Xero contact.
 */
export async function linkMemberXeroContact(
  memberId: string,
  xeroContactId: string,
): Promise<XeroLinkResponse> {
  const res = await fetchXeroAction(`/api/admin/members/${memberId}/xero-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ xeroContactId }),
  });
  if (!res.ok) {
    throw await readActionError(res, "Failed to link Xero contact");
  }
  return (await res.json().catch(() => ({}))) as XeroLinkResponse;
}

/**
 * Unlink a local member from its Xero contact.
 */
export async function unlinkMemberXeroContact(memberId: string): Promise<void> {
  const res = await fetchXeroAction(`/api/admin/members/${memberId}/xero-unlink`, {
    method: "POST",
  });
  if (!res.ok) {
    throw await readActionError(res, "Failed to unlink Xero contact");
  }
}

/**
 * Push a local member to Xero as a new contact.
 *
 * Returns `{ status: "needsDecision" }` when the server replies 409 with
 * suggested existing matches; the caller shows the decision UI and may
 * retry with `forceCreate: true` or call `linkMemberXeroContact` with a
 * chosen contact ID.
 */
export async function pushMemberToXero(
  memberId: string,
  options: XeroPushOptions,
): Promise<XeroPushResult> {
  const res = await fetchXeroAction(`/api/admin/members/${memberId}/xero-push`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      createEntranceFeeInvoice: Boolean(options.createEntranceFeeInvoice),
      entranceFeeInvoiceDecision: options.entranceFeeInvoiceDecision,
      entranceFeeInvoiceSkipReason: options.entranceFeeInvoiceSkipReason,
      entranceFeeInvoiceAmountCents: options.entranceFeeInvoiceAmountCents,
      entranceFeeInvoiceNarration: options.entranceFeeInvoiceNarration,
      forceCreate: Boolean(options.forceCreate),
    }),
  });
  const data = (await res.json().catch(() => ({}))) as
    | (XeroPushResponse &
        XeroActionRecovery & {
          error?: string;
          suggestedContacts?: XeroSearchResult[];
        });

  if (res.status === 409 && Array.isArray(data.suggestedContacts)) {
    return { status: "needsDecision", suggestedContacts: data.suggestedContacts };
  }

  if (!res.ok) {
    throw new AdminMemberXeroActionError(
      apiErrorMessageFromBody(data, "Failed to create Xero contact"),
      readRecovery(data),
    );
  }

  return { status: "created", data };
}
