"use client";

import { useState } from "react";
import Link from "next/link";
import { ClipboardCheck, MailCheck, UserPlus } from "lucide-react";
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
  NZ_COUNTRY_CODE,
  type MemberAddressValues,
} from "@/lib/member-address";

type FamilyMemberForm = {
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

const steps = [
  {
    title: "Enter details",
    description:
      "Tell us about yourself, your dependents, and the two current TAC members who are nominating you.",
    icon: UserPlus,
  },
  {
    title: "Nominators confirm",
    description:
      "We email both nominators. They sign in and confirm they are happy to nominate you.",
    icon: MailCheck,
  },
  {
    title: "Committee reviews",
    description:
      "Once both nominations are confirmed, the application goes to the admin panel for committee approval.",
    icon: ClipboardCheck,
  },
];

function emptyFamilyMember(): FamilyMemberForm {
  return {
    firstName: "",
    lastName: "",
    dateOfBirth: "",
  };
}

export default function JoinApplyPage() {
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
    streetCountry: NZ_COUNTRY_CODE,
    postalAddressLine1: "",
    postalAddressLine2: "",
    postalCity: "",
    postalRegion: "",
    postalPostalCode: "",
    postalCountry: NZ_COUNTRY_CODE,
  });
  const [sameAsPhysical, setSameAsPhysical] = useState(true);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  function updateField(field: keyof Omit<ApplicationFormData, "familyMembers">) {
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
    value: string
  ) {
    setForm((prev) => ({
      ...prev,
      familyMembers: prev.familyMembers.map((member, memberIndex) =>
        memberIndex === index ? { ...member, [field]: value } : member
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
      familyMembers: prev.familyMembers.filter((_, memberIndex) => memberIndex !== index),
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
          "Dependent first name is required";
      }
      if (!familyMember.lastName.trim()) {
        nextErrors[`familyMembers.${index}.lastName`] =
          "Dependent last name is required";
      }
      if (!familyMember.dateOfBirth) {
        nextErrors[`familyMembers.${index}.dateOfBirth`] =
          "Dependent date of birth is required";
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
          familyMembers: form.familyMembers,
          nominator1Email: form.nominator1Email,
          nominator2Email: form.nominator2Email,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        if (data.details) {
          const nextErrors: FieldErrors = {};
          Object.entries(data.details).forEach(([field, messages]) => {
            nextErrors[field as keyof FieldErrors] = (messages as string[])[0];
          });
          setFieldErrors(nextErrors);
        } else {
          setError(data.error || "Could not submit your application right now.");
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
          <Card className="border-brand-ridge/20 bg-white shadow-[0_22px_46px_-34px_rgba(47,47,43,0.38)]">
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
                Once both nominators approve, the application moves to the TAC
                admin panel for committee consideration.
              </p>
              {warnings.length > 0 && (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-amber-800">
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
      <section className="bg-gradient-to-br from-brand-charcoal to-brand-deep py-14 text-brand-snow sm:py-18">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <span className="website-eyebrow mb-4">Membership Application</span>
          <h1 className="font-heading text-4xl font-bold tracking-tight sm:text-5xl">
            Apply for Membership
          </h1>
          <p className="mt-4 max-w-3xl text-lg text-brand-snow/80">
            Enter your details, nominate two current TAC members, and we will
            move your application through nomination confirmation and committee
            approval.
          </p>
        </div>
      </section>

      <section className="bg-brand-snow py-10">
        <div className="mx-auto grid max-w-6xl gap-4 px-4 sm:px-6 lg:grid-cols-3 lg:px-8">
          {steps.map((step) => (
            <Card key={step.title} className="border-brand-ridge/20 bg-white/90">
              <CardContent className="flex gap-3 pt-6">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-gold/25 text-brand-charcoal">
                  <step.icon className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="font-heading text-lg font-semibold text-brand-charcoal">
                    {step.title}
                  </h2>
                  <p className="mt-1 text-sm text-brand-deep/75">
                    {step.description}
                  </p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="bg-brand-mist/40 pb-16 pt-6 sm:pb-20">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
          <Card className="border-brand-ridge/20 bg-white shadow-[0_22px_46px_-34px_rgba(47,47,43,0.38)]">
            <CardHeader className="space-y-2">
              <CardTitle className="font-heading text-3xl text-brand-charcoal">
                Enter your details
              </CardTitle>
              <CardDescription className="text-base text-brand-deep/75">
                This form creates a membership application only. It does not
                create a TAC login until nominators and the committee approve
                it.
              </CardDescription>
            </CardHeader>

            <form onSubmit={handleSubmit}>
              <CardContent className="space-y-6">
                {error && (
                  <div className="rounded-md border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                    {error}
                  </div>
                )}

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="applicantFirstName">First name</Label>
                    <Input
                      id="applicantFirstName"
                      value={form.applicantFirstName}
                      onChange={updateField("applicantFirstName")}
                      autoComplete="given-name"
                    />
                    {fieldErrors.applicantFirstName && (
                      <p className="text-xs text-destructive">
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
                    />
                    {fieldErrors.applicantLastName && (
                      <p className="text-xs text-destructive">
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
                  />
                  {fieldErrors.applicantEmail && (
                    <p className="text-xs text-destructive">
                      {fieldErrors.applicantEmail}
                    </p>
                  )}
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="applicantDateOfBirth">
                      Date of birth{" "}
                      <span className="font-normal text-muted-foreground">
                        (optional)
                      </span>
                    </Label>
                    <Input
                      id="applicantDateOfBirth"
                      type="date"
                      value={form.applicantDateOfBirth}
                      onChange={updateField("applicantDateOfBirth")}
                      autoComplete="bday"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Phone</Label>
                    <div className="flex gap-2">
                      <Input
                        className="w-20"
                        placeholder="64"
                        value={form.phoneCountryCode}
                        onChange={updateField("phoneCountryCode")}
                        aria-label="Phone country code"
                      />
                      <Input
                        className="w-20"
                        placeholder="27"
                        value={form.phoneAreaCode}
                        onChange={updateField("phoneAreaCode")}
                        aria-label="Phone area code"
                      />
                      <Input
                        className="flex-1"
                        placeholder="123 4567"
                        value={form.phoneNumber}
                        onChange={updateField("phoneNumber")}
                        aria-label="Phone number"
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Country code, area code, and number
                    </p>
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
                        Dependents
                      </h2>
                      <p className="text-sm text-brand-deep/70">
                        Add any dependent children included in this application.
                      </p>
                    </div>
                    <Button type="button" variant="outline" onClick={addFamilyMember}>
                      Add dependent
                    </Button>
                  </div>

                  {form.familyMembers.length === 0 ? (
                    <p className="text-sm text-brand-deep/70">
                      No dependents added yet.
                    </p>
                  ) : (
                    <div className="space-y-4">
                      {form.familyMembers.map((familyMember, index) => (
                        <div
                          key={`${index}-${familyMember.firstName}-${familyMember.lastName}`}
                          className="space-y-4 rounded-lg border border-brand-ridge/20 bg-white p-4"
                        >
                          <div className="flex items-center justify-between gap-4">
                            <h3 className="font-medium text-brand-charcoal">
                              Dependent {index + 1}
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
                              <Label htmlFor={`family-first-name-${index}`}>First name</Label>
                              <Input
                                id={`family-first-name-${index}`}
                                value={familyMember.firstName}
                                onChange={(event) =>
                                  updateFamilyMember(index, "firstName", event.target.value)
                                }
                              />
                              {fieldErrors[`familyMembers.${index}.firstName`] && (
                                <p className="text-xs text-destructive">
                                  {fieldErrors[`familyMembers.${index}.firstName`]}
                                </p>
                              )}
                            </div>

                            <div className="space-y-2">
                              <Label htmlFor={`family-last-name-${index}`}>Last name</Label>
                              <Input
                                id={`family-last-name-${index}`}
                                value={familyMember.lastName}
                                onChange={(event) =>
                                  updateFamilyMember(index, "lastName", event.target.value)
                                }
                              />
                              {fieldErrors[`familyMembers.${index}.lastName`] && (
                                <p className="text-xs text-destructive">
                                  {fieldErrors[`familyMembers.${index}.lastName`]}
                                </p>
                              )}
                            </div>
                          </div>

                          <div className="space-y-2">
                            <Label htmlFor={`family-dob-${index}`}>Date of birth</Label>
                            <Input
                              id={`family-dob-${index}`}
                              type="date"
                              value={familyMember.dateOfBirth}
                              onChange={(event) =>
                                updateFamilyMember(index, "dateOfBirth", event.target.value)
                              }
                            />
                            {fieldErrors[`familyMembers.${index}.dateOfBirth`] && (
                              <p className="text-xs text-destructive">
                                {fieldErrors[`familyMembers.${index}.dateOfBirth`]}
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
                      Enter the email addresses of two active, paid-up TAC
                      members who have agreed to nominate you.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="nominator1Email">First nominator email</Label>
                    <Input
                      id="nominator1Email"
                      type="email"
                      value={form.nominator1Email}
                      onChange={updateField("nominator1Email")}
                    />
                    {fieldErrors.nominator1Email && (
                      <p className="text-xs text-destructive">
                        {fieldErrors.nominator1Email}
                      </p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="nominator2Email">Second nominator email</Label>
                    <Input
                      id="nominator2Email"
                      type="email"
                      value={form.nominator2Email}
                      onChange={updateField("nominator2Email")}
                    />
                    {fieldErrors.nominator2Email && (
                      <p className="text-xs text-destructive">
                        {fieldErrors.nominator2Email}
                      </p>
                    )}
                  </div>
                </div>
              </CardContent>

              <CardFooter className="flex flex-col gap-4">
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? "Submitting application..." : "Submit membership application"}
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
