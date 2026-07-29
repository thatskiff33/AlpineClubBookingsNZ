import type { Metadata } from "next";
import { BackLink } from "@/components/admin/back-link";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { DisplaySetupWizard } from "./display-setup-wizard";

export const metadata: Metadata = {
  title: "Lodge Display setup",
};

// Guided Lodge Display setup wizard (#2249). Registered under the `lodge`
// permission area (the `/admin/display` prefix in admin-permissions.ts covers
// this nested route), so any admin who can see the Lobby Display hub can follow
// it; every write it performs is enforced independently by its own route.
//
// This page is the ONE path under /admin/display that is exempt from the
// `lobbyDisplay` module gate (src/config/feature-routes.ts) — its first step is
// "turn the module on", which would be unreachable otherwise. It therefore
// renders nothing the module hides: only guidance plus controls whose routes
// stay gated (every /api/admin/display call still 404s until the module is on).
//
// The flag itself is resolved HERE rather than fetched, because /api/admin/
// modules is support-gated and a lodge-only admin must still be told what the
// flag is. `router.refresh()` in the wizard's refresh path re-runs this render.
export const dynamic = "force-dynamic";

export default async function DisplaySetupPage() {
  const features = await loadEffectiveModuleFlags();

  return (
    <div className="max-w-5xl p-6">
      {/* prefetch off: this page stays reachable while `lobbyDisplay` is OFF,
          and the hub it points back at does not — a default prefetch would fire
          a background request that 404s in the very state step 1 exists to fix
          (#2249). The link itself still works; it just is not warmed. */}
      <BackLink href="/admin/display" label="Lobby Display" prefetch={false} />
      <h1 className="mt-2 mb-2 text-2xl font-bold">Lodge Display setup</h1>
      <p className="mb-6 text-muted-foreground">
        Six steps from nothing to a TV in the lodge showing the right board:
        turn the module on, make sure the built-in boards exist, pick one, fill
        in the details it prints, then pair the screen. About ten minutes, and
        you can stop and resume.
      </p>

      <DisplaySetupWizard moduleEnabled={features.lobbyDisplay} />
    </div>
  );
}
