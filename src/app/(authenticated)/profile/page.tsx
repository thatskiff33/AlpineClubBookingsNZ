import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/utils";
import { clubSeasonYear } from "@/lib/financial-year";
import { seasonSelectLabel } from "@/lib/season-label";
import {
  ProfileDetailsCard,
  ProfileDetailsPageActions,
  ProfileDetailsProvider,
} from "./profile-details-card";
import { ProfileSectionCard } from "./profile-section-card";
import { ChangeEmailForm } from "./change-email-form";
import { NotificationPreferences } from "./notification-preferences";
import { PostLoginLandingPreference } from "./post-login-landing-preference";
import { FamilyGroupSection } from "./family-group-section";
import { PartnerLinkSection } from "./partner-link-section";
import { AccountCreditSection } from "./account-credit-section";
import { ProfilePhotoSection } from "./profile-photo-section";
import { DataExportButton } from "./data-export-button";
import { DeleteAccountButton } from "./delete-account-button";
import { MembershipCancellationPanel } from "./membership-cancellation-panel";
import { TwoFactorSecurityCard } from "./two-factor-security-card";
import { GoogleAccountCard } from "./google-account-card";
import { googleCredentialsConfigured } from "@/lib/google-oauth";
import { AuditTimeline } from "@/components/audit-timeline";
import { SectionNav, type SectionNavItem } from "@/components/section-nav";
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
import {
  subscriptionStatusClass,
  subscriptionStatusLabel,
} from "@/lib/status-colors";
import { loadMemberFieldsFlags } from "@/lib/member-fields-settings";
import { requiresPaidSubscriptionForMemberForBooking } from "@/lib/membership-type-policy";
import { hasAdminAccess } from "@/lib/access-roles";
import { getFirstAccessibleAdminHref } from "@/lib/admin-permissions";
import { MEMBER_ACCESS_ROLE_SELECT } from "@/lib/access-role-definitions";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { clubTime } from "@/lib/club-time/server";
import { formatDateOnly } from "@/lib/date-only";

function singleSearchParam(value?: string | string[]) {
  return Array.isArray(value) ? value[0] : value;
}

function formatPromoBenefit(promo: {
  fixedNightlyMode: string | null;
  fixedNightlyPriceCents: number | null;
  freeNightsPerIndividual: number | null;
  lifetimeFreeNightsCap: number | null;
  percentOff: number | null;
  type: string;
  valueCents: number | null;
}) {
  if (promo.type === "PERCENTAGE") {
    return promo.percentOff !== null
      ? `${promo.percentOff}% off per individual`
      : "Percentage discount";
  }

  if (promo.type === "FIXED_AMOUNT") {
    return promo.valueCents !== null
      ? `${formatCents(promo.valueCents)} off per individual`
      : "Fixed discount";
  }

  if (promo.type === "FREE_NIGHTS") {
    if (promo.freeNightsPerIndividual === null) {
      return "Free nights";
    }
    const perBooking = `${promo.freeNightsPerIndividual} free night${promo.freeNightsPerIndividual === 1 ? "" : "s"} per booking`;
    if (promo.lifetimeFreeNightsCap !== null) {
      return `${perBooking} · ${promo.lifetimeFreeNightsCap} lifetime`;
    }
    return perBooking;
  }

  if (promo.type === "FIXED_NIGHTLY_PRICE") {
    if (promo.fixedNightlyPriceCents === null) {
      return "Fixed nightly price";
    }
    const price = `${formatCents(promo.fixedNightlyPriceCents)} per eligible night`;
    return promo.fixedNightlyMode === "SET_PRICE"
      ? `${price} · set price`
      : `${price} · cap only`;
  }

  return promo.type.replaceAll("_", " ").toLowerCase();
}

