import Link from "next/link";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Bell, Mail, MessageSquareText, Send, UserX } from "lucide-react";
import { adminHref, adminTabHref } from "@/lib/admin-hubs";

const sections = [
  {
    href: adminHref("notification-rules"),
    title: "Delivery Rules",
    description:
      "Control which admin and system emails are sent when jobs or alerts run.",
    icon: Send,
  },
  {
    href: adminHref("notification-recipients"),
    title: "Recipients",
    description:
      "Choose which system alerts each admin user receives, within the areas their role can edit.",
    icon: Bell,
  },
  {
    href: adminHref("email-messages"),
    title: "Email Messages",
    description:
      "Edit shared email variables and message wording for audited templates.",
    icon: Mail,
  },
  {
    href: adminHref("booking-messages"),
    title: "Booking Messages",
    description:
      "Edit member-facing booking, payment, cancellation, and group booking copy.",
    icon: MessageSquareText,
  },
  {
    // The Settings tab of Membership Cancellations since S1 (#4796).
    href: adminTabHref("membership-cancellations", "settings"),
    title: "Membership Cancellation",
    description:
      "Configure cancellation copy and Xero handling for member cancellation requests.",
    icon: UserX,
  },
];

export default function NotificationsHubPage() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-foreground">
          Notifications &amp; Email
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage delivery rules, recipients, and the wording of automated
          emails.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {sections.map(({ href, title, description, icon: Icon }) => (
          <Link key={href} href={href} className="group block">
            <Card className="h-full transition-colors hover:border-brand-gold/70">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Icon className="h-5 w-5 shrink-0 text-foreground" />
                  <CardTitle>{title}</CardTitle>
                </div>
                <CardDescription>{description}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
