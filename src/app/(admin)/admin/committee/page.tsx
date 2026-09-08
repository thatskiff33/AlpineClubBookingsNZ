"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, EyeOff, Pencil, Plus, Save, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { AdminDataTable } from "@/components/admin/admin-data-table";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldHint, useFieldHint } from "@/components/ui/field-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useScrollToFeedback } from "@/hooks/use-scroll-to-feedback";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { CommitteePhotoDisplayControl } from "@/components/admin/committee-photo-display-control";
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";

interface CommitteeRole {
  id: string;
  key: string;
  name: string;
  description: string | null;
  contactEmail: string | null;
  isActive: boolean;
  sortOrder: number;
  assignmentCount: number;
}

interface CommitteeAssignment {
  id: string;
  memberId: string;
  committeeRoleId: string;
  blurb: string | null;
  sortOrder: number;
  published: boolean;
  showPhone: boolean;
  contactable: boolean;
  isActive: boolean;
  committeeRole: CommitteeRole;
  member: {
    id: string;
    displayName: string;
    email: string;
    phone: string | null;
    role: string;
    active: boolean;
  };
}

const emptyRoleForm = {
  name: "",
  description: "",
  contactEmail: "",
  sortOrder: 0,
  isActive: true,
};

const emptyAssignmentForm = {
  blurb: "",
  sortOrder: 0,
  published: false,
  showPhone: false,
  contactable: false,
  isActive: true,
};

async function readJson(response: Response) {
  return response.json().catch(() => null);
}

function responseErrorMessage(body: unknown, fallback: string) {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "string"
  ) {
    return body.error;
  }
  return fallback;
}

function assignmentEffectiveEmail(assignment: CommitteeAssignment) {
  return assignment.committeeRole.contactEmail || assignment.member.email;
}

function VisibilityBadge({ visible }: { visible: boolean }) {
  return visible ? (
    <Badge className="border-success/20 bg-success-muted text-success">
      <Eye className="mr-1 h-3 w-3" />
      Published
    </Badge>
  ) : (
    <Badge variant="secondary">
      <EyeOff className="mr-1 h-3 w-3" />
      Hidden
    </Badge>
  );
}

