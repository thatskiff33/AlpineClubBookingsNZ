import { RouteLoading } from "@/components/route-loading";

// The lodge kiosk's default loading state (#4467), shown inside the lodge layout.
export default function LodgeLoading() {
  return (
    <RouteLoading
      label="Loading the lodge screen…"
      className="mx-auto max-w-6xl px-4 py-8"
    />
  );
}
