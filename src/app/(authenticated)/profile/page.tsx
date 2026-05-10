import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { formatCents, getSeasonYear } from "@/lib/utils";
import { ProfileDetailsCard } from "./profile-details-card";
import { ProfileSectionCard } from "./profile-section-card";
import { ChangeEmailForm } from "./change-email-form";
import { NotificationPreferences } from "./notification-preferences";
import { FamilyGroupSection } from "./family-group-section";
import { AccountCreditSection } from "./account-credit-section";
import { DataExportButton } from "./data-export-button";
import { DeleteAccountButton } from "./delete-account-button";
import { AuditTimeline } from "@/components/audit-timeline";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { MEMBER_AUDIT_TIMELINE_CATEGORY_OPTIONS } from "@/lib/audit-query";
import { getSafeInternalReturnPath } from "@/lib/internal-return-path";
import { getAvailablePromoCodesForMember } from "@/lib/promo";
import { subscriptionStatusClass } from "@/lib/status-colors";

function singleSearchParam(value?: string | string[]) {
  return Array.isArray(value) ? value[0] : value;
}

function formatPromoBenefit(promo: {
  freeNights: number | null;
  percentOff: number | null;
  type: string;
  valueCents: number | null;
}) {
  if (promo.type === "PERCENTAGE") {
    return promo.percentOff !== null
      ? `${promo.percentOff}% off`
      : "Percentage discount";
  }

  if (promo.type === "FIXED_AMOUNT") {
    return promo.valueCents !== null
      ? `${formatCents(promo.valueCents)} off`
      : "Fixed discount";
  }

  if (promo.type === "FREE_NIGHTS") {
    if (promo.freeNights === null) {
      return "Free nights";
    }

    return `${promo.freeNights} free night${promo.freeNights === 1 ? "" : "s"}`;
  }

  return promo.type.replaceAll("_", " ").toLowerCase();
}

