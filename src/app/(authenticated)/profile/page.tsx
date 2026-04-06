import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSeasonYear } from "@/lib/utils";
import { ProfileForm } from "./profile-form";
import { ChangeEmailForm } from "./change-email-form";
import { NotificationPreferences } from "./notification-preferences";
import { DependentsSection } from "./dependents-section";
import { FamilyGroupSection } from "./family-group-section";
import { DataExportButton } from "./data-export-button";
import { DeleteAccountButton } from "./delete-account-button";
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

export default async function ProfilePage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const currentSeasonYear = getSeasonYear(new Date());

  const member = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      phone: true,
      dateOfBirth: true,
      role: true,
      ageTier: true,
      active: true,
      createdAt: true,
      passwordChangedAt: true,
      parentMemberId: true,
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
      subscriptions: {
        orderBy: { seasonYear: "desc" },
        select: { status: true, seasonYear: true },
      },
    },
  });

  if (!member) redirect("/login");

  const dependents = await prisma.member.findMany({
    where: {
      OR: [
        { parentMemberId: session.user.id },
        { secondaryParentId: session.user.id },
      ],
      active: true,
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      ageTier: true,
      dateOfBirth: true,
      email: true,
      inheritParentEmail: true,
    },
    orderBy: { firstName: "asc" },
  });

  const currentSub = member.subscriptions.find(s => s.seasonYear === currentSeasonYear);
  const subscriptionStatus = currentSub?.status ?? null;
  const seasonLabel = `${currentSeasonYear}/${currentSeasonYear + 1}`;
  const subscriptionHistory = member.subscriptions;

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Profile</h1>
        <p className="mt-1 text-sm text-slate-500">
          Manage your account details
        </p>
      </div>

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
            {subscriptionStatus === "PAID" ? (
              <Badge className="bg-green-100 text-green-800 border-green-200">
                Paid
              </Badge>
            ) : subscriptionStatus === "UNPAID" ? (
              <Badge className="bg-yellow-100 text-yellow-800 border-yellow-200">
                Unpaid
              </Badge>
            ) : subscriptionStatus === "OVERDUE" ? (
              <Badge className="bg-red-100 text-red-800 border-red-200">
                Overdue
              </Badge>
            ) : (
              <Badge variant="secondary" className="bg-slate-100 text-slate-600">
                Not Invoiced
              </Badge>
            )}
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
      <Card>
        <CardHeader>
          <CardTitle>Subscription History</CardTitle>
          <CardDescription>
            Your membership payment status across seasons
          </CardDescription>
        </CardHeader>
        <CardContent>
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
                    {sub.status === "PAID" ? (
                      <Badge className="bg-green-100 text-green-800 border-green-200">
                        Paid
                      </Badge>
                    ) : sub.status === "UNPAID" ? (
                      <Badge className="bg-yellow-100 text-yellow-800 border-yellow-200">
                        Unpaid
                      </Badge>
                    ) : sub.status === "OVERDUE" ? (
                      <Badge className="bg-red-100 text-red-800 border-red-200">
                        Overdue
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="bg-slate-100 text-slate-600">
                        {sub.status}
                      </Badge>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Family Group */}
      {!member.parentMemberId && (
        <Card>
          <CardHeader>
            <CardTitle>Family Group</CardTitle>
            <CardDescription>
              Link with your partner/spouse so you appear in each other&apos;s booking quick-add lists
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FamilyGroupSection
              familyGroupId={member.familyGroupId}
              familyGroupName={member.familyGroup?.name ?? null}
              familyGroupMembers={
                member.familyGroup?.memberships
                  .map((ms) => ms.member)
                  .filter((m) => m.id !== member.id)
                  .map((m) => ({ id: m.id, firstName: m.firstName, lastName: m.lastName })) ?? []
              }
            />
          </CardContent>
        </Card>
      )}

      {/* Dependents */}
      <Card>
        <CardHeader>
          <CardTitle>Dependents</CardTitle>
          <CardDescription>
            Manage dependents who share your account (e.g. children). They get member pricing when you book.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DependentsSection
            initialDependents={dependents.map((d) => ({
              id: d.id,
              firstName: d.firstName,
              lastName: d.lastName,
              ageTier: d.ageTier,
              dateOfBirth: d.dateOfBirth ? d.dateOfBirth.toISOString().substring(0, 10) : null,
              email: d.email,
              inheritParentEmail: d.inheritParentEmail,
            }))}
          />
        </CardContent>
      </Card>

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

      {/* Notification Preferences */}
      <Card>
        <CardHeader>
          <CardTitle>Notification Preferences</CardTitle>
          <CardDescription>
            Choose which email notifications you receive
          </CardDescription>
        </CardHeader>
        <CardContent>
          <NotificationPreferences />
        </CardContent>
      </Card>

      {/* Editable profile */}
      <Card>
        <CardHeader>
          <CardTitle>Personal Details</CardTitle>
          <CardDescription>
            Update your name, phone number, and date of birth
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ProfileForm
            member={{
              id: member.id,
              firstName: member.firstName,
              lastName: member.lastName,
              phone: member.phone ?? "",
              dateOfBirth: member.dateOfBirth
                ? member.dateOfBirth.toISOString().substring(0, 10)
                : "",
            }}
          />
        </CardContent>
      </Card>

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
