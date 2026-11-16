import type { Metadata } from "next";
import { BookingRequestRespondClient } from "@/app/(website-dynamic)/booking-requests/respond/[token]/booking-request-respond-client";

// The quote-response link carries a one-time token and must never be indexed
// (#2421). The group layout also sets this; kept here so the route states its own
// reason.
// A fixed tab title (#4951): it lands in history, so never the token or a name.
export const metadata: Metadata = {
  title: "Your booking quote",
  robots: { index: false, follow: false },
};

/**
 * Permanently per-request (#2352): a dynamic segment carrying a ONE-TIME token in
 * the URL, so it sits in `(website-dynamic)` and keeps a per-request CSP nonce. It
 * is never stored. The group layout declares the render mode too; this line is the
 * route's own reason.
 */
export const dynamic = "force-dynamic";

export default async function BookingRequestRespondPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return (
    <div className="mx-auto flex w-full max-w-3xl justify-center px-4 py-12 sm:py-16">
      <BookingRequestRespondClient token={token} />
    </div>
  );
}