// Anchor rail for this long (~13 card) page. Every section below is rendered
// unconditionally, so SectionNav keeps them all; ordering matches the page.
const PROFILE_SECTIONS: SectionNavItem[] = [
  { id: "profile-photo", label: "Profile Photo" },
  { id: "account-information", label: "Account Information" },
  { id: "security", label: "Security" },
  { id: "subscription-history", label: "Subscription History" },
  { id: "account-credit", label: "Account Credit" },
  { id: "promo-codes", label: "Promo Codes" },
  { id: "family-group", label: "Family Group" },
  { id: "partner", label: "Partner" },
  { id: "membership-cancellation", label: "Membership Cancellation" },
  { id: "notification-preferences", label: "Notification Preferences" },
  { id: "change-email", label: "Change Email" },
  { id: "personal-details", label: "Personal Details" },
  { id: "account-activity", label: "Account Activity" },
  { id: "privacy-data", label: "Privacy & Data" },
];

export default async function ProfilePage({
  searchParams,
}: {
  searchParams: Promise<{
    emailChangeError?: string | string[];
    emailChanged?: string | string[];
    returnTo?: string | string[];
    googleLinked?: string | string[];
    googleError?: string | string[];
  }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const params = await searchParams;
  const emailChangeError = singleSearchParam(params.emailChangeError);
  const emailChanged = singleSearchParam(params.emailChanged) === "true";
  const googleLinked = singleSearchParam(params.googleLinked) === "1";
  const googleError = singleSearchParam(params.googleError);
  const returnTo = getSafeInternalReturnPath(params.returnTo);

  // `createdAt` and `passwordChangedAt` are real INSTANTS, so the civil day each
  // reads as comes from the club's PERSISTED timezone rather than the
  // container's (CT-4, #2870; INV-CONFIG-002).
  const club = await clubTime();

  // The season the CLUB is in, from that same persisted zone. This line used to
  // carry a comment saying it deliberately stayed on the host's clock because no
  // call site could fix itself — which was true of the helper it called, and is
  // the reason the fix had to be a new zone-aware function rather than a better
  // argument (CT-4 group F1, #2870).
  const currentSeasonYear = clubSeasonYear(club.zone);

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
      financeAccessLevel: true,
      // Joined definitions so getFirstAccessibleAdminHref resolves the merged
      // matrix (custom / club-edited roles included) for the landing-preference
      // control's visibility (#2090).
      accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT },
      postLoginLanding: true,
      ageTier: true,
      occupation: true,
      lodgeScreenPhoneOptIn: true,
      photoImageId: true,
      photoUpdatedAt: true,
      active: true,
      createdAt: true,
      passwordChangedAt: true,
      twoFactorEnabled: true,
      twoFactorMethod: true,
      googleSub: true,
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
                select: {
                  member: {
                    select: { id: true, firstName: true, lastName: true },
                  },
                },
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
  const isAdmin = hasAdminAccess(member);
  // The landing-preference control (#2090) is offered to any member whose role
  // resolves to an admin page (Full Admin, scoped admins, finance viewers) —
  // i.e. those affected by the new admin default, who may want to opt back to
  // the member dashboard. Members with no accessible admin page have no
  // meaningful choice, so the control is hidden.
  const canChooseLanding = getFirstAccessibleAdminHref(member) !== null;

  const currentSub = member.subscriptions.find(
    (s) => s.seasonYear === currentSeasonYear,
  );
  const subscriptionRequired =
    await requiresPaidSubscriptionForMemberForBooking(prisma, {
      memberId: member.id,
      seasonYear: currentSeasonYear,
      ageTier: member.ageTier,
    });
  const subscriptionStatus = subscriptionRequired
    ? (currentSub?.status ?? null)
    : "NOT_REQUIRED";
  const subscriptionHistory = member.subscriptions;
  const availablePromoCodes = await getAvailablePromoCodesForMember(member.id);
  const memberFieldsFlags = await loadMemberFieldsFlags();
  const modules = await loadEffectiveModuleFlags();
  const showTwoFactorSecurityCard =
    modules.twoFactor || member.twoFactorEnabled;
  const googleLinkedNow = Boolean(member.googleSub);
  // Show the Connected-accounts control when the club offers Google sign-in, or
  // whenever the member already has an account linked (so they can disconnect it
  // even after the club turns the module off).
  const showGoogleAccountCard = modules.googleLogin || googleLinkedNow;
  // DB-only Google credential resolution (#2087), only when the card shows.
  // Fail-open to false (Connect stays unavailable) if the store is unreachable.
  const googleConfigured =
    showGoogleAccountCard && modules.googleLogin
      ? await googleCredentialsConfigured()
      : false;
  const profileFormMember = {
    id: member.id,
    firstName: member.firstName,
    lastName: member.lastName,
    phoneCountryCode: member.phoneCountryCode ?? "",
    phoneAreaCode: member.phoneAreaCode ?? "",
    phoneNumber: member.phoneNumber ?? "",
    dateOfBirth: member.dateOfBirth
      ? formatDateOnly(member.dateOfBirth)
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
    occupation: member.occupation ?? "",
    lodgeScreenPhoneOptIn: member.lodgeScreenPhoneOptIn,
  };

  return (
    <ProfileDetailsProvider>
      <div className="lg:flex lg:gap-8">
        <SectionNav sections={PROFILE_SECTIONS} className="mb-6 lg:mb-0" />
        <div className="min-w-0 max-w-2xl flex-1 space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Profile</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Manage your account details
            </p>
          </div>
          <ProfileDetailsPageActions />
        </div>

        {emailChanged ? (
          <div className="rounded-lg border border-success-6 bg-success-3 px-4 py-3 text-sm text-success-11">
            Your email address has been updated successfully.
          </div>
        ) : null}

        {emailChangeError ? (
          <div className="rounded-lg border border-danger-6 bg-danger-3 px-4 py-3 text-sm text-danger-11">
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

        {/* Profile photo */}
        <Card id="profile-photo" className="scroll-mt-20">
          <CardHeader>
            <CardTitle>Profile Photo</CardTitle>
            <CardDescription>
              Add a photo of yourself. Committee members&apos; photos appear on
              the public committee page.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ProfilePhotoSection
              memberId={member.id}
              memberName={`${member.firstName} ${member.lastName}`.trim()}
              initialHasPhoto={member.photoImageId !== null}
              initialPhotoVersion={
                member.photoUpdatedAt
                  ? member.photoUpdatedAt.toISOString()
                  : null
              }
            />
          </CardContent>
        </Card>

        {/* Account info */}
        <Card id="account-information" className="scroll-mt-20">
          <CardHeader>
            <div className="flex items-start justify-between">
              <div>
                <CardTitle>Account Information</CardTitle>
                <CardDescription>
                  Your membership details and status
                </CardDescription>
              </div>
              <div className="flex gap-2">
                <Badge variant={isAdmin ? "default" : "secondary"}>
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
                {club.instantDate(member.createdAt)}
              </span>
            </div>
            <Separator />
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">
                Subscription {seasonSelectLabel(currentSeasonYear)}
              </span>
              <Badge
                className={subscriptionStatusClass(
                  subscriptionStatus ?? "NOT_INVOICED",
                )}
              >
                {subscriptionStatusLabel(subscriptionStatus ?? "NOT_INVOICED")}
              </Badge>
            </div>
            {canChooseLanding ? <PostLoginLandingPreference /> : null}
          </CardContent>
        </Card>

        {/* Security */}
        <Card id="security" className="scroll-mt-20">
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
                    {club.instantDate(member.passwordChangedAt)}
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
            {showTwoFactorSecurityCard ? (
              <TwoFactorSecurityCard
                enabled={member.twoFactorEnabled}
                method={member.twoFactorMethod}
                moduleEnabled={modules.twoFactor}
              />
            ) : null}
            {googleLinked ? (
              <div className="rounded-md border border-success-6 bg-success-3 px-3 py-2 text-sm text-success-11">
                Your Google account has been connected.
              </div>
            ) : null}
            {googleError ? (
              <div className="rounded-md border border-danger-6 bg-danger-3 px-3 py-2 text-sm text-danger-11">
                {googleError === "unverified"
                  ? "That Google account's email is not verified, so it cannot be linked."
                  : googleError === "already_linked"
                    ? "That Google account is already linked to another member."
                    : googleError === "account_conflict"
                      ? "Your account is already linked to a different Google account. Disconnect it first."
                      : googleError === "disabled"
                        ? "Google sign-in is currently turned off by your club."
                        : "Google account linking could not be completed. Please try again."}
              </div>
            ) : null}
            {showGoogleAccountCard ? (
              <GoogleAccountCard
                linked={googleLinkedNow}
                moduleEnabled={modules.googleLogin}
                credentialsConfigured={googleConfigured}
              />
            ) : null}
          </CardContent>
        </Card>

        {/* Subscription History */}
        <ProfileSectionCard
          className="scroll-mt-20"
          collapsible
          defaultOpen={false}
          description="Your membership payment status across seasons"
          id="subscription-history"
          title="Subscription History"
        >
          {subscriptionHistory.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No subscription records — contact the club if this seems wrong.
            </p>
          ) : (
            <div className="divide-y">
              {subscriptionHistory.map((sub) => {
                const label = seasonSelectLabel(sub.seasonYear);
                const isCurrent = sub.seasonYear === currentSeasonYear;
                return (
                  <div
                    key={sub.seasonYear}
                    className="flex justify-between items-center py-2.5"
                  >
                    <span className="text-sm">
                      {label}
                      {isCurrent && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          (current)
                        </span>
                      )}
                    </span>
                    <Badge className={subscriptionStatusClass(sub.status)}>
                      {subscriptionStatusLabel(sub.status)}
                    </Badge>
                  </div>
                );
              })}
            </div>
          )}
        </ProfileSectionCard>

        {/* Account Credit */}
        <ProfileSectionCard
          className="scroll-mt-20"
          description="Your credit balance and transaction history"
          id="account-credit"
          title="Account Credit"
        >
          <AccountCreditSection />
        </ProfileSectionCard>

        {/* Promo Codes */}
        <ProfileSectionCard
          className="scroll-mt-20"
          description="Promo codes assigned to your member account"
          id="promo-codes"
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
          className="scroll-mt-20"
          collapsible
          defaultOpen
          description="Manage your family group members. Adults can invite other adults, and request to add infants, children, or youth."
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

        {/* Partner (#1742) */}
        <ProfileSectionCard
          className="scroll-mt-20"
          collapsible
          defaultOpen
          description="Record your partner (husband, wife, or partner) with the club. Both of you confirm the relationship."
          id="partner"
          title="Partner"
        >
          <PartnerLinkSection
            canManage={member.ageTier === "ADULT" && member.canLogin === true}
          />
        </ProfileSectionCard>

        <ProfileSectionCard
          className="scroll-mt-20"
          collapsible
          defaultOpen={false}
          description="Request committee review for membership cancellation."
          id="membership-cancellation"
          title="Membership Cancellation"
        >
          <MembershipCancellationPanel />
        </ProfileSectionCard>

        {/* Notification Preferences */}
        <ProfileSectionCard
          className="scroll-mt-20"
          collapsible
          defaultOpen
          description="Choose which email notifications you receive"
          id="notification-preferences"
          title="Notification Preferences"
        >
          <NotificationPreferences />
        </ProfileSectionCard>

        {/* Change Email */}
        <Card id="change-email" className="scroll-mt-20">
          <CardHeader>
            <CardTitle>Change Email</CardTitle>
            <CardDescription>
              Update your email address. You will need to verify the new
              address.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ChangeEmailForm currentEmail={member.email} />
          </CardContent>
        </Card>

        <div id="personal-details" className="scroll-mt-20">
          <ProfileDetailsCard
            member={profileFormMember}
            returnTo={returnTo}
            ageTier={member.ageTier}
            showOccupation={memberFieldsFlags.showOccupation}
          />
        </div>

        {/* Account Activity */}
        <ProfileSectionCard
          className="scroll-mt-20"
          collapsible
          defaultOpen={false}
          description="Recent account, booking, payment, family, and privacy activity"
          id="account-activity"
          title="Account Activity"
        >
          <AuditTimeline
            endpoint="/api/member/audit-log"
            categoryOptions={MEMBER_AUDIT_TIMELINE_CATEGORY_OPTIONS}
            showMetadata={false}
          />
        </ProfileSectionCard>

        {/* Privacy & Data */}
        <Card id="privacy-data" className="scroll-mt-20">
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
              {!isAdmin && <DeleteAccountButton />}
              {isAdmin && (
                <p className="text-sm text-muted-foreground italic">
                  Admin accounts cannot be self-deleted. Contact another admin.
                </p>
              )}
            </div>
          </CardContent>
        </Card>
        </div>
      </div>
    </ProfileDetailsProvider>
  );
}
