import { BackLink } from "@/components/admin/back-link";
import { BackupsClient } from "./backups-client";

// Managed database backup surface (#2095, C6). Registered under the `support`
// permission area (admin-permissions.ts). Support view sees status; support
// edit can change operational config and run a backup; the S3 destination and
// credentials are Full-Admin only (enforced by the write routes and reflected
// in the UI via the status payload's `canManageDestination`).
export default function BackupsPage() {
  return (
    <div className="max-w-4xl">
      <BackLink href="/admin/integrations" label="Integrations" />
      <h1 className="mt-2 mb-2 text-2xl font-bold text-foreground">
        Database Backups
      </h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Configure where nightly database backups are stored, check backup
        status, and run a backup on demand. Backups run <code>pg_dump</code>{" "}
        against the live database and upload to your S3 destination.
      </p>
      <BackupsClient />
    </div>
  );
}
