import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import DeletionRequestsClient from "./deletion-requests-client";

// Thin server wrapper (#1938). The client section that lists admin-initiated
// hard-delete requests must disable approve/reject on the current admin's OWN
// request to keep the two-admin rule visible, so it needs the session member id
// client-side. The layout already gates admin access; this check is
// belt-and-braces and provides the id. The server review PATCH stays the
// authority (403 on self-review) regardless of what the UI renders.
export default async function DeletionRequestsPage() {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  return <DeletionRequestsClient sessionMemberId={session.user.id} />;
}
