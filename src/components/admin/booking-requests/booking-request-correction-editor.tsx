"use client";

/**
 * CORRECT THIS REQUEST — the officer's form for #2936.
 *
 * A self-contained editor, in the shape `booking-request-contact-picker.tsx`
 * established for this panel: the card owns nothing but whether it is open, and
 * every rule is the server's. It is mounted INSIDE the panel's `canEdit` block,
 * so a view-only admin never sees it and the panel's one
 * `AdminViewOnlySectionBanner` already explains why — there is no second banner
 * and no per-button reason here.
 *
 * Two things on this form are not ordinary fields, and the copy says so on the
 * screen rather than only here:
 *
 *   - **the school's name decides which school gets invoiced.** Since #3367 a
 *     school request resolves to the club's own record of that school, and that
 *     record owns its Xero customer. So the form asks the server which record
 *     the typed name claims, shows the answer, and will not enable Save until
 *     the officer has confirmed it. The server re-asks under its lock and
 *     refuses anything else, so the confirmation is a real fence and not a
 *     courtesy tick.
 *   - **the teachers become the school's contact people.** Approving replaces
 *     the people the club currently shows for that school with this booking's
 *     teachers, so the form names who would be replaced before it happens.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { BOOKABLE_AGE_TIER_VALUES } from "@/lib/age-tier-schema";
import { dateOnlyFromIsoString } from "@/lib/date-only";

const CHILD_TIERS = ["INFANT", "CHILD", "YOUTH"] as const;
const CHILD_TIER_LABELS: Record<(typeof CHILD_TIERS)[number], string> = {
  INFANT: "Infants",
  CHILD: "Children",
  YOUTH: "Youth",
};
const CATERING_LABELS: Record<string, string> = {
  CATERED: "Catered",
  NON_CATERED: "Non-catered",
  QUOTE_BOTH: "Quote both",
};

/** Everything the form reads off a request. A subset of the panel's own DTO. */
export type CorrectableBookingRequest = {
  id: string;
  type: string;
  version: number;
  checkIn: string;
  checkOut: string;
  contactFirstName: string;
  contactLastName: string;
  contactEmail: string;
  contactPhone: string | null;
  schoolName: string | null;
  teachers: Array<{ firstName: string; lastName: string; email: string | null }>;
  cateringPreference: "CATERED" | "NON_CATERED" | "QUOTE_BOTH" | null;
  guests: Array<{ firstName: string; lastName: string; ageTier: string }>;
  heldBookingId: string | null;
  /**
   * #2936: the admin-made "this guest IS this member" links, which are keyed by
   * POSITION in the guest list above. Correcting the party rewrites that list,
   * so the server clears them and the form says so before the officer saves.
   */
  linkedGuestMembers: Array<{ guestIndex: number; memberId: string }>;
};

type SchoolRecord = {
  normalisedName: string;
  known: boolean;
  schoolRecordId: string | null;
  schoolRecordName: string | null;
  schoolRecordArchived: boolean;
  schoolRecordHasXeroCustomer: boolean;
  currentContactNames: string[];
  currentContactNamesTruncated: boolean;
};

type TeacherDraft = { firstName: string; lastName: string; email: string };
type GuestDraft = { firstName: string; lastName: string; ageTier: string };

function childCountsOf(guests: CorrectableBookingRequest["guests"]) {
  return CHILD_TIERS.reduce<Record<string, number>>((counts, tier) => {
    counts[tier] = guests.filter((guest) => guest.ageTier === tier).length;
    return counts;
  }, {});
}

