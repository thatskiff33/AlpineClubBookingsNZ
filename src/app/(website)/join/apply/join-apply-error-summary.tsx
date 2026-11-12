"use client";

import { FocusedActionError } from "@/components/focused-action-error";
import { focusAndKeepInView } from "@/hooks/use-scroll-to-feedback";
import { labelFieldMessages } from "@/lib/format-validation-errors";

/*
  #4947 — the membership application's one form-level message. A failed submit
  always lands here: the browser's own checks, a server refusal with field
  details, or a failure with none. It is the form's only `role="alert"`, and it
  is permanently mounted (`FocusedActionError`), so the live region exists
  before it is filled and every failed submit takes focus here.

  The server's keys need not match the page's slots: `flatten()` files every
  household problem under a bare `familyMembers`, and the phone row had no
  slot at all. So EVERY server message is listed here, with a link only when
  its key names an input that is always on the page. Nothing a server says is
  dropped. The address inputs sit in an accordion that unmounts a closed
  section, so an address message is listed without a link.

  The entries are a snapshot taken at the submit and never change while the
  person types: the region is atomic, and any change would be re-announced.
*/

const JOIN_APPLY_ERROR_ID = "join-apply-error";

export type JoinApplySummaryEntry = { fieldId?: string; text: string };

/** Fields whose input id is the field's own name. */
const SELF_ID_FIELDS = new Set([
  "applicantFirstName",
  "applicantLastName",
  "applicantEmail",
  "applicantDateOfBirth",
  "phoneCountryCode",
  "phoneAreaCode",
  "phoneNumber",
  "nominator1Email",
  "nominator2Email",
]);

const FAMILY_FIELD_ID_PREFIXES = {
  firstName: "family-first-name",
  lastName: "family-last-name",
  dateOfBirth: "family-dob",
} as const;

type FamilyField = keyof typeof FAMILY_FIELD_ID_PREFIXES;

/** The id of a household member's input; the page and the links share it. */
export function familyMemberInputId(index: number, field: FamilyField) {
  return `${FAMILY_FIELD_ID_PREFIXES[field]}-${index}`;
}

function isFamilyField(field: string): field is FamilyField {
  return Object.hasOwn(FAMILY_FIELD_ID_PREFIXES, field);
}

/** The id of the input a field key names, or `undefined` when none does. */
function joinApplyInputId(key: string): string | undefined {
  if (SELF_ID_FIELDS.has(key)) return key;
  const [, row, field] = /^familyMembers\.(\d+)\.(\w+)$/.exec(key) ?? [];
  return row && field && isFamilyField(field)
    ? familyMemberInputId(Number(row), field)
    : undefined;
}

/** The browser's own checks, in the order the map holds them (form order). */
export function clientSummaryEntries(
  errors: Readonly<Record<string, string | undefined>>,
): JoinApplySummaryEntry[] {
  return Object.entries(errors).flatMap(([key, text]) =>
    text ? [{ fieldId: joinApplyInputId(key), text }] : [],
  );
}

/** Every server field message, each under its label, linked where it can be. */
export function serverSummaryEntries(
  details: ReadonlyArray<readonly [string, readonly string[]]>,
): JoinApplySummaryEntry[] {
  return details.map(([key, messages]) => ({
    fieldId: joinApplyInputId(key),
    text: labelFieldMessages(key, messages),
  }));
}

function fieldCountSentence(count: number) {
  return count === 1
    ? "1 field needs attention."
    : `${count} fields need attention.`;
}

export function JoinApplyErrorSummary({
  message,
  entries,
  attentionKey,
}: {
  /** A failure with no field details: the route's own sentence. */
  message: string;
  entries: readonly JoinApplySummaryEntry[];
  /** Rises once per failed submit, so an identical failure re-focuses. */
  attentionKey: number;
}) {
  const hasEntries = entries.length > 0;
  return (
    <FocusedActionError
      id={JOIN_APPLY_ERROR_ID}
      className="w-full"
      error={hasEntries ? fieldCountSentence(entries.length) : message}
      attentionKey={attentionKey}
      action={
        hasEntries ? (
          <ul className="list-disc space-y-1 pl-5">
            {entries.map((entry, index) => (
              <li key={`${entry.fieldId ?? "form"}-${index}`}>
                {entry.fieldId ? (
                  <a
                    href={`#${entry.fieldId}`}
                    className="underline underline-offset-2"
                    onClick={(event) => {
                      const control = document.getElementById(entry.fieldId ?? "");
                      if (!control) return;
                      event.preventDefault();
                      focusAndKeepInView(control);
                    }}
                  >
                    {entry.text}
                  </a>
                ) : (
                  entry.text
                )}
              </li>
            ))}
          </ul>
        ) : undefined
      }
    />
  );
}
