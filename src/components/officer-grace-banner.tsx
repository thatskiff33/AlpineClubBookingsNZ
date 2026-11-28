import Link from "next/link";

import { clubFormatValues } from "@/lib/club-format-server";
import { clubTimeZone } from "@/lib/club-time/server";
import { formatOfficerGraceDeadline } from "@/lib/officer-two-factor-grace";
import { PROFILE_SECURITY_HREF } from "@/lib/second-factor-enrolment";

/**
 * The one reminder a required officer sees while they are still inside grace.
 */
export async function OfficerGraceBanner({ endsAt }: { endsAt: number | null }) {
  let deadline = "";
  if (typeof endsAt === "number") {
    const [zone, format] = await Promise.all([clubTimeZone(), clubFormatValues()]);
    const label = formatOfficerGraceDeadline(new Date(endsAt), zone, format);
    if (label) deadline = ` by ${label}`;
  }

  return (
    <p
      role="status"
      className="border-b bg-muted px-4 py-2 text-center text-sm text-foreground"
    >
      Set up an authenticator app or a passkey{deadline}.{" "}
      <Link href={PROFILE_SECURITY_HREF} className="underline underline-offset-4">
        Open the Security section of your profile
      </Link>
    </p>
  );
}
