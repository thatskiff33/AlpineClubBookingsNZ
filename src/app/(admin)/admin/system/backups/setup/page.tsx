import type { Metadata } from "next";
import { BackLink } from "@/components/admin/back-link";
import { BackupSetupWizard } from "./backup-setup-wizard";

export const metadata: Metadata = {
  title: "Database backup setup",
};

// Guided database-backup setup wizard (#2227). Registered under the `support`
// permission area (the `/admin/backups` prefix in admin-permissions.ts covers
// this nested route). Support view sees the steps; support edit turns on backups
// and runs the verification; the S3 credentials and destination remain Full
// Admin, enforced by the write routes. The flat /admin/backups page stays the
// post-setup editing surface.
export default function BackupSetupPage() {
  return (
    <div className="max-w-6xl p-6">
      <BackLink href="/admin/integrations" label="Integrations" />
      <h1 className="mt-2 mb-2 text-2xl font-bold">Database backup setup</h1>
      <p className="mb-6 text-muted-foreground">
        Set up durable, off-site (S3) database backups step by step, then run a
        real verification backup to confirm the whole path works. Day-to-day
        settings and run history live on the Database Backups page.
      </p>

      <BackupSetupWizard />
    </div>
  );
}
