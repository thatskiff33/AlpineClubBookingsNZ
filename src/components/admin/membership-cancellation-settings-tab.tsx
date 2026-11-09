"use client";

import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { MembershipCancellationSettingsPanel } from "@/components/admin/membership-cancellation-settings-panel";
import { useCanOpenAdminPath } from "@/hooks/use-admin-area-edit-access";
import { adminHref } from "@/lib/admin-hubs";

/**
 * The Settings tab of Membership Cancellations (S1 #4796): the settings panel
 * as it was on its own page, `/admin/membership-cancellation`, and the Email
 * Messages link the Cancellation setup page carried, shown only to an admin
 * who can open it (`support`), as that page's card was. The panel keeps its
 * own `membership` edit gate.
 */
export function MembershipCancellationSettingsTab() {
  const emailMessagesHref = adminHref("email-messages");
  const canOpenEmailMessages = useCanOpenAdminPath(emailMessagesHref);
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-6">
          <MembershipCancellationSettingsPanel />
        </CardContent>
      </Card>
      {canOpenEmailMessages ? (
        <p className="text-sm text-muted-foreground">
          The emails these requests send are edited in{" "}
          <Link href={emailMessagesHref} className="underline">
            Email Messages
          </Link>
          .
        </p>
      ) : null}
    </div>
  );
}
