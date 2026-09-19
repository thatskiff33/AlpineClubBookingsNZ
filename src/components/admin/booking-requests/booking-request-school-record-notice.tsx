"use client";

/**
 * WHICH SCHOOL IS THIS? — the notice under the correction form's name field
 * (#2936), and the tick that lets Save arm.
 *
 * Split out of `booking-request-correction-editor.tsx` because it is a
 * self-contained answer to one question that happens to be the most
 * consequential on that form: since #3367 a school request resolves to the
 * club's own record of the school, and that record owns its Xero customer, so
 * the name decides WHICH SCHOOL THE CLUB IS ABOUT TO INVOICE.
 *
 * The tick is not a formality. The server re-asks this question under its own
 * lock and refuses any answer but the one confirmed here, so an officer cannot
 * create a second record for a school the club already has — or quietly move
 * this booking onto another school's accounting customer — without having read
 * which of the two they were doing. That is also why a lookup that FAILED is a
 * state of its own rather than a silent fall back to "still checking": saving
 * stays blocked, and the officer is given something to press.
 */

import { Button } from "@/components/ui/button";

export type SchoolRecord = {
  normalisedName: string;
  known: boolean;
  schoolRecordId: string | null;
  schoolRecordName: string | null;
  schoolRecordArchived: boolean;
  schoolRecordHasXeroCustomer: boolean;
  currentContactNames: string[];
  currentContactNamesTruncated: boolean;
};

/**
 * What the typed school name resolves to, and the tick that lets Save arm.
 *
 * The tick is not a formality: the server re-asks this question under its own
 * lock and refuses any answer but the one confirmed here, so an officer cannot
 * create a second record for a school the club already has — or quietly move
 * this booking onto another school's accounting customer — without having read
 * which of the two they were doing.
 */
export function SchoolRecordNotice(props: {
  record: SchoolRecord | null;
  /** The lookup came back an error, or never came back at all. */
  failed: boolean;
  /** There is a name in the box to look up. */
  nameEntered: boolean;
  onRetry: () => void;
  confirmed: boolean;
  onConfirm: (value: boolean) => void;
  requestId: string;
}) {
  const { record } = props;
  if (!props.nameEntered) {
    return (
      <p className="text-xs text-muted-foreground">
        Type the school&apos;s name and we will tell you which school on record
        it is.
      </p>
    );
  }
  if (props.failed) {
    return (
      <div className="space-y-2 rounded-md border border-warning-6 bg-warning-2 p-2 text-xs">
        <p>
          We could not check which school this is, so saving is held until we
          can — the name decides which school gets invoiced, and that is not a
          question to answer blind.
        </p>
        <Button type="button" size="sm" variant="outline" onClick={props.onRetry}>
          Try again
        </Button>
      </div>
    );
  }
  if (!record) {
    return (
      <p className="text-xs text-muted-foreground">
        Checking which school this is…
      </p>
    );
  }
  const id = `correct-school-confirm-${props.requestId}`;
  return (
    <div className="space-y-2 rounded-md border bg-muted p-2 text-xs">
      {record.known ? (
        <>
          <p>
            The club already has <strong>{record.schoolRecordName}</strong> on
            record{record.schoolRecordArchived ? " (archived)" : ""}. Approving
            this booking will invoice that school
            {record.schoolRecordHasXeroCustomer
              ? ", using the accounting customer it already has"
              : ""}
            .
          </p>
          {record.currentContactNames.length > 0 ? (
            <p>
              The people it names today are{" "}
              {record.currentContactNames.join(", ")}
              {record.currentContactNamesTruncated
                ? ", and more it has recorded but does not name"
                : ""}{" "}
              — approving will replace them with the teachers above.
            </p>
          ) : null}
        </>
      ) : (
        <p>
          The club has no school on record called{" "}
          <strong>{record.normalisedName}</strong>. Approving this booking will
          add it as a new school, with a new accounting customer of its own. If
          it is a school you already deal with, check the spelling first.
        </p>
      )}
      <label className="flex items-start gap-2" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          className="mt-0.5"
          checked={props.confirmed}
          onChange={(event) => props.onConfirm(event.target.checked)}
        />
        <span>
          {record.known
            ? "Yes, this is that school."
            : "Yes, add it as a new school."}
        </span>
      </label>
    </div>
  );
}
