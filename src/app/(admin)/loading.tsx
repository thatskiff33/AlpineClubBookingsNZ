import { RouteLoading } from "@/components/route-loading";

// The admin area's default loading state (#4467): shown inside the admin layout,
// sidebar and all, for any admin page without a more specific loading.tsx of its
// own (bookings, dashboard and members keep theirs).
export default function AdminLoading() {
  return <RouteLoading label="Loading the page…" />;
}
