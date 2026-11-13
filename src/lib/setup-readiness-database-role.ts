import { adminHref } from "@/lib/admin-hubs";
import { DEFAULT_DATABASE_ROLE_NAMES } from "@/lib/database-roles";

export interface DatabaseRoleSnapshot {
  name: string;
  /**
   * Includes membership that permits SET ROLE to a superuser, and a superuser
   * login (session_user) narrowed to a non-superuser current_user.
   */
  isSuperuser: boolean;
}

/** Read-only advice: upgrading an existing installation must never block setup. */
export function buildDatabaseRoleCheck(snapshot: DatabaseRoleSnapshot | undefined) {
  const base = {
    id: "database-role" as const,
    title: "Database role",
    description: "Check whether the application's database connection has superuser rights.",
    required: false as const,
    href: adminHref("health"),
    details: ["See DEPLOYMENT.md#least-privilege-database-roles for provisioning and switching roles."],
  };
  if (!snapshot) {
    return { ...base, status: "warning" as const, message: "Database role not checked: the database role could not be read. Check the database connection and retry." };
  }
  if (snapshot.isSuperuser) {
    return {
      ...base,
      status: "warning" as const,
      message: `The app is connected as a superuser ("${snapshot.name}", directly, through role membership or through its login role). Booking-ledger and audit rows can be rewritten with this connection. Provision the least-privilege roles and switch the app to ${DEFAULT_DATABASE_ROLE_NAMES.app}.`,
    };
  }
  return { ...base, status: "complete" as const, message: `The connected database role "${snapshot.name}" is not a superuser and belongs to no superuser role.` };
}
