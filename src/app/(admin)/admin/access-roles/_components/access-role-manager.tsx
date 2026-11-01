"use client";

import { useCallback, useEffect, useState } from "react";
import { Lock, Pencil, Plus, Trash2, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { AdminPermissionMatrixTable } from "@/components/admin-permission-matrix-table";
import {
  ADMIN_PERMISSION_AREAS,
  ADMIN_PERMISSION_LEVELS,
  type AdminPermissionLevel,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";
import {
  ACCESS_ROLE_DESCRIPTIONS,
  ACCESS_ROLE_LABELS,
} from "@/lib/access-roles";
import type { AccessRole } from "@prisma/client";

type ManagedAccessRole = {
  id: string;
  key: string;
  systemRole: AccessRole | null;
  label: string;
  description: string;
  sortOrder: number;
  permissions: AdminPermissionMatrix;
  memberCount: number;
};

type RoleFormState = {
  label: string;
  description: string;
  permissions: AdminPermissionMatrix;
};

const EMPTY_PERMISSIONS: AdminPermissionMatrix = {
  overview: "none",
  bookings: "none",
  membership: "none",
  finance: "none",
  lodge: "none",
  content: "none",
  support: "none",
};

const LEVEL_LABELS: Record<AdminPermissionLevel, string> = {
  none: "None",
  view: "View",
  edit: "Edit",
};

/**
 * Protected system roles shown for reference only: they are code-defined
 * and can never be edited or deleted.
 */
const PROTECTED_ROLES = (["ADMIN", "LODGE", "USER", "ORG"] as const).map(
  (role) => ({
    role,
    label: ACCESS_ROLE_LABELS[role],
    description: ACCESS_ROLE_DESCRIPTIONS[role],
  }),
);

export function AccessRoleManager({
  actorIsFullAdmin,
}: {
  actorIsFullAdmin: boolean;
}) {
  const [roles, setRoles] = useState<ManagedAccessRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<ManagedAccessRole | null>(
    null,
  );
  const [form, setForm] = useState<RoleFormState>({
    label: "",
    description: "",
    permissions: EMPTY_PERMISSIONS,
  });
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  const [deletingRole, setDeletingRole] = useState<ManagedAccessRole | null>(
    null,
  );
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);

  const loadRoles = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/access-roles");
      if (!response.ok) throw new Error("Failed to load access roles");
      const data = (await response.json()) as { roles?: ManagedAccessRole[] };
      setRoles(data.roles ?? []);
      setError("");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load access roles",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRoles();
  }, [loadRoles]);

  const openCreate = () => {
    setEditingRole(null);
    setForm({ label: "", description: "", permissions: EMPTY_PERMISSIONS });
    setFormError("");
    setDialogOpen(true);
  };

  const openEdit = (role: ManagedAccessRole) => {
    setEditingRole(role);
    setForm({
      label: role.label,
      description: role.description,
      permissions: role.permissions,
    });
    setFormError("");
    setDialogOpen(true);
  };

  const submitForm = async () => {
    setSaving(true);
    setFormError("");
    try {
      const response = await fetch(
        editingRole
          ? `/api/admin/access-roles/${editingRole.id}`
          : "/api/admin/access-roles",
        {
          method: editingRole ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            label: form.label,
            description: form.description,
            permissions: form.permissions,
          }),
        },
      );
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(data.error || "Failed to save access role");
      }
      setDialogOpen(false);
      setNotice(editingRole ? "Access role updated" : "Access role created");
      await loadRoles();
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Failed to save access role",
      );
    } finally {
      setSaving(false);
    }
  };

  const submitDelete = async () => {
    if (!deletingRole) return;
    setDeleting(true);
    setDeleteError("");
    try {
      const response = await fetch(
        `/api/admin/access-roles/${deletingRole.id}`,
        { method: "DELETE" },
      );
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(data.error || "Failed to delete access role");
      }
      setDeletingRole(null);
      setNotice("Access role deleted");
      await loadRoles();
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : "Failed to delete access role",
      );
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
      {error && (
        <div
          role="alert"
          className="rounded border border-danger-6 bg-danger-3 p-3 text-sm text-danger-11"
        >
          {error}
        </div>
      )}
      {notice && (
        <div
          role="status"
          className="rounded border border-success-6 bg-success-3 p-3 text-sm text-success-11"
        >
          {notice}
        </div>
      )}
      {!actorIsFullAdmin && (
        <div className="rounded border border-warning-6 bg-warning-3 p-3 text-sm text-warning-11">
          Only a Full Admin can create, edit, or delete access roles. You can
          review the configured roles below.
        </div>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Editable Roles</CardTitle>
          <Button onClick={openCreate} disabled={!actorIsFullAdmin} size="sm">
            <Plus className="mr-1 h-4 w-4" /> New Role
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <p className="text-sm text-muted-foreground">
              Loading access roles…
            </p>
          ) : roles.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No editable access roles are configured yet.
            </p>
          ) : (
            roles.map((role) => (
              <div
                key={role.id}
                className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-border p-3"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">{role.label}</span>
                    {role.systemRole && (
                      <Badge variant="secondary">Seeded default</Badge>
                    )}
                    <Badge variant="outline" className="gap-1">
                      <Users className="h-3 w-3" />
                      {role.memberCount}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {role.description}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {ADMIN_PERMISSION_AREAS.filter(
                      (area) => role.permissions[area.key] !== "none",
                    )
                      .map(
                        (area) =>
                          `${area.label}: ${LEVEL_LABELS[role.permissions[area.key]]}`,
                      )
                      .join(" · ") || "No admin area access"}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => openEdit(role)}
                    disabled={!actorIsFullAdmin}
                  >
                    <Pencil className="mr-1 h-3.5 w-3.5" /> Edit
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-danger-11 hover:text-danger-11"
                    onClick={() => {
                      setDeleteError("");
                      setDeletingRole(role);
                    }}
                    disabled={!actorIsFullAdmin}
                  >
                    <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lock className="h-4 w-4" /> Protected System Roles
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {PROTECTED_ROLES.map((role) => (
            <div
              key={role.role}
              className="rounded-md border border-border bg-muted p-3"
            >
              <p className="text-sm font-semibold">{role.label}</p>
              <p className="text-xs text-muted-foreground">
                {role.description}
              </p>
            </div>
          ))}
          <p className="text-xs text-muted-foreground sm:col-span-2">
            These roles are built in and cannot be edited or deleted. Full
            Admin always keeps full permissions.
          </p>
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editingRole ? `Edit ${editingRole.label}` : "New Access Role"}
            </DialogTitle>
            <DialogDescription>
              {editingRole
                ? "Changes apply to every member holding this role on their next request."
                : "Create a role with its own permission levels, then assign it from Admin > Members."}
            </DialogDescription>
          </DialogHeader>
          {formError && (
            <div
              role="alert"
              className="rounded border border-danger-6 bg-danger-3 p-2 text-sm text-danger-11"
            >
              {formError}
            </div>
          )}
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="access-role-label">Name</Label>
              <Input
                id="access-role-label"
                value={form.label}
                maxLength={120}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    label: event.target.value,
                  }))
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="access-role-description">Description</Label>
              <Textarea
                id="access-role-description"
                value={form.description}
                maxLength={1000}
                rows={2}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    description: event.target.value,
                  }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label>Permissions</Label>
              <div className="grid gap-2 sm:grid-cols-2">
                {ADMIN_PERMISSION_AREAS.map((area) => (
                  <div
                    key={area.key}
                    className="flex items-center justify-between gap-3 rounded-md border border-border p-2"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{area.label}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {area.description}
                      </p>
                    </div>
                    <Select
                      value={form.permissions[area.key]}
                      onValueChange={(value) =>
                        setForm((current) => ({
                          ...current,
                          permissions: {
                            ...current.permissions,
                            [area.key]: value as AdminPermissionLevel,
                          },
                        }))
                      }
                    >
                      <SelectTrigger className="w-[92px] shrink-0" aria-label={`${area.label} access level`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ADMIN_PERMISSION_LEVELS.map((level) => (
                          <SelectItem key={level} value={level}>
                            {LEVEL_LABELS[level]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            </div>
            <AdminPermissionMatrixTable matrix={form.permissions} />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              onClick={submitForm}
              disabled={saving || form.label.trim().length === 0}
            >
              {saving
                ? "Saving…"
                : editingRole
                  ? "Save Changes"
                  : "Create Role"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deletingRole !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingRole(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {deletingRole?.label}?</DialogTitle>
            <DialogDescription>
              {deletingRole && deletingRole.memberCount > 0
                ? `This role is assigned to ${deletingRole.memberCount} member${deletingRole.memberCount === 1 ? "" : "s"}. Remove it from all members before deleting.`
                : "This cannot be undone. Members can no longer be assigned this role."}
            </DialogDescription>
          </DialogHeader>
          {deleteError && (
            <div
              role="alert"
              className="rounded border border-danger-6 bg-danger-3 p-2 text-sm text-danger-11"
            >
              {deleteError}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeletingRole(null)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={submitDelete}
              disabled={
                deleting || (deletingRole?.memberCount ?? 0) > 0
              }
            >
              {deleting ? "Deleting…" : "Delete Role"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
