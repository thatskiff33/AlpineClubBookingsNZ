import Link from "next/link";
import { BackLink } from "@/components/admin/back-link";
import { adminHref } from "@/lib/admin-hubs";
import { DefaultCancellationPolicySection } from "@/components/admin/booking-policies/default-cancellation-policy-section";
import {
  detectStaleHoldPolicyCopy,
  holdCopyTitle,
} from "@/lib/hold-policy-copy";

export default async function CancellationPolicyPage() {
  const staleHoldCopy = await detectStaleHoldPolicyCopy();

  return (
    <div className="space-y-6">
      <div>
        <BackLink href="/admin/booking-policies" label="Booking Policies" />
        <h1 className="mt-2 text-2xl font-bold text-foreground">
          Default Cancellation Policy
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Refund rules applied to all bookings unless a date-specific period
          overrides them.
        </p>
      </div>

      {staleHoldCopy.length > 0 && (
        <div
          role="status"
          className="rounded-md border border-warning-6 bg-warning-3 p-4 text-sm text-warning-11"
        >
          <p className="font-medium">Public copy may be out of date</p>
          <p className="mt-1">
            Your{" "}
            {staleHoldCopy.map((slug, index) => (
              <span key={slug}>
                {index > 0 && (index === staleHoldCopy.length - 1 ? " and " : ", ")}
                <strong>{holdCopyTitle(slug)}</strong>
              </span>
            ))}{" "}
            {staleHoldCopy.length > 1 ? "pages still describe" : "page still describes"}{" "}
            the old non-member hold behaviour and don&rsquo;t mention the{" "}
            <strong>First Paid, First In</strong> option. If you change the
            Members First policy below, review this copy so it matches what
            guests are told.
          </p>
          <p className="mt-2">
            <Link
              href={adminHref("page-content")}
              className="font-medium underline underline-offset-4"
            >
              Edit public pages
            </Link>
          </p>
        </div>
      )}

      <DefaultCancellationPolicySection />
    </div>
  );
}
