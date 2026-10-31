"use client";

import { useState } from "react";
import Link from "next/link";
import { MemberAddressFields } from "@/components/member-address-fields";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { FieldHint, describedByFieldHint } from "@/components/ui/field-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NZ_COUNTRY_NAME,
  type MemberAddressValues,
} from "@/lib/member-address";
import type { ClubIdentity } from "@/config/club-identity-types";
import { readValidationDetails } from "@/lib/format-validation-errors";

/*
  #2264 — the phone row is three boxes sharing ONE example. Greyed "64", "27"
  and "123 4567" inside them read as a number the application already carries.
  A grouped micro-input row gets a single hint that all three boxes point at,
  which is `describedByFieldHint` rather than `useFieldHint`: one hook owes
  exactly one `fieldProps` spread, and this row needs the same id three times.
  The boxes keep their `aria-label`s — those are their accessible NAME, and the
  hint only describes them.
*/
const PHONE_HINT_ID = "join-apply-phone-hint";
const PHONE_DESCRIBED_BY = describedByFieldHint(PHONE_HINT_ID);

type FamilyMemberForm = {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
};

type ApplicationFormData = MemberAddressValues & {
  applicantFirstName: string;
  applicantLastName: string;
  applicantEmail: string;
  applicantDateOfBirth: string;
  phoneCountryCode: string;
  phoneAreaCode: string;
  phoneNumber: string;
  nominator1Email: string;
  nominator2Email: string;
  familyMembers: FamilyMemberForm[];
};

type FieldErrors = Partial<
  Record<
    | keyof Omit<ApplicationFormData, "familyMembers">
    | `familyMembers.${number}.firstName`
    | `familyMembers.${number}.lastName`
    | `familyMembers.${number}.dateOfBirth`,
    string
  >
>;

let nextFamilyMemberId = 1;

function emptyFamilyMember(): FamilyMemberForm {
  return {
    id: `fm-${nextFamilyMemberId++}`,
    firstName: "",
    lastName: "",
    dateOfBirth: "",
  };
}

interface JoinApplyPageClientProps {
  club: ClubIdentity;
  showHero?: boolean;
}

