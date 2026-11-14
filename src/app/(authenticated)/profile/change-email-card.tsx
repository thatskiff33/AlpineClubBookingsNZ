import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ChangeEmailForm, type PendingEmailChange } from "./change-email-form";

/** The profile's Change Email section (#4956: it names a change still waiting). */
export function ChangeEmailCard({
  currentEmail,
  pendingChange,
}: {
  currentEmail: string;
  pendingChange: PendingEmailChange | null;
}) {
  return (
    <Card id="change-email" className="scroll-mt-20">
      <CardHeader>
        <CardTitle>Change Email</CardTitle>
        <CardDescription>
          Update your email address. You will need to verify the new address.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ChangeEmailForm
          currentEmail={currentEmail}
          pendingChange={pendingChange}
        />
      </CardContent>
    </Card>
  );
}
