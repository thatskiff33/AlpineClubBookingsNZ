import { BackLink } from "@/components/admin/back-link";
import { adminHref } from "@/lib/admin-hubs";
import { ClubContactPanel } from "@/components/admin/club-contact-panel";
import {
  CLUB_IDENTITY_TITLE,
  ClubIdentityPanel,
} from "@/components/admin/club-identity-panel";
import { LodgeDetailsPanel } from "@/components/admin/lodge-details-panel";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function ClubIdentityAdminPage() {
  return (
    <div className="space-y-6">
      <div>
        <BackLink href={adminHref("appearance")} label="Site Appearance & Content" />
        <h1 className="mt-2 text-2xl font-bold text-foreground">
          Club Identity
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Set the club name, short name, and hut-leader label used across the
          site and emails, plus your lodge&apos;s public details.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{CLUB_IDENTITY_TITLE}</CardTitle>
          <CardDescription>
            Overrides the file configuration. Blank fields fall back to the
            configured defaults.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ClubIdentityPanel />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Lodge details</CardTitle>
          <CardDescription>
            Name, address, travel note, and door code for your lodge.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <LodgeDetailsPanel />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Club Contact</CardTitle>
          <CardDescription>
            Which committee role appears in the Contact page&apos;s Club Details
            box.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ClubContactPanel />
        </CardContent>
      </Card>
    </div>
  );
}
