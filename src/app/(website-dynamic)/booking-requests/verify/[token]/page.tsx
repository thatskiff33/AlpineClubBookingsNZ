import type { Metadata } from "next";
import { BookingRequestVerifyClient } from "@/app/(website-dynamic)/booking-requests/verify/[token]/booking-request-verify-client";
import { getCachedClubIdentity } from "@/lib/public-layout-config";

// The email-confirmation link carries a one-time token and must never be indexed
// (#2421). The group layout also sets this; kept here so the route states its own
// reason.
// A fixed tab title (#4951): it lands in history, so never the token or a name.
export const metadata: Metadata = {
  title: "Confirm your booking request",
  robots: { index: false, follow: false },
};

/**
 * Permanently per-request (#2352): a dynamic segment carrying a ONE-TIME token in
 * the URL, so it sits in `(website-dynamic)` and keeps a per-request CSP nonce. It
 * is never stored. The group layout declares the render mode too; this line is the
 * route's own reason.
 *
 * The `(website)` route groups have no `ClubIdentityProvider`, so the client's
 * one identity value — the default lodge name in the thank-you copy — is resolved
 * here (DB-first) and passed as a prop rather than read from a hook.
 */
export const dynamic = "force-dynamic";

export default async function BookingRequestVerifyPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const [{ token }, clubIdentity] = await Promise.all([
    params,
    getCachedClubIdentity(),
  ]);
  return (
    <div className="mx-auto flex w-full max-w-3xl justify-center px-4 py-12 sm:py-16">
      <BookingRequestVerifyClient
        token={token}
        clubLodgeName={clubIdentity.lodgeName}
      />
    </div>
  );
}
