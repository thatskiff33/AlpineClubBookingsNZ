"use client";

import { useSession } from "next-auth/react";
import { isFullAdmin } from "@/lib/access-roles";
import { AccessRoleManager } from "./_components/access-role-manager";

export default function AccessRolesPage() {
  const { data: session } = useSession();
  const actorIsFullAdmin = isFullAdmin({
    accessRoles: session?.user?.accessRoles ?? [],
    canLogin: session?.user?.canLogin ?? false,
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Access Roles</h1>
        <p className="text-sm text-muted-foreground">
          Configure the admin access roles that can be assigned from Admin &gt;
          Members. Editing a role applies to every member holding it on their
          next request.
        </p>
      </div>
      <AccessRoleManager actorIsFullAdmin={actorIsFullAdmin} />
    </div>
  );
}
