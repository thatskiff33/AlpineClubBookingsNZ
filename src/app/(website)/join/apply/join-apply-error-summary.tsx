"use client";

import { FocusedActionError } from "@/components/focused-action-error";
import { focusAndKeepInView } from "@/hooks/use-scroll-to-feedback";
import {
  labelFieldMessages,
  type readValidationDetails,
} from "@/lib/format-validation-errors";
import { joinApplyInputId } from "./join-apply-input-ids";

/*
  #4947 — the membership application's one form-level message. A failed submit
  always lands here: the browser's own checks, a server refusal with field
  details, or a failure with none. It is the form's only `role="alert"`, and it
  is permanently mounted (`FocusedActionError`), so the live region exists
  before it is filled and every failed submit takes focus here.

  The server's keys need not match the page's slots: `flatten()` files every
  household problem under a bare `familyMembers`, and the phone row had no
  slot at all. So EVERY server message is listed here (a field's, and a
  form-level one that names no field), with a link only when its key names an
  input that is always on the page. The address inputs sit in an accordion that
  unmounts a closed section, so an address message is listed without a link.

  The entries are a snapshot taken at the submit and never change while the
  person types: the region is atomic, and any change would be re-announced.
*/

const JOIN_APPLY_ERROR_ID = "join-apply-error";

/**
 * One line of the summary; `fieldId` is the input it links to, if any, and
 * `formLevel` marks a message that is about no field, so it is not counted as
 * one.
 */
export type JoinApplySummaryEntry = {
  fieldId: string | null;
  text: string;
  formLevel?: true;
};

/**
 * The browser's own checks, in the order the map holds them (form order).
 * `familyMemberIds` is the household at the submit, which the keys count
 * through by position.
 */
export function clientSummaryEntries(
  errors: Readonly<Record<string, string | undefined>>,
  familyMemberIds: readonly string[],
): JoinApplySummaryEntry[] {
  return Object.entries(errors).flatMap(([key, text]) =>
    text ? [{ fieldId: joinApplyInputId(key, familyMemberIds), text }] : [],
  );
}

/**
 * Everything a server refusal reports: its form-level messages first (they
 * name no field), then each field's messages under its label, linked where
 * the field has an input.
 */
export function serverSummaryEntries(
  details: NonNullable<ReturnType<typeof readValidationDetails>>,
  familyMemberIds: readonly string[],
): JoinApplySummaryEntry[] {
  return [
    ...details.formErrors.map((text) => ({
      fieldId: null,
      text,
      formLevel: true as const,
    })),
    ...details.fieldErrors.map(([key, messages]) => ({
      fieldId: joinApplyInputId(key, familyMemberIds),
      text: labelFieldMessages(key, messages),
    })),
  ];
}

/** The heading: how many fields need attention, or a plain sentence when only form-level messages follow. */
function headingFor(entries: readonly JoinApplySummaryEntry[]) {
  const fields = entries.filter((entry) => !entry.formLevel).length;
  if (fields === 0) return "Your application could not be submitted.";
  return fields === 1
    ? "1 field needs attention."
    : `${fields} fields need attention.`;
}

/**
 * The input a link names, looked up inside the link's own form first: a CMS
 * page can embed this form twice, and `getElementById` would answer with the
 * first form's input.
 */
function inputNamedBy(link: HTMLElement, id: string): HTMLElement | null {
  const inOwnForm = Array.from(
    link.closest("form")?.querySelectorAll<HTMLElement>("[id]") ?? [],
  ).find((element) => element.id === id);
  return inOwnForm ?? document.getElementById(id);
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
      error={hasEntries ? headingFor(entries) : message}
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
                      const input = inputNamedBy(
                        event.currentTarget,
                        entry.fieldId ?? "",
                      );
                      if (!input) return;
                      event.preventDefault();
                      focusAndKeepInView(input);
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