export default function CommitteePage() {
  const [roles, setRoles] = useState<CommitteeRole[]>([]);
  const [assignments, setAssignments] = useState<CommitteeAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const pageRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const { scrollToError, scrollToTop } = useScrollToFeedback();
  // Committee roles/assignments resolve to the membership area (their write
  // routes enforce membership:edit), so gate the editors on that area (#1940).
  const canEdit = useAdminAreaEditAccess("membership");
  // #2264 — the role email example moves out of the placeholder (grey text
  // inside the box reads as an address already on file) and under the field.
  const roleEmailHint = useFieldHint();

  const [showRoleForm, setShowRoleForm] = useState(false);
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
  const [roleForm, setRoleForm] = useState(emptyRoleForm);

  const [editingAssignmentId, setEditingAssignmentId] = useState<string | null>(
    null,
  );
  const [assignmentForm, setAssignmentForm] = useState(emptyAssignmentForm);

  const fetchCommitteeData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [rolesRes, assignmentsRes] = await Promise.all([
        fetch("/api/admin/committee/roles", { credentials: "same-origin" }),
        fetch("/api/admin/committee/assignments?includeInactive=1", {
          credentials: "same-origin",
        }),
      ]);

      const [rolesBody, assignmentsBody] = await Promise.all([
        readJson(rolesRes),
        readJson(assignmentsRes),
      ]);

      if (!rolesRes.ok) {
        throw new Error(
          responseErrorMessage(rolesBody, "Failed to load committee roles"),
        );
      }
      if (!assignmentsRes.ok) {
        throw new Error(
          responseErrorMessage(
            assignmentsBody,
            "Failed to load committee assignments",
          ),
        );
      }

      setRoles(rolesBody?.roles ?? []);
      setAssignments(assignmentsBody?.assignments ?? []);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load committee data",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchCommitteeData();
  }, [fetchCommitteeData]);

  useEffect(() => {
    if (error) scrollToError(errorRef);
  }, [error, scrollToError]);

  function openAddRoleForm() {
    setEditingRoleId(null);
    const maxOrder = roles.reduce(
      (max, role) => Math.max(max, role.sortOrder),
      -1,
    );
    setRoleForm({ ...emptyRoleForm, sortOrder: maxOrder + 1 });
    setShowRoleForm(true);
    setError("");
  }

  function openEditRoleForm(role: CommitteeRole) {
    setEditingRoleId(role.id);
    setRoleForm({
      name: role.name,
      description: role.description ?? "",
      contactEmail: role.contactEmail ?? "",
      sortOrder: role.sortOrder,
      isActive: role.isActive,
    });
    setShowRoleForm(true);
    setError("");
  }

  function closeRoleForm() {
    setShowRoleForm(false);
    setEditingRoleId(null);
    setRoleForm(emptyRoleForm);
  }

  function openAssignmentForm(assignment: CommitteeAssignment) {
    setEditingAssignmentId(assignment.id);
    setAssignmentForm({
      blurb: assignment.blurb ?? "",
      sortOrder: assignment.sortOrder,
      published: assignment.published,
      showPhone: assignment.showPhone,
      contactable: assignment.contactable,
      isActive: assignment.isActive,
    });
    setError("");
  }

  function closeAssignmentForm() {
    setEditingAssignmentId(null);
    setAssignmentForm(emptyAssignmentForm);
  }

  async function handleRoleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaving(true);

    const payload = {
      name: roleForm.name,
      description: roleForm.description || null,
      contactEmail: roleForm.contactEmail || null,
      sortOrder: roleForm.sortOrder,
      isActive: roleForm.isActive,
    };

    try {
      const url = editingRoleId
        ? `/api/admin/committee/roles/${editingRoleId}`
        : "/api/admin/committee/roles";
      const response = await fetch(url, {
        method: editingRoleId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      });
      const body = await readJson(response);
      if (!response.ok) {
        // Stale-tab / narrowed-permission save surfaces the persistent
        // forbidden-save reason in the existing error banner (#1940).
        if (response.status === 403) {
          setError(ADMIN_FORBIDDEN_SAVE_REASON);
          return;
        }
        throw new Error(responseErrorMessage(body, "Failed to save role"));
      }
      closeRoleForm();
      await fetchCommitteeData();
      scrollToTop(pageRef);
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "Failed to save role",
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleAssignmentSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingAssignmentId) return;
    setError("");
    setSaving(true);

    try {
      const response = await fetch(
        `/api/admin/committee/assignments/${editingAssignmentId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            blurb: assignmentForm.blurb || null,
            sortOrder: assignmentForm.sortOrder,
            published: assignmentForm.published,
            showPhone: assignmentForm.showPhone,
            contactable: assignmentForm.contactable,
            isActive: assignmentForm.isActive,
          }),
        },
      );
      const body = await readJson(response);
      if (!response.ok) {
        if (response.status === 403) {
          setError(ADMIN_FORBIDDEN_SAVE_REASON);
          return;
        }
        throw new Error(
          responseErrorMessage(body, "Failed to save assignment"),
        );
      }
      closeAssignmentForm();
      await fetchCommitteeData();
      scrollToTop(pageRef);
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to save assignment",
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDeactivateAssignment(assignment: CommitteeAssignment) {
    if (!confirm(`Remove ${assignment.member.displayName} from ${assignment.committeeRole.name}?`)) {
      return;
    }
    const response = await fetch(
      `/api/admin/committee/assignments/${assignment.id}`,
      {
        method: "DELETE",
        credentials: "same-origin",
      },
    );
    if (response.ok) {
      await fetchCommitteeData();
    } else if (response.status === 403) {
      setError(ADMIN_FORBIDDEN_SAVE_REASON);
    }
  }

  const activeAssignmentCount = assignments.filter(
    (assignment) => assignment.isActive,
  ).length;
  const publishedAssignmentCount = assignments.filter(
    (assignment) => assignment.isActive && assignment.published,
  ).length;

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It sits OUTSIDE the `space-y-*` stack so
    the empty wrapper an edit-capable admin gets costs no layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view committee roles and assignments but cannot
      change them. Membership edit access is required.
    </AdminViewOnlySectionBanner>
  );

  return (
    <div>
      {viewOnlyBanner}
      <div ref={pageRef} className="space-y-6">
      <AdminPageHeader
        title="Committee"
        description="Manage master roles and member-linked assignment metadata."
        actions={
          <>
            <Badge variant="secondary">{roles.length} master roles</Badge>
            <Badge variant="secondary">{activeAssignmentCount} assignments</Badge>
            <Badge variant="secondary">
              {publishedAssignmentCount} marked published
            </Badge>
          </>
        }
      />

      {error ? (
        <div
          ref={errorRef}
          role="alert"
          tabIndex={-1}
          className="scroll-mt-20 rounded-md border border-danger/20 bg-danger-muted p-3 text-sm text-danger focus:outline-none"
        >
          {error}
        </div>
      ) : null}

      <CommitteePhotoDisplayControl />

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-lg">Committee Settings</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Master roles are reusable positions for member-linked committee
              assignments. Role email aliases route contact-form messages;
              linked member emails are used only when a role email is blank.
            </p>
          </div>
          <ViewOnlyActionButton canEdit={canEdit} describeReason={false} onClick={openAddRoleForm}>
            <Plus className="mr-2 h-4 w-4" />
            Add Role
          </ViewOnlyActionButton>
        </CardHeader>
        <CardContent className="space-y-4">
          {showRoleForm ? (
            <form
              onSubmit={handleRoleSubmit}
              className="rounded-md border border-border bg-card p-4 text-card-foreground"
            >
              <div className="mb-4 flex items-center justify-between">
                <h2 className="font-medium text-foreground">
                  {editingRoleId ? "Edit Role" : "Add Role"}
                </h2>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={closeRoleForm}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="roleName">Role Name *</Label>
                  <Input
                    id="roleName"
                    value={roleForm.name}
                    onChange={(event) =>
                      setRoleForm({ ...roleForm, name: event.target.value })
                    }
                    required
                    disabled={!canEdit}
                  />
                </div>
                <div>
                  <Label htmlFor="roleSortOrder">Sort Order</Label>
                  <Input
                    id="roleSortOrder"
                    type="number"
                    min={0}
                    value={roleForm.sortOrder}
                    onChange={(event) =>
                      setRoleForm({
                        ...roleForm,
                        sortOrder: parseInt(event.target.value, 10) || 0,
                      })
                    }
                    disabled={!canEdit}
                  />
                </div>
              </div>
              <div className="mt-4">
                <Label htmlFor="roleContactEmail">Role Email</Label>
                <Input
                  id="roleContactEmail"
                  type="email"
                  value={roleForm.contactEmail}
                  onChange={(event) =>
                    setRoleForm({
                      ...roleForm,
                      contactEmail: event.target.value,
                    })
                  }
                  disabled={!canEdit}
                  {...roleEmailHint.fieldProps}
                />
                <FieldHint {...roleEmailHint.hintProps} className="mt-1">
                  Example: president@example.org
                </FieldHint>
              </div>
              <div className="mt-4">
                <Label htmlFor="roleDescription">Description</Label>
                <Textarea
                  id="roleDescription"
                  rows={3}
                  value={roleForm.description}
                  onChange={(event) =>
                    setRoleForm({
                      ...roleForm,
                      description: event.target.value,
                    })
                  }
                  maxLength={1000}
                  disabled={!canEdit}
                />
              </div>
              <label className="mt-4 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={roleForm.isActive}
                  onChange={(event) =>
                    setRoleForm({
                      ...roleForm,
                      isActive: event.target.checked,
                    })
                  }
                  disabled={!canEdit}
                  className="h-4 w-4 rounded border-border"
                />
                Active
              </label>
              <div className="mt-4 flex gap-2">
                <ViewOnlyActionButton canEdit={canEdit} describeReason={false} type="submit" disabled={saving}>
                  <Save className="mr-2 h-4 w-4" />
                  Save Role
                </ViewOnlyActionButton>
                <Button type="button" variant="outline" onClick={closeRoleForm}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : null}

          <AdminDataTable>
            <TableHeader>
              <TableRow>
                <TableHead>Role</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Role Email</TableHead>
                <TableHead>Assignments</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {roles.map((role) => (
                <TableRow
                  key={role.id}
                  className={role.isActive ? "" : "opacity-60"}
                >
                  <TableCell>
                    <div className="font-medium">{role.name}</div>
                    {role.description ? (
                      <div className="mt-1 max-w-xl text-xs text-muted-foreground">
                        {role.description}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{role.key}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {role.contactEmail ?? "-"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {role.assignmentCount}
                  </TableCell>
                  <TableCell>
                    {role.isActive ? (
                      <Badge className="border-success/20 bg-success-muted text-success">
                        Active
                      </Badge>
                    ) : (
                      <Badge variant="secondary">Archived</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <ViewOnlyActionButton
                      canEdit={canEdit}
                      describeReason={false}
                      variant="ghost"
                      size="sm"
                      onClick={() => openEditRoleForm(role)}
                    >
                      <Pencil className="h-4 w-4" />
                    </ViewOnlyActionButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </AdminDataTable>
          {roles.length === 0 && !loading ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              No committee roles yet.
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Member-Linked Assignments</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Assign members from their member detail page. Published assignments
            now power the public committee and contact-form recipient lists;
            contact-form messages use the role email alias or the linked
            member email when the role email is blank.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <AdminDataTable>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Presentation</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {assignments.map((assignment) => {
                const effectiveEmail = assignmentEffectiveEmail(assignment);
                const usesPersonalEmail =
                  !assignment.committeeRole.contactEmail;

                return (
                  <TableRow
                    key={assignment.id}
                    className={assignment.isActive ? "" : "opacity-60"}
                  >
                    <TableCell>
                      <div className="font-medium">
                        {assignment.member.displayName}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {effectiveEmail}
                        {usesPersonalEmail ? (
                          <span className="ml-1">(personal)</span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="font-medium text-primary">
                        {assignment.committeeRole.name}
                      </div>
                      {assignment.blurb ? (
                        <div className="mt-1 max-w-md text-xs text-muted-foreground">
                          {assignment.blurb}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        <VisibilityBadge visible={assignment.published} />
                        {assignment.showPhone ? (
                          <Badge variant="secondary">Phone allowed</Badge>
                        ) : null}
                        {assignment.contactable ? (
                          <Badge variant="secondary">Contactable</Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      {assignment.isActive ? (
                        <Badge className="border-success/20 bg-success-muted text-success">
                          Active
                        </Badge>
                      ) : (
                        <Badge variant="secondary">Inactive</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <ViewOnlyActionButton
                          canEdit={canEdit}
                          describeReason={false}
                          variant="ghost"
                          size="sm"
                          onClick={() => openAssignmentForm(assignment)}
                        >
                          <Pencil className="h-4 w-4" />
                        </ViewOnlyActionButton>
                        <ViewOnlyActionButton
                          canEdit={canEdit}
                          describeReason={false}
                          variant="ghost"
                          size="sm"
                          className="text-danger hover:bg-danger-muted hover:text-danger"
                          onClick={() => handleDeactivateAssignment(assignment)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </ViewOnlyActionButton>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </AdminDataTable>
          {assignments.length === 0 && !loading ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              No member-linked committee assignments yet.
            </div>
          ) : null}

          {editingAssignmentId ? (
            <form
              onSubmit={handleAssignmentSubmit}
              className="rounded-md border border-border bg-card p-4 text-card-foreground"
            >
              <div className="mb-4 flex items-center justify-between">
                <h2 className="font-medium text-foreground">
                  Edit Assignment
                </h2>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={closeAssignmentForm}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_160px]">
                <div>
                  <Label htmlFor="assignmentBlurb">Blurb</Label>
                  <Textarea
                    id="assignmentBlurb"
                    rows={3}
                    maxLength={1000}
                    value={assignmentForm.blurb}
                    onChange={(event) =>
                      setAssignmentForm({
                        ...assignmentForm,
                        blurb: event.target.value,
                      })
                    }
                    disabled={!canEdit}
                  />
                </div>
                <div>
                  <Label htmlFor="assignmentSortOrder">Sort Order</Label>
                  <Input
                    id="assignmentSortOrder"
                    type="number"
                    min={0}
                    value={assignmentForm.sortOrder}
                    onChange={(event) =>
                      setAssignmentForm({
                        ...assignmentForm,
                        sortOrder: parseInt(event.target.value, 10) || 0,
                      })
                    }
                    disabled={!canEdit}
                  />
                </div>
              </div>
              <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-4">
                {/* `as const` makes each row a 2-tuple of literals, so `key`
                    is one of the four boolean field names rather than
                    `string | undefined` — which is what a computed property
                    name and the form lookup both need. Two casts go with it
                    (#2801). */}
                {(
                  [
                    ["published", "Published"],
                    ["showPhone", "Show phone"],
                    ["contactable", "Contactable"],
                    ["isActive", "Active"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={assignmentForm[key]}
                      onChange={(event) =>
                        setAssignmentForm({
                          ...assignmentForm,
                          [key]: event.target.checked,
                        })
                      }
                      disabled={!canEdit}
                      className="h-4 w-4 rounded border-border"
                    />
                    {label}
                  </label>
                ))}
              </div>
              <div className="mt-4 flex gap-2">
                <ViewOnlyActionButton canEdit={canEdit} describeReason={false} type="submit" disabled={saving}>
                  <Save className="mr-2 h-4 w-4" />
                  Save Assignment
                </ViewOnlyActionButton>
                <Button
                  type="button"
                  variant="outline"
                  onClick={closeAssignmentForm}
                >
                  Cancel
                </Button>
              </div>
            </form>
          ) : null}
        </CardContent>
      </Card>
      </div>
    </div>
  );
}
