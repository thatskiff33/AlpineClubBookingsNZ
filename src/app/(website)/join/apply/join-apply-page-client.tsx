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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NZ_COUNTRY_NAME,
  type MemberAddressValues,
} from "@/lib/member-address";
import type { ClubIdentity } from "@/config/club-identity-types";
import { readValidationDetails } from "@/lib/format-validation-errors";
import {
  JoinApplyErrorSummary,
  clientSummaryEntries,
  serverSummaryEntries,
  type JoinApplySummaryEntry,
} from "./join-apply-error-summary";
import { JOIN_APPLY_INPUT_IDS, familyMemberInputId } from "./join-apply-input-ids";
import { JoinApplyPhoneRow } from "./join-apply-phone-row";

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
  // Set only by a submit, never by typing (#4947): see the summary's comment.
  const [failure, setFailure] = useState<{
    message: string;
    entries: JoinApplySummaryEntry[];
    attentionKey: number;
  }>({ message: "", entries: [], attentionKey: 0 });
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

  function fail(message: string, entries: JoinApplySummaryEntry[] = []) {
    setFailure((prev) => ({ message, entries, attentionKey: prev.attentionKey + 1 }));
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
      nextErrors.applicantEmail = "Enter a valid applicant email address";
    }
    if (!form.applicantDateOfBirth) {
      nextErrors.applicantDateOfBirth = "Date of birth is required";
    }
    form.familyMembers.forEach((familyMember, index) => {
      if (!familyMember.firstName.trim()) {
        nextErrors[`familyMembers.${index}.firstName`] =
          `Household member ${index + 1} first name is required`;
      }
      if (!familyMember.lastName.trim()) {
        nextErrors[`familyMembers.${index}.lastName`] =
          `Household member ${index + 1} last name is required`;
      }
      if (!familyMember.dateOfBirth) {
        nextErrors[`familyMembers.${index}.dateOfBirth`] =
          `Household member ${index + 1} date of birth is required`;
      }
    });

    if (!form.nominator1Email.trim()) {
      nextErrors.nominator1Email = "First nominator email is required";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.nominator1Email)) {
      nextErrors.nominator1Email = "Enter a valid first nominator email address";
    }
    if (!form.nominator2Email.trim()) {
      nextErrors.nominator2Email = "Second nominator email is required";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.nominator2Email)) {
      nextErrors.nominator2Email = "Enter a valid second nominator email address";
    }
    if (
      form.nominator1Email.trim() &&
      form.nominator2Email.trim() &&
      form.nominator1Email.trim().toLowerCase() ===
        form.nominator2Email.trim().toLowerCase()
    ) {
      nextErrors.nominator2Email = "Please provide two different nominators";
    }

    // Keys are added in form order, which the summary lists them in.
    setFieldErrors(nextErrors);
    return nextErrors;
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setFailure((prev) => ({ ...prev, message: "", entries: [] }));
    setWarnings([]);

    // The household as submitted: the summary's keys count members by position.
    const familyMemberIds = form.familyMembers.map((member) => member.id);
    const clientEntries = clientSummaryEntries(validateForm(), familyMemberIds);
    if (clientEntries.length > 0) {
      fail("", clientEntries);
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
        const details = readValidationDetails(data);
        if (details && (details.fieldErrors.length > 0 || details.formErrors.length > 0)) {
          setFieldErrors(
            Object.fromEntries(details.fieldErrors.map(([field, messages]) => [field, messages[0]])),
          );
          fail("", serverSummaryEntries(details, familyMemberIds));
        } else {
          fail(data.error || "Could not submit your application right now.");
        }
        return;
      }

      setWarnings(Array.isArray(data.warnings) ? data.warnings : []);
      setSubmitted(true);
    } catch {
      fail("Something went wrong while submitting your application.");
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
                    <Label htmlFor={JOIN_APPLY_INPUT_IDS.applicantFirstName}>First name</Label>
                    <Input
                      id={JOIN_APPLY_INPUT_IDS.applicantFirstName}
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
                    <Label htmlFor={JOIN_APPLY_INPUT_IDS.applicantLastName}>Last name</Label>
                    <Input
                      id={JOIN_APPLY_INPUT_IDS.applicantLastName}
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
                  <Label htmlFor={JOIN_APPLY_INPUT_IDS.applicantEmail}>Email</Label>
                  <Input
                    id={JOIN_APPLY_INPUT_IDS.applicantEmail}
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
                    <Label htmlFor={JOIN_APPLY_INPUT_IDS.applicantDateOfBirth}>Date of birth</Label>
                    <Input
                      id={JOIN_APPLY_INPUT_IDS.applicantDateOfBirth}
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

                  <JoinApplyPhoneRow
                    values={form}
                    errors={fieldErrors}
                    onFieldChange={updateField}
                  />
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
                              <Label htmlFor={familyMemberInputId(familyMember.id, "firstName")}>
                                First name
                              </Label>
                              <Input
                                id={familyMemberInputId(familyMember.id, "firstName")}
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
                                    ? `${familyMemberInputId(familyMember.id, "firstName")}-error`
                                    : undefined
                                }
                              />
                              {fieldErrors[
                                `familyMembers.${index}.firstName`
                              ] && (
                                <p
                                  id={`${familyMemberInputId(familyMember.id, "firstName")}-error`}
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
                              <Label htmlFor={familyMemberInputId(familyMember.id, "lastName")}>
                                Last name
                              </Label>
                              <Input
                                id={familyMemberInputId(familyMember.id, "lastName")}
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
                                    ? `${familyMemberInputId(familyMember.id, "lastName")}-error`
                                    : undefined
                                }
                              />
                              {fieldErrors[
                                `familyMembers.${index}.lastName`
                              ] && (
                                <p
                                  id={`${familyMemberInputId(familyMember.id, "lastName")}-error`}
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
                            <Label htmlFor={familyMemberInputId(familyMember.id, "dateOfBirth")}>
                              Date of birth
                            </Label>
                            <Input
                              id={familyMemberInputId(familyMember.id, "dateOfBirth")}
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
                                  ? `${familyMemberInputId(familyMember.id, "dateOfBirth")}-error`
                                  : undefined
                              }
                            />
                            {fieldErrors[
                              `familyMembers.${index}.dateOfBirth`
                            ] && (
                              <p
                                id={`${familyMemberInputId(familyMember.id, "dateOfBirth")}-error`}
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
                    <Label htmlFor={JOIN_APPLY_INPUT_IDS.nominator1Email}>
                      First nominator email
                    </Label>
                    <Input
                      id={JOIN_APPLY_INPUT_IDS.nominator1Email}
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
                    <Label htmlFor={JOIN_APPLY_INPUT_IDS.nominator2Email}>
                      Second nominator email
                    </Label>
                    <Input
                      id={JOIN_APPLY_INPUT_IDS.nominator2Email}
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
                <JoinApplyErrorSummary {...failure} />

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