export default async function ProfilePage({
  searchParams,
}: {
  searchParams: Promise<{
    emailChangeError?: string | string[];
    emailChanged?: string | string[];
    returnTo?: string | string[];
  }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const params = await searchParams;
  const emailChangeError = singleSearchParam(params.emailChangeError);
  const emailChanged = singleSearchParam(params.emailChanged) === "true";
  const returnTo = getSafeInternalReturnPath(params.returnTo);

  const currentSeasonYear = getSeasonYear(new Date());

  const member = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      phoneCountryCode: true,
      phoneAreaCode: true,
      phoneNumber: true,
      dateOfBirth: true,
      streetAddressLine1: true,
      streetAddressLine2: true,
      streetCity: true,
      streetRegion: true,
      streetPostalCode: true,
      streetCountry: true,
      postalAddressLine1: true,
      postalAddressLine2: true,
      postalCity: true,
      postalRegion: true,
      postalPostalCode: true,
      postalCountry: true,
      role: true,
      ageTier: true,
      active: true,
      createdAt: true,
      passwordChangedAt: true,
      canLogin: true,
      familyGroupMemberships: {
        select: {
          familyGroupId: true,
          familyGroup: {
            select: {
              id: true,
              name: true,
              memberships: {
                where: { member: { active: true } },
                select: { member: { select: { id: true, firstName: true, lastName: true } } },
              },
            },
          },
        },
      },
      subscriptions: {
        orderBy: { seasonYear: "desc" },
        select: { status: true, seasonYear: true },
      },
    },
  });

  if (!member) redirect("/login");

  const currentSub = member.subscriptions.find(s => s.seasonYear === currentSeasonYear);
  const subscriptionStatus = currentSub?.status ?? null;
  const seasonLabel = `${currentSeasonYear}/${currentSeasonYear + 1}`;
  const subscriptionHistory = member.subscriptions;
  const availablePromoCodes = await getAvailablePromoCodesForMember(member.id);
  const profileFormMember = {
    id: member.id,
    firstName: member.firstName,
    lastName: member.lastName,
    phoneCountryCode: member.phoneCountryCode ?? "",
    phoneAreaCode: member.phoneAreaCode ?? "",
    phoneNumber: member.phoneNumber ?? "",
    dateOfBirth: member.dateOfBirth
      ? member.dateOfBirth.toISOString().substring(0, 10)
      : "",
    streetAddressLine1: member.streetAddressLine1 ?? "",
    streetAddressLine2: member.streetAddressLine2 ?? "",
    streetCity: member.streetCity ?? "",
    streetRegion: member.streetRegion ?? "",
    streetPostalCode: member.streetPostalCode ?? "",
    streetCountry: member.streetCountry ?? "",
    postalAddressLine1: member.postalAddressLine1 ?? "",
    postalAddressLine2: member.postalAddressLine2 ?? "",
    postalCity: member.postalCity ?? "",
    postalRegion: member.postalRegion ?? "",
    postalPostalCode: member.postalPostalCode ?? "",
    postalCountry: member.postalCountry ?? "",
  };

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Profile</h1>
        <p className="mt-1 text-sm text-slate-500">
          Manage your account details
        </p>
      </div>

      {emailChanged ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          Your email address has been updated successfully.
        </div>
      ) : null}

      {emailChangeError ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {emailChangeError === "missing"
            ? "The email change link was incomplete."
            : emailChangeError === "invalid"
              ? "That email change link is invalid."
              : emailChangeError === "expired"
                ? "That email change link has expired."
                : emailChangeError === "taken"
                  ? "That email address is already in use."
                  : "The email change could not be completed."}
        </div>
      ) : null}

      {/* Account info */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between">
            <div>
              <CardTitle>Account Information</CardTitle>
              <CardDescription>
                Your membership details and status
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Badge variant={member.role === "ADMIN" ? "default" : "secondary"}>
                {member.role}
              </Badge>
              <Badge variant={member.active ? "default" : "destructive"}>
                {member.active ? "Active" : "Inactive"}
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Email</span>
            <span className="font-medium">{member.email}</span>
          </div>
          <Separator />
          <div className="flex justify-between">
            <span className="text-muted-foreground">Age Tier</span>
            <span className="font-medium">{member.ageTier}</span>
          </div>
          <Separator />
          <div className="flex justify-between">
            <span className="text-muted-foreground">Member Since</span>
            <span className="font-medium">
              {new Date(member.createdAt).toLocaleDateString("en-NZ", {
                day: "numeric",
                month: "long",
                year: "numeric",
              })}
            </span>
          </div>
          <Separator />
          <div className="flex justify-between items-center">
            <span className="text-muted-foreground">
              Subscription ({seasonLabel})
            </span>
            <Badge className={subscriptionStatusClass(subscriptionStatus ?? "NOT_INVOICED")}>
              {subscriptionStatus === "PAID" ? "Paid" : subscriptionStatus === "UNPAID" ? "Unpaid" : subscriptionStatus === "OVERDUE" ? "Overdue" : "Not Invoiced"}
            </Badge>
          </div>
        </CardContent>
      </Card>

      {/* Security */}
      <Card>
        <CardHeader>
          <CardTitle>Security</CardTitle>
          <CardDescription>
            Manage your password and account security
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex justify-between items-center">
            <div>
              <span className="text-muted-foreground">Password</span>
              {member.passwordChangedAt ? (
                <p className="text-xs text-muted-foreground mt-0.5">
                  Last changed{" "}
                  {new Date(member.passwordChangedAt).toLocaleDateString("en-NZ", {
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                  })}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground mt-0.5">
                  Never changed
                </p>
              )}
            </div>
            <Button asChild variant="outline" size="sm">
              <Link href="/change-password">Change Password</Link>
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Subscription History */}
      <ProfileSectionCard
        collapsible
        defaultOpen={false}
        description="Your membership payment status across seasons"
        title="Subscription History"
      >
        {subscriptionHistory.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No subscription records — contact the club if this seems wrong.
          </p>
        ) : (
          <div className="divide-y">
            {subscriptionHistory.map((sub) => {
              const label = `${sub.seasonYear}/${sub.seasonYear + 1}`;
              const isCurrent = sub.seasonYear === currentSeasonYear;
              return (
                <div key={sub.seasonYear} className="flex justify-between items-center py-2.5">
                  <span className="text-sm">
                    {label}
                    {isCurrent && (
                      <span className="ml-2 text-xs text-muted-foreground">(current)</span>
                    )}
                  </span>
                  <Badge className={subscriptionStatusClass(sub.status)}>
                    {sub.status === "PAID" ? "Paid" : sub.status === "UNPAID" ? "Unpaid" : sub.status === "OVERDUE" ? "Overdue" : sub.status.replace("_", " ")}
                  </Badge>
                </div>
              );
            })}
          </div>
        )}
      </ProfileSectionCard>

      {/* Account Credit */}
      <ProfileSectionCard
        description="Your credit balance and transaction history"
        title="Account Credit"
      >
        <AccountCreditSection />
      </ProfileSectionCard>

      {/* Promo Codes */}
      <ProfileSectionCard
        description="Promo codes assigned to your member account"
        title="Promo Codes"
      >
        {availablePromoCodes.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No assigned promo codes available.
          </p>
        ) : (
          <div className="divide-y">
            {availablePromoCodes.map((promo) => (
              <div
                className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0"
                key={promo.code}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className="font-mono" variant="secondary">
                    {promo.code}
                  </Badge>
                  <Badge variant="success">{formatPromoBenefit(promo)}</Badge>
                </div>
                {promo.description ? (
                  <p className="text-sm text-muted-foreground">
                    {promo.description}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </ProfileSectionCard>

      {/* Family Group */}
      <ProfileSectionCard
        collapsible
        defaultOpen
        description="Manage your family group members. Adults can invite other adults, and request to add children or youth."
        id="family-group"
        title="Family Group"
      >
        <FamilyGroupSection
          familyGroups={member.familyGroupMemberships.map((ms) => ({
            id: ms.familyGroup.id,
            name: ms.familyGroup.name,
            members: ms.familyGroup.memberships
              .map((m) => m.member)
              .filter((m) => m.id !== member.id),
          }))}
          canManage={member.ageTier === "ADULT" && member.canLogin === true}
        />
      </ProfileSectionCard>

      {/* Notification Preferences */}
      <ProfileSectionCard
        collapsible
        defaultOpen
        description="Choose which email notifications you receive"
        title="Notification Preferences"
      >
        <NotificationPreferences />
      </ProfileSectionCard>

      {/* Change Email */}
      <Card>
        <CardHeader>
          <CardTitle>Change Email</CardTitle>
          <CardDescription>
            Update your email address. You will need to verify the new address.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChangeEmailForm currentEmail={member.email} />
        </CardContent>
      </Card>

      <ProfileDetailsCard member={profileFormMember} returnTo={returnTo} />

      {/* Account Activity */}
      <ProfileSectionCard
        collapsible
        defaultOpen={false}
        description="Recent account, booking, payment, family, and privacy activity"
        title="Account Activity"
      >
        <AuditTimeline
          endpoint="/api/member/audit-log"
          categoryOptions={MEMBER_AUDIT_TIMELINE_CATEGORY_OPTIONS}
          showMetadata={false}
        />
      </ProfileSectionCard>

      {/* Privacy & Data */}
      <Card>
        <CardHeader>
          <CardTitle>Privacy &amp; Data</CardTitle>
          <CardDescription>
            Download a copy of your data or request account deletion
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <p className="text-sm text-muted-foreground mb-2">
              Download a machine-readable copy of all data the system holds
              about you (JSON format, max 5 times per day).
            </p>
            <DataExportButton />
          </div>
          <div className="pt-2 border-t">
            <p className="text-sm text-muted-foreground mb-2">
              Request permanent deletion of your account. An admin will review
              your request. This action is irreversible.
            </p>
            {member.role !== "ADMIN" && <DeleteAccountButton />}
            {member.role === "ADMIN" && (
              <p className="text-sm text-slate-500 italic">
                Admin accounts cannot be self-deleted. Contact another admin.
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
