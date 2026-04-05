import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSeasonYear } from "@/lib/utils";
import { ProfileForm } from "./profile-form";
import { ChangeEmailForm } from "./change-email-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
      subscriptions: {
        where: { seasonYear: currentSeasonYear },
        select: { status: true, seasonYear: true },
        take: 1,
      },
    },
  });

  if (!member) redirect("/login");

  const subscriptionStatus = member.subscriptions[0]?.status ?? null;
  const seasonLabel = `${currentSeasonYear}/${currentSeasonYear + 1}`;

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
    </div>
  );
}
