import { redirect } from "next/navigation";

import { guardAdminLayout } from "@/lib/admin-layout-guard";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";

import { MaintenanceReportsAdmin } from "./maintenance-reports-admin";

/**
 * Lodge Maintenance — the admin page (#2780, owner decision 4).
 *
 * It lives in the admin panel under Lodge Operations and inherits the ordinary
 * admin chrome. The `guardAdminLayout()` sequence — session, a fresh member read,
 * active, forced-password, two-factor, and the `lodge` area permission for THIS
 * path — is re-run here rather than trusted from the parent layout, because a page
 * and its layout are separately reachable in Next's rendering model.
 *
 * The feature-route rule 404s this whole subtree when `maintenanceReports` is off,
 * so `moduleEnabled` is effectively always true by the time we render; it is read
 * and passed anyway so the Settings tab tells the truth in the proxy/page read race
 * that is the one way `false` reaches here (the same shape as the AI Diagnostics
 * page). `loadEffectiveModuleFlags` is the lenient reader whose failure is `false`,
 * which is the correct fail-closed answer for a surface that is 404'd when off.
 */

export const metadata = { title: "Lodge Maintenance" };

export default async function MaintenanceReportsPage() {
  const guard = await guardAdminLayout();
  if (guard.outcome === "redirect") redirect(guard.destination);

  const modules = await loadEffectiveModuleFlags();

  return (
    <div className="space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Lodge Maintenance</h1>
        <p className="text-sm text-muted-foreground">
          Faults members and lodge visitors have reported, the questions the form
          asks, the printable QR signs, and how photos are handled.
        </p>
      </header>

      <MaintenanceReportsAdmin moduleEnabled={modules.maintenanceReports} />
    </div>
  );
}