export function JoinApplyPageClient({
  club,
  showHero = true,
}: JoinApplyPageClientProps) {
  const [form, setForm] = useState<ApplicationFormData>({
    applicantFirstName: "",
    applicantLastName: "",
    applicantEmail: "",
    applicantDateOfBirth: "",
    phoneCountryCode: "",
    phoneAreaCode: "",
    phoneNumber: "",
    nominator1Email: "",
    nominator2Email: "",
    familyMembers: [],
    streetAddressLine1: "",
    streetAddressLine2: "",
    streetCity: "",
    streetRegion: "",
    streetPostalCode: "",
    streetCountry: NZ_COUNTRY_NAME,
    postalAddressLine1: "",
    postalAddressLine2: "",
    postalCity: "",
    postalRegion: "",
    postalPostalCode: "",
    postalCountry: NZ_COUNTRY_NAME,
  });
  const [sameAsPhysical, setSameAsPhysical] = useState(true);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  function updateField(
    field: keyof Omit<ApplicationFormData, "familyMembers">,
  ) {
    return (event: React.ChangeEvent<HTMLInputElement>) => {
      setForm((prev) => ({ ...prev, [field]: event.target.value }));
      setFieldErrors((prev) => ({ ...prev, [field]: undefined }));
    };
  }

  function updateAddressFields(patch: Partial<MemberAddressValues>) {
    setForm((prev) => ({ ...prev, ...patch }));
  }

  function updateFamilyMember(
    index: number,
    field: keyof FamilyMemberForm,
    value: string,
  ) {
    setForm((prev) => ({
      ...prev,
      familyMembers: prev.familyMembers.map((member, memberIndex) =>
        memberIndex === index ? { ...member, [field]: value } : member,
      ),
    }));
    setFieldErrors((prev) => ({
      ...prev,
      [`familyMembers.${index}.${field}`]: undefined,
    }));
  }

  function addFamilyMember() {
    setForm((prev) => ({
      ...prev,
      familyMembers: [...prev.familyMembers, emptyFamilyMember()],
    }));
  }

  function removeFamilyMember(index: number) {
    setForm((prev) => ({
      ...prev,
      familyMembers: prev.familyMembers.filter(
        (_, memberIndex) => memberIndex !== index,
      ),
    }));
    setFieldErrors((prev) => {
      const next = { ...prev };
      delete next[`familyMembers.${index}.firstName`];
      delete next[`familyMembers.${index}.lastName`];
      delete next[`familyMembers.${index}.dateOfBirth`];
      return next;
    });
  }

  function validateForm() {
    const nextErrors: FieldErrors = {};

    if (!form.applicantFirstName.trim()) {
      nextErrors.applicantFirstName = "First name is required";
    }
    if (!form.applicantLastName.trim()) {
      nextErrors.applicantLastName = "Last name is required";
    }
    if (!form.applicantEmail.trim()) {
      nextErrors.applicantEmail = "Email is required";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.applicantEmail)) {
      nextErrors.applicantEmail = "Enter a valid email address";
    }
    if (!form.applicantDateOfBirth) {
      nextErrors.applicantDateOfBirth = "Date of birth is required";
    }
    if (!form.nominator1Email.trim()) {
      nextErrors.nominator1Email = "First nominator email is required";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.nominator1Email)) {
      nextErrors.nominator1Email = "Enter a valid email address";
    }
    if (!form.nominator2Email.trim()) {
      nextErrors.nominator2Email = "Second nominator email is required";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.nominator2Email)) {
      nextErrors.nominator2Email = "Enter a valid email address";
    }
    if (
      form.nominator1Email.trim() &&
      form.nominator2Email.trim() &&
      form.nominator1Email.trim().toLowerCase() ===
        form.nominator2Email.trim().toLowerCase()
    ) {
      nextErrors.nominator2Email = "Please provide two different nominators";
    }

    form.familyMembers.forEach((familyMember, index) => {
      if (!familyMember.firstName.trim()) {
        nextErrors[`familyMembers.${index}.firstName`] =
          "Household member first name is required";
      }
      if (!familyMember.lastName.trim()) {
        nextErrors[`familyMembers.${index}.lastName`] =
          "Household member last name is required";
      }
      if (!familyMember.dateOfBirth) {
        nextErrors[`familyMembers.${index}.dateOfBirth`] =
          "Household member date of birth is required";
      }
    });

    setFieldErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setWarnings([]);

    if (!validateForm()) {
      return;
    }

    setLoading(true);

    try {
      const response = await fetch("/api/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          applicantFirstName: form.applicantFirstName,
          applicantLastName: form.applicantLastName,
          applicantEmail: form.applicantEmail,
          applicantDateOfBirth: form.applicantDateOfBirth || null,
          phoneCountryCode: form.phoneCountryCode || null,
          phoneAreaCode: form.phoneAreaCode || null,
          phoneNumber: form.phoneNumber || null,
          streetAddressLine1: form.streetAddressLine1 || null,
          streetAddressLine2: form.streetAddressLine2 || null,
          streetCity: form.streetCity || null,
          streetRegion: form.streetRegion || null,
          streetPostalCode: form.streetPostalCode || null,
          streetCountry: form.streetCountry || null,
          postalAddressLine1: form.postalAddressLine1 || null,
          postalAddressLine2: form.postalAddressLine2 || null,
          postalCity: form.postalCity || null,
          postalRegion: form.postalRegion || null,
          postalPostalCode: form.postalPostalCode || null,
          postalCountry: form.postalCountry || null,
          postalSameAsPhysical: sameAsPhysical,
          familyMembers: form.familyMembers.map(
            ({ firstName, lastName, dateOfBirth }) => ({
              firstName,
              lastName,
              dateOfBirth,
            }),
          ),
          nominator1Email: form.nominator1Email,
          nominator2Email: form.nominator2Email,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        // The route's validation details are read through the one shared reader
        // (#4580); anything else falls back to the route's own sentence.
        const details = readValidationDetails(data);
        if (details && details.fieldErrors.length > 0) {
          const nextErrors: FieldErrors = {};
          for (const [field, messages] of details.fieldErrors) {
            nextErrors[field as keyof FieldErrors] = messages[0];
          }
          setFieldErrors(nextErrors);
        } else {
          setError(
            data.error || "Could not submit your application right now.",
          );
        }
        return;
      }

      setWarnings(Array.isArray(data.warnings) ? data.warnings : []);
      setSubmitted(true);
    } catch {
      setError("Something went wrong while submitting your application.");
    } finally {
      setLoading(false);
    }
  }

  if (submitted) {
    return (
      <section className="bg-brand-mist/40 py-12 sm:py-16">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
          <Card className="border-brand-ridge/20 bg-card shadow-[0_22px_46px_-34px_rgba(47,47,43,0.38)]">
            <CardHeader className="space-y-3 text-center">
              <CardTitle className="font-heading text-3xl text-brand-charcoal">
                Application submitted
              </CardTitle>
              <CardDescription className="text-base text-brand-deep/75">
                Your details are in. We have asked both nominators to confirm
                your nomination before the committee review step.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-sm text-brand-deep/78">
              <p>
                Once both nominators approve, the application moves to the club
                admin panel for committee consideration.
              </p>
              <p>
                Nomination emails occasionally go missing. If a nominator has
                not received theirs, ask them to check their spam folder first
                — then contact the club and an administrator can send them a
                fresh nomination link.
              </p>
              {warnings.length > 0 && (
                <div className="rounded-md border border-warning-6 bg-warning-3 px-4 py-3 text-warning-11">
                  {warnings.join(". ")}
                </div>
              )}
              <p>
                Existing members can return to{" "}
                <Link className="underline underline-offset-4" href="/login">
                  login
                </Link>
                . If you need to update the application, contact the club.
              </p>
            </CardContent>
          </Card>
        </div>
      </section>
    );
  }

  return (
    <>
      {showHero ? (
        <section className="bg-gradient-to-br from-brand-charcoal to-brand-deep py-14 text-brand-snow sm:py-18">
          <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
            <span className="website-eyebrow mb-4">Membership Application</span>
            <h1 className="font-heading text-4xl font-bold tracking-tight sm:text-5xl">
              Apply for Membership
            </h1>
            <p className="mt-4 max-w-3xl text-lg text-brand-snow/80">
              Enter your details, nominate two current {club.name} members, and
              we will move your application through nomination confirmation and
              committee approval.
            </p>
          </div>
        </section>
      ) : null}

      <section className="bg-brand-mist/40 pb-16 pt-6 sm:pb-20">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
          <Card id="joinApplyForm" className="border-brand-ridge/20 bg-card shadow-[0_22px_46px_-34px_rgba(47,47,43,0.38)]">
            <CardHeader className="space-y-2">
              <CardTitle className="font-heading text-3xl text-brand-charcoal">
                Enter your details
              </CardTitle>
              <CardDescription className="text-base text-brand-deep/75">
                This form creates a membership application only. It does not
                create a {club.name} login until nominators and the committee
                approve it.
              </CardDescription>
            </CardHeader>

            <form onSubmit={handleSubmit}>
              <CardContent className="space-y-6">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="applicantFirstName">First name</Label>
                    <Input
                      id="applicantFirstName"
                      value={form.applicantFirstName}
                      onChange={updateField("applicantFirstName")}
                      autoComplete="given-name"
                      aria-invalid={!!fieldErrors.applicantFirstName}
                      aria-describedby={
                        fieldErrors.applicantFirstName
                          ? "applicantFirstName-error"
                          : undefined
                      }
                    />
                    {fieldErrors.applicantFirstName && (
                      <p
                        id="applicantFirstName-error"
                        className="text-xs text-destructive"
                      >
                        {fieldErrors.applicantFirstName}
                      </p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="applicantLastName">Last name</Label>
                    <Input
                      id="applicantLastName"
                      value={form.applicantLastName}
                      onChange={updateField("applicantLastName")}
                      autoComplete="family-name"
                      aria-invalid={!!fieldErrors.applicantLastName}
                      aria-describedby={
                        fieldErrors.applicantLastName
                          ? "applicantLastName-error"
                          : undefined
                      }
                    />
                    {fieldErrors.applicantLastName && (
                      <p
                        id="applicantLastName-error"
                        className="text-xs text-destructive"
                      >
                        {fieldErrors.applicantLastName}
                      </p>
                    )}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="applicantEmail">Email</Label>
                  <Input
                    id="applicantEmail"
                    type="email"
                    value={form.applicantEmail}
                    onChange={updateField("applicantEmail")}
                    autoComplete="email"
                    aria-invalid={!!fieldErrors.applicantEmail}
                    aria-describedby={
                      fieldErrors.applicantEmail
                        ? "applicantEmail-error"
                        : undefined
                    }
                  />
                  {fieldErrors.applicantEmail && (
                    <p
                      id="applicantEmail-error"
                      className="text-xs text-destructive"
                    >
                      {fieldErrors.applicantEmail}
                    </p>
                  )}
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="applicantDateOfBirth">Date of birth</Label>
                    <Input
                      id="applicantDateOfBirth"
                      type="date"
                      value={form.applicantDateOfBirth}
                      onChange={updateField("applicantDateOfBirth")}
                      autoComplete="bday"
                      aria-invalid={!!fieldErrors.applicantDateOfBirth}
                      aria-describedby={
                        fieldErrors.applicantDateOfBirth
                          ? "applicantDateOfBirth-error"
                          : undefined
                      }
                    />
                    {fieldErrors.applicantDateOfBirth && (
                      <p
                        id="applicantDateOfBirth-error"
                        className="text-xs text-destructive"
                      >
                        {fieldErrors.applicantDateOfBirth}
                      </p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label>Phone</Label>
                    <div className="flex gap-2">
                      <Input
                        className="w-20"
                        value={form.phoneCountryCode}
                        onChange={updateField("phoneCountryCode")}
                        aria-label="Phone country code"
                        aria-describedby={PHONE_DESCRIBED_BY}
                      />
                      <Input
                        className="w-20"
                        value={form.phoneAreaCode}
                        onChange={updateField("phoneAreaCode")}
                        aria-label="Phone area code"
                        aria-describedby={PHONE_DESCRIBED_BY}
                      />
                      <Input
                        className="flex-1"
                        value={form.phoneNumber}
                        onChange={updateField("phoneNumber")}
                        aria-label="Phone number"
                        aria-describedby={PHONE_DESCRIBED_BY}
                      />
                    </div>
                    <FieldHint id={PHONE_HINT_ID}>
                      Country code, area code, and number. Example: 64 27 123 4567
                    </FieldHint>
                  </div>
                </div>

                <MemberAddressFields
                  className="pt-2"
                  collapsible
                  idPrefix="join-apply"
                  onSameAsPhysicalChange={setSameAsPhysical}
                  onValuesChange={updateAddressFields}
                  sameAsPhysical={sameAsPhysical}
                  values={form}
                />

                <div className="space-y-4 rounded-xl border border-brand-ridge/20 bg-brand-snow/70 p-4">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <h2 className="font-heading text-xl font-semibold text-brand-charcoal">
                        Household Members
                      </h2>
                      <p className="text-sm text-brand-deep/70">
                        Add any household members included in this application.
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={addFamilyMember}
                    >
                      Add Household Member
                    </Button>
                  </div>

                  {form.familyMembers.length === 0 ? (
                    <p className="text-sm text-brand-deep/70">
                      No household members added yet.
                    </p>
                  ) : (
                    <div className="space-y-4">
                      {form.familyMembers.map((familyMember, index) => (
                        <div
                          key={familyMember.id}
                          className="space-y-4 rounded-lg border border-brand-ridge/20 bg-card p-4"
                        >
                          <div className="flex items-center justify-between gap-4">
                            <h3 className="font-medium text-brand-charcoal">
                              Household Member {index + 1}
                            </h3>
                            <Button
                              type="button"
                              variant="ghost"
                              className="text-destructive hover:text-destructive"
                              onClick={() => removeFamilyMember(index)}
                            >
                              Remove
                            </Button>
                          </div>

                          <div className="grid gap-4 sm:grid-cols-2">
                            <div className="space-y-2">
                              <Label htmlFor={`family-first-name-${index}`}>
                                First name
                              </Label>
                              <Input
                                id={`family-first-name-${index}`}
                                value={familyMember.firstName}
                                onChange={(event) =>
                                  updateFamilyMember(
                                    index,
                                    "firstName",
                                    event.target.value,
                                  )
                                }
                                aria-invalid={
                                  !!fieldErrors[
                                    `familyMembers.${index}.firstName`
                                  ]
                                }
                                aria-describedby={
                                  fieldErrors[
                                    `familyMembers.${index}.firstName`
                                  ]
                                    ? `family-first-name-${index}-error`
                                    : undefined
                                }
                              />
                              {fieldErrors[
                                `familyMembers.${index}.firstName`
                              ] && (
                                <p
                                  id={`family-first-name-${index}-error`}
                                  className="text-xs text-destructive"
                                >
                                  {
                                    fieldErrors[
                                      `familyMembers.${index}.firstName`
                                    ]
                                  }
                                </p>
                              )}
                            </div>

                            <div className="space-y-2">
                              <Label htmlFor={`family-last-name-${index}`}>
                                Last name
                              </Label>
                              <Input
                                id={`family-last-name-${index}`}
                                value={familyMember.lastName}
                                onChange={(event) =>
                                  updateFamilyMember(
                                    index,
                                    "lastName",
                                    event.target.value,
                                  )
                                }
                                aria-invalid={
                                  !!fieldErrors[
                                    `familyMembers.${index}.lastName`
                                  ]
                                }
                                aria-describedby={
                                  fieldErrors[
                                    `familyMembers.${index}.lastName`
                                  ]
                                    ? `family-last-name-${index}-error`
                                    : undefined
                                }
                              />
                              {fieldErrors[
                                `familyMembers.${index}.lastName`
                              ] && (
                                <p
                                  id={`family-last-name-${index}-error`}
                                  className="text-xs text-destructive"
                                >
                                  {
                                    fieldErrors[
                                      `familyMembers.${index}.lastName`
                                    ]
                                  }
                                </p>
                              )}
                            </div>
                          </div>

                          <div className="space-y-2">
                            <Label htmlFor={`family-dob-${index}`}>
                              Date of birth
                            </Label>
                            <Input
                              id={`family-dob-${index}`}
                              type="date"
                              value={familyMember.dateOfBirth}
                              onChange={(event) =>
                                updateFamilyMember(
                                  index,
                                  "dateOfBirth",
                                  event.target.value,
                                )
                              }
                              aria-invalid={
                                !!fieldErrors[
                                  `familyMembers.${index}.dateOfBirth`
                                ]
                              }
                              aria-describedby={
                                fieldErrors[
                                  `familyMembers.${index}.dateOfBirth`
                                ]
                                  ? `family-dob-${index}-error`
                                  : undefined
                              }
                            />
                            {fieldErrors[
                              `familyMembers.${index}.dateOfBirth`
                            ] && (
                              <p
                                id={`family-dob-${index}-error`}
                                className="text-xs text-destructive"
                              >
                                {
                                  fieldErrors[
                                    `familyMembers.${index}.dateOfBirth`
                                  ]
                                }
                              </p>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-4 rounded-xl border border-brand-ridge/20 bg-brand-snow/70 p-4">
                  <div>
                    <h2 className="font-heading text-xl font-semibold text-brand-charcoal">
                      Nominators
                    </h2>
                    <p className="text-sm text-brand-deep/70">
                      Enter the email addresses of two active, paid-up{" "}
                      {club.name}
                      members who have agreed to nominate you.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="nominator1Email">
                      First nominator email
                    </Label>
                    <Input
                      id="nominator1Email"
                      type="email"
                      value={form.nominator1Email}
                      onChange={updateField("nominator1Email")}
                      aria-invalid={!!fieldErrors.nominator1Email}
                      aria-describedby={
                        fieldErrors.nominator1Email
                          ? "nominator1Email-error"
                          : undefined
                      }
                    />
                    {fieldErrors.nominator1Email && (
                      <p
                        id="nominator1Email-error"
                        className="text-xs text-destructive"
                      >
                        {fieldErrors.nominator1Email}
                      </p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="nominator2Email">
                      Second nominator email
                    </Label>
                    <Input
                      id="nominator2Email"
                      type="email"
                      value={form.nominator2Email}
                      onChange={updateField("nominator2Email")}
                      aria-invalid={!!fieldErrors.nominator2Email}
                      aria-describedby={
                        fieldErrors.nominator2Email
                          ? "nominator2Email-error"
                          : undefined
                      }
                    />
                    {fieldErrors.nominator2Email && (
                      <p
                        id="nominator2Email-error"
                        className="text-xs text-destructive"
                      >
                        {fieldErrors.nominator2Email}
                      </p>
                    )}
                  </div>
                </div>
              </CardContent>

              <CardFooter className="flex flex-col gap-4">
                {error && (
                  <div
                    role="alert"
                    className="w-full rounded-md border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive"
                  >
                    {error}
                  </div>
                )}

                <Button type="submit" className="w-full" disabled={loading}>
                  {loading
                    ? "Submitting application..."
                    : "Submit membership application"}
                </Button>

                <p className="text-center text-xs leading-relaxed text-muted-foreground">
                  Existing members should{" "}
                  <Link className="underline underline-offset-4" href="/login">
                    sign in here
                  </Link>
                  . Submitting this form asks your nominators to confirm your
                  application before committee review.
                </p>
              </CardFooter>
            </form>
          </Card>
        </div>
      </section>
    </>
  );
}
