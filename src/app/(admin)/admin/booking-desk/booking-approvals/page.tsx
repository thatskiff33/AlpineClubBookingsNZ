import { redirect } from "next/navigation";
import { buildBookingRequestsHref } from "@/lib/admin-booking-requests-path";

type PageSearchParams = Promise<
  Record<string, string | string[] | undefined>
>;

export default async function BookingApprovalsRedirectPage({
  searchParams,
}: {
  searchParams?: PageSearchParams;
}) {
  const params = searchParams ? await searchParams : {};
  redirect(buildBookingRequestsHref("approvals", params));
}
