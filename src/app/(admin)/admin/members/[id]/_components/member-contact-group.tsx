"use client";

import { Button } from "@/components/ui/button";
import { ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { FieldHint, describedByFieldHint } from "@/components/ui/field-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Pencil } from "lucide-react";
import { MemberAddressFields } from "@/components/member-address-fields";
import {
  formatMemberPhone,
  memberUsesSamePostalAddress,
} from "@/lib/admin-member-detail-helpers";
import { useClubTime } from "@/components/club-time-provider";
import { formatPayloadCalendarDay } from "../../../_lib/calendar-day";
import { formatPayloadInstantDate } from "../../../_lib/payload-instant";
import type { MemberContactEditForm } from "@/lib/admin-member-edit-groups";
import { hasPrivilegedAccess } from "@/lib/access-roles";
import {
  formatGenderLabel,
  formatTitleLabel,
  GENDER_OPTIONS,
  TITLE_OPTIONS,
} from "@/lib/member-enums";
import type { MemberAddressValues } from "@/lib/member-address";
import {
  ageTierSelectOptions,
  formatAgeTierName,
} from "@/lib/use-age-tier-options";
import { useMemberFieldsSettings } from "@/lib/use-member-fields-settings";
import type { MemberGroupEditState } from "../_hooks/use-member-group-edit";
import type { MemberDetail } from "../_types";

/*
  #2264 — ONE hint for the whole phone row (country / area / number) rather than
  an example parked in each box's placeholder, where grey text reads as a value
  already entered. A hook cannot serve three controls (one `useFieldHint` pairs
  with exactly one `fieldProps` spread), so the id is a module constant wired to
  each box with `describedByFieldHint`.
*/
const PHONE_HINT_ID = "member-contact-phone-hint";

interface MemberContactGroupProps {
  member: MemberDetail;
  isSelf: boolean;
  actorIsFullAdmin: boolean;
  edit: MemberGroupEditState<MemberContactEditForm>;
  /** Whether the actor may edit contact details (membership edit, #1997). */
  // Tri-state (#2065): `undefined` while the session resolves (neutral disabled).
  canEdit: boolean | undefined;
}

function addressLines(input: {
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
}) {
  return [
    input.line1,
    input.line2,
    [input.city, input.region, input.postalCode].filter(Boolean).join(" "),
    input.country,
  ].filter((line): line is string => Boolean(line && line.trim()));
}

function AddressBlock({ lines }: { lines: string[] }) {
  if (lines.length === 0) {
    return <span className="text-xs text-muted-foreground">Not provided</span>;
  }
  return (
    <span>
      {lines.map((line, index) => (
        <span key={index} className="block">
          {line}
        </span>
      ))}
    </span>
  );
}

export function MemberContactGroup({
  member,
  isSelf,
  actorIsFullAdmin,
  edit,
  canEdit,
}: MemberContactGroupProps) {
  const { showTitle, showGender, showOccupation } = useMemberFieldsSettings();
  const clubTime = useClubTime();
  // Mirror of the server-side Full Admin gate: only a Full Admin may change a
  // privileged member's login email (self-service excepted).
  const emailLockedForActor =
    !actorIsFullAdmin && !isSelf && hasPrivilegedAccess(member);
  // Mirror of the server-side org predicate (#1440): ORG access role, or the
  // legacy SCHOOL role (whose resolved tokens omit ORG when login is off).
  const isOrganisationMember =
    (member.accessRoles ?? []).includes("ORG") || member.role === "SCHOOL";
  // #2106: age-exemption of the current-season membership type. This is always
  // an edit context (never create), so an ALLOWED type makes N/A hand-pickable,
  // a FORCED type makes N/A a read-only readout, and DISALLOWED/null offers the
  // four person tiers only. Org accounts keep their own fixed readout above.
  const ageExemption = member.currentSeasonAgeExemption ?? null;
  const naForced = ageExemption === "FORCED";
  const naSelectable = ageExemption === "ALLOWED";

  const { editing, form, saving, error, errorRef } = edit;

  if (editing && form) {
    const updateForm = edit.updateForm;
    const updateAddressFields = (patch: Partial<MemberAddressValues>) => {
      updateForm((current) => ({ ...current, ...patch }));
    };
    return (
      <div className="space-y-4">
        {error && (
          <div
            ref={errorRef}
            role="alert"
            tabIndex={-1}
            className="scroll-mt-20 whitespace-pre-line rounded border border-danger/20 bg-danger-muted p-2 text-sm text-danger focus:outline-none"
          >
            {error}
          </div>
        )}
        {(showTitle || showGender) && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {showTitle && (
              <div className="space-y-2">
                <Label htmlFor="contact-title">Title</Label>
                <Select
                  value={form.title || "__none__"}
                  onValueChange={(value) =>
                    updateForm((f) => ({
                      ...f,
                      title:
                        value === "__none__"
                          ? ""
                          : (value as MemberContactEditForm["title"]),
                    }))
                  }
                >
                  <SelectTrigger id="contact-title">
                    <SelectValue placeholder="Select title" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">None</SelectItem>
                    {TITLE_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {showGender && (
              <div className="space-y-2">
                <Label htmlFor="contact-gender">Gender</Label>
                <Select
                  value={form.gender || "__none__"}
                  onValueChange={(value) =>
                    updateForm((f) => ({
                      ...f,
                      gender:
                        value === "__none__"
                          ? ""
                          : (value as MemberContactEditForm["gender"]),
                    }))
                  }
                >
                  <SelectTrigger id="contact-gender">
                    <SelectValue placeholder="Select gender" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">None</SelectItem>
                    {GENDER_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="contact-firstName">First Name *</Label>
            <Input
              id="contact-firstName"
              value={form.firstName}
              onChange={(e) =>
                updateForm((f) => ({ ...f, firstName: e.target.value }))
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="contact-lastName">Last Name *</Label>
            <Input
              id="contact-lastName"
              value={form.lastName}
              onChange={(e) =>
                updateForm((f) => ({ ...f, lastName: e.target.value }))
              }
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="contact-email">Email *</Label>
          <Input
            id="contact-email"
            type="email"
            value={form.email}
            disabled={emailLockedForActor}
            onChange={(e) =>
              updateForm((f) => ({ ...f, email: e.target.value }))
            }
          />
          {emailLockedForActor && (
            <p className="text-xs text-muted-foreground">
              Only a Full Admin can change a privileged member&apos;s login
              email.
            </p>
          )}
        </div>
        <div className="space-y-2">
          <Label>Phone</Label>
          <div className="flex gap-2">
            <Input
              className="w-20"
              value={form.phoneCountryCode}
              onChange={(e) =>
                updateForm((f) => ({
                  ...f,
                  phoneCountryCode: e.target.value,
                }))
              }
              maxLength={5}
              aria-label="Country code"
              aria-describedby={describedByFieldHint(PHONE_HINT_ID)}
            />
            <Input
              className="w-20"
              value={form.phoneAreaCode}
              onChange={(e) =>
                updateForm((f) => ({ ...f, phoneAreaCode: e.target.value }))
              }
              maxLength={5}
              aria-label="Area code"
              aria-describedby={describedByFieldHint(PHONE_HINT_ID)}
            />
            <Input
              className="flex-1"
              value={form.phoneNumber}
              onChange={(e) =>
                updateForm((f) => ({ ...f, phoneNumber: e.target.value }))
              }
              maxLength={15}
              aria-label="Phone number"
              aria-describedby={describedByFieldHint(PHONE_HINT_ID)}
            />
          </div>
          <FieldHint id={PHONE_HINT_ID}>Example: 64 27 123 4567</FieldHint>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="contact-dateOfBirth">Date of Birth</Label>
            <Input
              id="contact-dateOfBirth"
              type="date"
              value={form.dateOfBirth}
              onChange={(e) =>
                updateForm((f) => ({ ...f, dateOfBirth: e.target.value }))
              }
            />
            <p className="text-xs text-muted-foreground">
              Age tier is calculated automatically from date of birth.
            </p>
          </div>
          {isOrganisationMember ? (
            // Organisations/schools have no age (#1440): the server always
            // stores NOT_APPLICABLE for them, so the picker is replaced with
            // a fixed N/A readout.
            <div className="space-y-2">
              <Label>Age Tier</Label>
              <p className="flex h-9 items-center rounded-md border border-input bg-muted px-3 text-sm text-muted-foreground">
                N/A — organisations don&apos;t have an age tier
              </p>
            </div>
          ) : naForced ? (
            // FORCED type (#2106): the allowed tiers are exactly {N/A}, so
            // every member on it is N/A. The tier is read-only, mirroring the
            // org readout but driven by the membership type.
            <div className="space-y-2">
              <Label>Age Tier</Label>
              <p className="flex h-9 items-center rounded-md border border-input bg-muted px-3 text-sm text-muted-foreground">
                N/A — this membership type has no age tier
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <Label>Age Tier</Label>
              <Select
                value={
                  form.ageTier === "NOT_APPLICABLE"
                    ? naSelectable
                      ? "NOT_APPLICABLE"
                      : ""
                    : form.ageTier
                }
                onValueChange={(v) => updateForm((f) => ({ ...f, ageTier: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ageTierSelectOptions(ageExemption).map((tier) => (
                    <SelectItem key={tier} value={tier}>
                      {formatAgeTierName(tier)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="contact-joinedDate">Joined Date</Label>
          <Input
            id="contact-joinedDate"
            type="date"
            value={form.joinedDate}
            onChange={(e) =>
              updateForm((f) => ({ ...f, joinedDate: e.target.value }))
            }
          />
          <p className="text-xs text-muted-foreground">
            Used for finance and Xero-linked member history.
          </p>
        </div>
        {showOccupation && form.ageTier === "ADULT" && (
          <div className="space-y-2">
            <Label htmlFor="contact-occupation">Occupation</Label>
            <Input
              id="contact-occupation"
              value={form.occupation}
              maxLength={100}
              onChange={(e) =>
                updateForm((f) => ({ ...f, occupation: e.target.value }))
              }
            />
          </div>
        )}
        <MemberAddressFields
          idPrefix="contact-group"
          onSameAsPhysicalChange={(value) =>
            updateForm((f) => ({ ...f, postalSameAsPhysical: value }))
          }
          onValuesChange={updateAddressFields}
          sameAsPhysical={form.postalSameAsPhysical}
          values={form}
        />
        <div className="space-y-2">
          <Label htmlFor="contact-comments">Comments</Label>
          <Textarea
            id="contact-comments"
            rows={4}
            value={form.comments}
            onChange={(e) =>
              updateForm((f) => ({ ...f, comments: e.target.value }))
            }
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={edit.cancelEdit} disabled={saving}>
            Cancel
          </Button>
          <ViewOnlyActionButton
            canEdit={canEdit}
            onClick={() => void edit.save()}
            disabled={saving}
          >
            {saving ? "Saving..." : "Save Changes"}
          </ViewOnlyActionButton>
        </div>
      </div>
    );
  }

  const physicalLines = addressLines({
    line1: member.streetAddressLine1,
    line2: member.streetAddressLine2,
    city: member.streetCity,
    region: member.streetRegion,
    postalCode: member.streetPostalCode,
    country: member.streetCountry,
  });
  const postalSameAsPhysical = memberUsesSamePostalAddress(member);
  const postalLines = addressLines({
    line1: member.postalAddressLine1,
    line2: member.postalAddressLine2,
    city: member.postalCity,
    region: member.postalRegion,
    postalCode: member.postalPostalCode,
    country: member.postalCountry,
  });

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <ViewOnlyActionButton canEdit={canEdit} variant="outline" size="sm" onClick={edit.startEdit}>
          <Pencil className="h-4 w-4 mr-1" />
          Edit
        </ViewOnlyActionButton>
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        {showTitle && (
          <div>
            <dt className="text-muted-foreground">Title</dt>
            <dd className="font-medium">
              {formatTitleLabel(member.title) || "Not set"}
            </dd>
          </div>
        )}
        {showGender && (
          <div>
            <dt className="text-muted-foreground">Gender</dt>
            <dd className="font-medium">
              {formatGenderLabel(member.gender) || "Not set"}
            </dd>
          </div>
        )}
        <div>
          <dt className="text-muted-foreground">First Name</dt>
          <dd className="font-medium">{member.firstName}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Last Name</dt>
          <dd className="font-medium">{member.lastName}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Email</dt>
          <dd className="font-medium break-all">{member.email}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Phone</dt>
          <dd className="font-medium">
            {formatMemberPhone(member) || "Not provided"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Date of Birth</dt>
          <dd className="font-medium">
            {/* A `@db.Date` CALENDAR DAY. It has no timezone, so it is decoded
                from its UTC-midnight encoding and rendered with none —
                projecting it through a zone is `INV-DATE-019`, and through a
                zone behind UTC it names the day before the member was born. */}
            {member.dateOfBirth
              ? formatPayloadCalendarDay(member.dateOfBirth)
              : "Not set"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Member Since</dt>
          <dd className="font-medium">
            {/* TWO DIFFERENT TEMPORAL CONCEPTS behind one readout, exactly as
                on the members list (`member-table.tsx`, `formatMemberSince`).
                `joinedDate` is a `@db.Date` calendar day sourced from Xero's
                first invoice and takes no zone; `createdAt` is a real instant
                and has no civil date until one is chosen — the club's persisted
                zone (`INV-CONFIG-002`), never the viewer's. Feeding both
                through one instant formatter is what made the branch you got
                decide whether the day was right. */}
            {member.joinedDate
              ? formatPayloadCalendarDay(member.joinedDate)
              : formatPayloadInstantDate(clubTime, member.createdAt)}
            {member.joinedDate && (
              <span className="ml-1 text-xs text-muted-foreground">(from Xero)</span>
            )}
          </dd>
        </div>
        {showOccupation && (
          <div>
            <dt className="text-muted-foreground">Occupation</dt>
            <dd className="font-medium">{member.occupation || "Not set"}</dd>
          </div>
        )}
        <div>
          <dt className="text-muted-foreground">Physical Address</dt>
          <dd className="font-medium">
            <AddressBlock lines={physicalLines} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Postal Address</dt>
          <dd className="font-medium">
            {postalSameAsPhysical ? (
              <span className="text-xs text-muted-foreground">Same as physical</span>
            ) : (
              <AddressBlock lines={postalLines} />
            )}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-muted-foreground">Comments</dt>
          <dd className="font-medium whitespace-pre-wrap">
            {member.comments || "None"}
          </dd>
        </div>
      </dl>
    </div>
  );
}
