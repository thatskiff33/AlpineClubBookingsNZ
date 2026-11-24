/**
 * The outbox payload for sending a school's corrected email address and phone
 * number to its Xero contact (#5245).
 *
 * A leaf so the payload registry can recognise the queue type without taking
 * the worker, and so the registry file stays inside its size budget.
 *
 * The payload carries the queue type and nothing else. The school is the row's
 * own anchor (`localModel: "Organisation"`, `localId`), never a stored id the
 * persisting redactor could blank (`INV-INT-026`), and the details themselves
 * are read fresh when the row runs, so a retry always sends what the club holds
 * now rather than what it held when the row was queued.
 */
import { asRecord } from "@/lib/xero-json";

export const XERO_OUTBOX_ORGANISATION_CONTACT_DETAILS_TYPE = "ORGANISATION_CONTACT_DETAILS" as const;

/** The local model every school contact row anchors on. */
const ORGANISATION_LOCAL_MODEL = "Organisation";

export interface OrganisationContactDetailsPayload {
  queueType: typeof XERO_OUTBOX_ORGANISATION_CONTACT_DETAILS_TYPE;
}

export function buildOrganisationContactDetailsPayload(): OrganisationContactDetailsPayload {
  return { queueType: XERO_OUTBOX_ORGANISATION_CONTACT_DETAILS_TYPE };
}

export function readOrganisationContactDetailsPayload(
  value: unknown,
): OrganisationContactDetailsPayload | null {
  const payload = asRecord(value);
  return payload?.queueType === XERO_OUTBOX_ORGANISATION_CONTACT_DETAILS_TYPE
    ? buildOrganisationContactDetailsPayload()
    : null;
}

/** The school a contact-details row is for: its anchor, or none. */
export function organisationContactDetailsOrganisationId(op: {
  localModel: string | null;
  localId: string | null;
}): string | null {
  return op.localModel === ORGANISATION_LOCAL_MODEL ? op.localId : null;
}

/**
 * The retry's label for a contact-details row, or null for any other row. Its
 * retry hands the row back to the outbox with its stored payload, which holds
 * no details: they are read fresh when it runs again.
 */
export function organisationContactDetailsRetryLabel(op: { queueType?: string | null }): string | null {
  return op.queueType === XERO_OUTBOX_ORGANISATION_CONTACT_DETAILS_TYPE ? "school contact details" : null;
}
