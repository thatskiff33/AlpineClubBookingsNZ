import { RouteLoading } from "@/components/route-loading";

// The lodge kiosk's default loading state (#4467), shown inside the lodge layout.
// The kiosk and roster pages fetch their own data on the client, so on a fresh
// load this never shows (which is why the July 2026 hardening review, F36, left
// the lodge without one); it covers the gap on an in-app navigation between them
// while the next screen's code arrives.
export default function LodgeLoading() {
  return (
    <RouteLoading
      label="Loading the lodge screen…"
      className="mx-auto max-w-6xl px-4 py-8"
    />
  );
}