export function BookingRequestCorrectionEditor(props: {
  request: CorrectableBookingRequest;
  disabled: boolean;
  /** Re-pull the canonical server state. The panel's own `fetchRequests`. */
  onCorrected: (summary: string) => void;
  onError: (message: string) => void;
}) {
  const { request, disabled } = props;
  const isSchool = request.type === "SCHOOL";
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [contact, setContact] = useState({ first: "", last: "", email: "", phone: "" });
  const [schoolName, setSchoolName] = useState("");
  const [teachers, setTeachers] = useState<TeacherDraft[]>([]);
  const [childCounts, setChildCounts] = useState<Record<string, number>>({});
  const [catering, setCatering] = useState("QUOTE_BOTH");
  const [guests, setGuests] = useState<GuestDraft[]>([]);
  const [reason, setReason] = useState("");
  const [schoolRecord, setSchoolRecord] = useState<SchoolRecord | null>(null);
  const [schoolRecordConfirmed, setSchoolRecordConfirmed] = useState(false);
  /**
   * The row version the fields below were SEEDED from — not the one the panel
   * happens to be holding when Save is pressed.
   *
   * The whole point of the fence is "refuse a correction written over a request
   * something else has moved", and the fields are a snapshot taken when the
   * form opened. This card lives inside a queue that refetches on ANY action
   * anywhere in it, so `request.version` advances underneath an open form
   * routinely. Reading it at save time handed the server the NEW version with
   * the OLD fields, which passes every fence there is and silently clobbers
   * whatever moved the row — including a second officer's correction.
   */
  const [seededVersion, setSeededVersion] = useState(request.version);
  const [lookupFailed, setLookupFailed] = useState(false);
  const [lookupAttempt, setLookupAttempt] = useState(0);
  const nameLookup = useRef(0);

  /** Re-seed every field from the request the server last gave us. */
  const reset = useCallback(() => {
    setSeededVersion(request.version);
    setLookupFailed(false);
    setCheckIn(dateOnlyFromIsoString(request.checkIn));
    setCheckOut(dateOnlyFromIsoString(request.checkOut));
    setContact({
      first: request.contactFirstName,
      last: request.contactLastName,
      email: request.contactEmail,
      phone: request.contactPhone ?? "",
    });
    setSchoolName(request.schoolName ?? "");
    setTeachers(
      request.teachers.map((teacher) => ({
        firstName: teacher.firstName,
        lastName: teacher.lastName,
        email: teacher.email ?? "",
      })),
    );
    setChildCounts(childCountsOf(request.guests));
    setCatering(request.cateringPreference ?? "QUOTE_BOTH");
    setGuests(request.guests.map((guest) => ({ ...guest })));
    setReason("");
    setSchoolRecord(null);
    setSchoolRecordConfirmed(false);
  }, [request]);

  // Ask the server which school record the typed name claims. Debounced, and
  // sequenced by a token so a slow earlier answer can never overwrite a later
  // one — the whole point is that the confirmation describes what is in the box
  // NOW.
  useEffect(() => {
    if (!open || !isSchool) return;
    const typed = schoolName.trim();
    setSchoolRecordConfirmed(false);
    setLookupFailed(false);
    if (!typed) {
      setSchoolRecord(null);
      return;
    }
    const token = ++nameLookup.current;
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/admin/booking-requests/${request.id}/school-record?name=${encodeURIComponent(typed)}`,
        );
        const data = await response.json().catch(() => ({}));
        if (token !== nameLookup.current) return;
        // A lookup that FAILED is not a lookup still running. Without this the
        // card said "Checking which school this is…" for ever, with Save
        // disabled and nothing to press — and the officer's only way out was to
        // reload the queue.
        if (!response.ok) {
          setSchoolRecord(null);
          setLookupFailed(true);
          return;
        }
        setSchoolRecord(data.schoolRecord as SchoolRecord);
      } catch {
        if (token !== nameLookup.current) return;
        setSchoolRecord(null);
        setLookupFailed(true);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [open, isSchool, schoolName, request.id, lookupAttempt]);

  async function save() {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        expectedVersion: seededVersion,
        reason,
        checkIn,
        checkOut,
        contactFirstName: contact.first,
        contactLastName: contact.last,
        contactEmail: contact.email,
        contactPhone: contact.phone || null,
      };
      if (isSchool) {
        body.school = {
          schoolName,
          teachers: teachers
            .filter((teacher) => teacher.firstName.trim() && teacher.lastName.trim())
            .map((teacher) => ({
              firstName: teacher.firstName.trim(),
              lastName: teacher.lastName.trim(),
              email: teacher.email.trim() || null,
            })),
          childCounts: CHILD_TIERS.reduce<Record<string, number>>((counts, tier) => {
            counts[tier] = Number(childCounts[tier] ?? 0);
            return counts;
          }, {}),
          cateringPreference: catering,
          schoolRecord: schoolRecord?.known
            ? { outcome: "existing", schoolRecordId: schoolRecord.schoolRecordId }
            : { outcome: "new" },
        };
      } else {
        body.guests = guests.map((guest) => ({
          firstName: guest.firstName.trim(),
          lastName: guest.lastName.trim(),
          ageTier: guest.ageTier,
        }));
      }

      const response = await fetch(
        `/api/admin/booking-requests/${request.id}/correct`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        // A correction that saved but could not free its beds is NOT a failed
        // save, and saying so is the difference between the officer re-typing
        // it and the officer releasing the hold.
        props.onError(data.error || "Could not correct this request");
        if (data.corrected) {
          setOpen(false);
          props.onCorrected("Correction saved; check this request's held beds");
        }
        return;
      }
      const parts = [
        "Request corrected — re-price and re-quote it",
        data.supersededQuoteCount ? "the previous quote was withdrawn" : null,
        // The links went with the party they were keyed to. Said out loud,
        // because a guest who quietly stopped being a member is priced and
        // invoiced as a stranger.
        data.clearedMemberLinkCount
          ? `${data.clearedMemberLinkCount} member ${
              data.clearedMemberLinkCount === 1 ? "link was" : "links were"
            } cleared — link them again before quoting`
          : null,
        data.holdOutcome === "released" ? "held beds released" : null,
        data.availability && data.availability.available === false
          ? "the lodge is full on some of the new nights"
          : null,
      ].filter(Boolean);
      setOpen(false);
      props.onCorrected(parts.join("; "));
    } catch (err) {
      props.onError(
        err instanceof Error ? err.message : "Could not correct this request",
      );
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <div className="rounded-md border border-dashed border-border p-3 text-sm">
        <p className="text-muted-foreground">
          Something in this request wrong? Correct the dates, the group or the
          contact details here instead of declining it and asking them to start
          again.
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="mt-2"
          disabled={disabled}
          onClick={() => {
            reset();
            setOpen(true);
          }}
        >
          Correct this request
        </Button>
      </div>
    );
  }

  const saveBlocked =
    saving ||
    disabled ||
    !reason.trim() ||
    !checkIn ||
    !checkOut ||
    (isSchool && (!schoolName.trim() || !schoolRecord || !schoolRecordConfirmed));

  return (
    <div className="space-y-4 rounded-md border border-warning-6 p-3 text-sm">
      <div>
        <p className="font-medium">Correct this request</p>
        <p className="text-xs text-muted-foreground">
          Saving re-opens the request: any quote already sent is withdrawn and
          the price is cleared. Re-price and re-quote from the corrected
          details.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`correct-in-${request.id}`}>Check-in</Label>
          <Input
            id={`correct-in-${request.id}`}
            type="date"
            value={checkIn}
            onChange={(event) => setCheckIn(event.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`correct-out-${request.id}`}>Check-out</Label>
          <Input
            id={`correct-out-${request.id}`}
            type="date"
            value={checkOut}
            onChange={(event) => setCheckOut(event.target.value)}
          />
        </div>
      </div>

      {isSchool ? (
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor={`correct-school-${request.id}`}>School name</Label>
            <Input
              id={`correct-school-${request.id}`}
              value={schoolName}
              onChange={(event) => setSchoolName(event.target.value)}
            />
            <SchoolRecordNotice
              record={schoolRecord}
              failed={lookupFailed}
              nameEntered={Boolean(schoolName.trim())}
              onRetry={() => setLookupAttempt((attempt) => attempt + 1)}
              confirmed={schoolRecordConfirmed}
              onConfirm={setSchoolRecordConfirmed}
              requestId={request.id}
            />
          </div>

          <div className="space-y-2">
            <Label>Teachers and parent helpers</Label>
            <p className="text-xs text-muted-foreground">
              Approving this booking makes these people the school&apos;s current
              contacts, and the school&apos;s accounting record is refreshed from
              them — it names the most recently recorded few. Anyone the school
              no longer sends should come off the list here.
            </p>
            {teachers.map((teacher, index) => (
              <div key={index} className="grid gap-2 sm:grid-cols-4">
                <Input
                  aria-label={`Teacher ${index + 1} first name`}
                  placeholder="First name"
                  value={teacher.firstName}
                  onChange={(event) =>
                    setTeachers((prev) =>
                      prev.map((row, i) =>
                        i === index ? { ...row, firstName: event.target.value } : row,
                      ),
                    )
                  }
                />
                <Input
                  aria-label={`Teacher ${index + 1} last name`}
                  placeholder="Last name"
                  value={teacher.lastName}
                  onChange={(event) =>
                    setTeachers((prev) =>
                      prev.map((row, i) =>
                        i === index ? { ...row, lastName: event.target.value } : row,
                      ),
                    )
                  }
                />
                <Input
                  aria-label={`Teacher ${index + 1} email`}
                  placeholder="Email (optional)"
                  value={teacher.email}
                  onChange={(event) =>
                    setTeachers((prev) =>
                      prev.map((row, i) =>
                        i === index ? { ...row, email: event.target.value } : row,
                      ),
                    )
                  }
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setTeachers((prev) => prev.filter((_, i) => i !== index))
                  }
                >
                  Remove
                </Button>
              </div>
            ))}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                setTeachers((prev) => [
                  ...prev,
                  { firstName: "", lastName: "", email: "" },
                ])
              }
            >
              Add a teacher
            </Button>
          </div>

          <div className="space-y-1">
            <Label>Children attending</Label>
            <p className="text-xs text-muted-foreground">
              These change the request itself — what the school asked for. The
              &ldquo;Adjust group numbers&rdquo; boxes further down change only
              the booking you are about to quote or approve.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            {CHILD_TIERS.map((tier) => (
              <div key={tier} className="space-y-1">
                <Label
                  htmlFor={`correct-count-${tier}-${request.id}`}
                  className="text-xs text-muted-foreground"
                >
                  {CHILD_TIER_LABELS[tier]}
                </Label>
                <Input
                  id={`correct-count-${tier}-${request.id}`}
                  type="number"
                  min={0}
                  className="w-24"
                  value={String(childCounts[tier] ?? 0)}
                  onChange={(event) =>
                    setChildCounts((prev) => ({
                      ...prev,
                      [tier]: Math.max(0, Number(event.target.value) || 0),
                    }))
                  }
                />
              </div>
            ))}
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Catering</Label>
              <Select value={catering} onValueChange={setCatering}>
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(CATERING_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <Label>Guests</Label>
          {guests.map((guest, index) => (
            <div key={index} className="grid gap-2 sm:grid-cols-4">
              <Input
                aria-label={`Guest ${index + 1} first name`}
                placeholder="First name"
                value={guest.firstName}
                onChange={(event) =>
                  setGuests((prev) =>
                    prev.map((row, i) =>
                      i === index ? { ...row, firstName: event.target.value } : row,
                    ),
                  )
                }
              />
              <Input
                aria-label={`Guest ${index + 1} last name`}
                placeholder="Last name"
                value={guest.lastName}
                onChange={(event) =>
                  setGuests((prev) =>
                    prev.map((row, i) =>
                      i === index ? { ...row, lastName: event.target.value } : row,
                    ),
                  )
                }
              />
              <Select
                value={guest.ageTier}
                onValueChange={(value) =>
                  setGuests((prev) =>
                    prev.map((row, i) => (i === index ? { ...row, ageTier: value } : row)),
                  )
                }
              >
                <SelectTrigger aria-label={`Guest ${index + 1} age group`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BOOKABLE_AGE_TIER_VALUES.map((tier) => (
                    <SelectItem key={tier} value={tier}>
                      {tier.charAt(0) + tier.slice(1).toLowerCase()}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setGuests((prev) => prev.filter((_, i) => i !== index))}
              >
                Remove
              </Button>
            </div>
          ))}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              setGuests((prev) => [
                ...prev,
                { firstName: "", lastName: "", ageTier: "ADULT" },
              ])
            }
          >
            Add a guest
          </Button>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`correct-first-${request.id}`}>Contact first name</Label>
          <Input
            id={`correct-first-${request.id}`}
            value={contact.first}
            onChange={(event) =>
              setContact((prev) => ({ ...prev, first: event.target.value }))
            }
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`correct-last-${request.id}`}>Contact last name</Label>
          <Input
            id={`correct-last-${request.id}`}
            value={contact.last}
            onChange={(event) =>
              setContact((prev) => ({ ...prev, last: event.target.value }))
            }
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`correct-email-${request.id}`}>Contact email</Label>
          <Input
            id={`correct-email-${request.id}`}
            type="email"
            value={contact.email}
            onChange={(event) =>
              setContact((prev) => ({ ...prev, email: event.target.value }))
            }
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`correct-phone-${request.id}`}>Contact phone</Label>
          <Input
            id={`correct-phone-${request.id}`}
            value={contact.phone}
            onChange={(event) =>
              setContact((prev) => ({ ...prev, phone: event.target.value }))
            }
          />
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor={`correct-reason-${request.id}`}>
          Why are you correcting it?
        </Label>
        <p className="text-xs text-muted-foreground">
          For the club&apos;s own record. The requester never sees this.
        </p>
        <Textarea
          id={`correct-reason-${request.id}`}
          rows={2}
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>

      {request.linkedGuestMembers.length > 0 ? (
        <p className="rounded-md border border-warning-6 bg-warning-2 p-2 text-xs">
          {request.linkedGuestMembers.length === 1
            ? "One guest on this request is linked to a club member."
            : `${request.linkedGuestMembers.length} guests on this request are linked to club members.`}{" "}
          Those links point at places in the list below, so changing who is in
          the group clears them — link the right people again before you price
          or quote it. Correcting only the dates, the contact details or the
          catering keeps them.
        </p>
      ) : null}

      {/* The ONE place this card talks about the beds, and it is conditional in
          both directions: only a request that HOLDS beds has any to lose, and
          only a school request has the catering preference that would keep
          them — a public request has no catering control at all, so offering
          that escape hatch there points at a field that does not exist. */}
      {request.heldBookingId ? (
        <p className="rounded-md border border-warning-6 bg-warning-2 p-2 text-xs">
          This request is holding beds for the details as they stand. Saving a
          correction releases them, and the requester&apos;s existing quote link
          stops working — so send a fresh quote afterwards.
          {isSchool
            ? " Changing only the catering preference keeps the beds: it is the one detail a hold is not built from."
            : ""}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={save} disabled={saveBlocked}>
          {saving ? "Saving…" : "Save correction"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setOpen(false)}
          disabled={saving}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * What the typed school name resolves to, and the tick that lets Save arm.
 *
 * The tick is not a formality: the server re-asks this question under its own
 * lock and refuses any answer but the one confirmed here, so an officer cannot
 * create a second record for a school the club already has — or quietly move
 * this booking onto another school's accounting customer — without having read
 * which of the two they were doing.
 */
function SchoolRecordNotice(props: {
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
