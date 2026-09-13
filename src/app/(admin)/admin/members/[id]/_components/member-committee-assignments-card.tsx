"use client";

import { useEffect, useMemo, useState } from "react";
import { Eye, EyeOff, Pencil, Plus, Save, Trash2, UsersRound, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AdminViewOnlyNotice,
  ViewOnlyActionButton,
  type AncestorViewOnlyBannerProps,
} from "@/components/admin/view-only-action";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import type {
  CommitteeAssignmentSummary,
  CommitteeRoleSummary,
  MemberDetail,
} from "../_types";

interface RolesResponse {
  roles: CommitteeRoleSummary[];
}

interface MemberCommitteeAssignmentsCardProps extends AncestorViewOnlyBannerProps {
  member: MemberDetail;
  onSaved: () => Promise<void>;
  className?: string;
}

const emptyForm = {
  committeeRoleId: "",
  blurb: "",
  sortOrder: 0,
  published: false,
  showPhone: false,
  contactable: false,
  contactEmailMode: "ROLE" as "ROLE" | "MEMBER" | "CUSTOM",
  contactEmailOverride: "",
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

function VisibilityBadge({ visible }: { visible: boolean }) {
  return visible ? (
    <Badge className="border-success-6 bg-success-3 text-success-11">
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

export function MemberCommitteeAssignmentsCard({
  member,
  onSaved,
  className,
  ancestorRendersViewOnlyBanner = false,
}: MemberCommitteeAssignmentsCardProps) {
  // Add/edit/remove write /api/admin/committee/assignments (membership area); a
  // view-only membership admin sees the assignments but cannot change them
  // (#1997).
  const canEdit = useAdminAreaEditAccess("membership");
  const assignments = member.committeeAssignments ?? [];
  const [roles, setRoles] = useState<CommitteeRoleSummary[]>([]);
  const [rolesLoading, setRolesLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingAssignmentId, setEditingAssignmentId] = useState<string | null>(
    null,
  );
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const activeRoles = useMemo(
    () => roles.filter((role) => role.isActive),
    [roles],
  );

  const selectedRoleEmail =
    roles.find((role) => role.id === form.committeeRoleId)?.contactEmail ?? null;

  // Mirror the /api/contact per-mode resolution (incl. the ROLE→member fallback)
  // so the operator sees the EXACT address a public contact message will reach,
  // and — critically — which source it comes from (it is not the member's own
  // inbox unless MEMBER is chosen).
  const resolvedContact = (() => {
    const memberEmail = member.email?.trim() || null;
    const roleEmail = selectedRoleEmail?.trim() || null;
    const customEmail = form.contactEmailOverride.trim() || null;
    if (form.contactEmailMode === "CUSTOM") {
      return { email: customEmail, source: "the custom address below" };
    }
    if (form.contactEmailMode === "MEMBER") {
      return memberEmail
        ? { email: memberEmail, source: "this member's own email" }
        : { email: roleEmail, source: "the committee role email (this member has no email on file)" };
    }
    return roleEmail
      ? { email: roleEmail, source: "the committee role email" }
      : { email: memberEmail, source: "this member's own email (the role has no email set)" };
  })();

  async function loadRoles() {
    setRolesLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/committee/roles", {
        credentials: "same-origin",
      });
      const body = (await readJson(response)) as
        | RolesResponse
        | { error?: string }
        | null;
      if (!response.ok || !body || !("roles" in body)) {
        throw new Error(
          responseErrorMessage(body, "Failed to load committee roles"),
        );
      }
      setRoles(body.roles);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load committee roles",
      );
    } finally {
      setRolesLoading(false);
    }
  }

  useEffect(() => {
    void loadRoles();
  }, []);

  useEffect(() => {
    setShowForm(false);
    setEditingAssignmentId(null);
    setForm(emptyForm);
    setError("");
    setMessage("");
  }, [member.id]);

  function openAddForm() {
    const maxOrder = assignments.reduce(
      (max, assignment) => Math.max(max, assignment.sortOrder),
      -1,
    );
    setEditingAssignmentId(null);
    setForm({
      ...emptyForm,
      committeeRoleId: activeRoles[0]?.id ?? "",
      sortOrder: maxOrder + 1,
    });
    setShowForm(true);
    setError("");
    setMessage("");
  }

  function openEditForm(assignment: CommitteeAssignmentSummary) {
    setEditingAssignmentId(assignment.id);
    setForm({
      committeeRoleId: assignment.committeeRoleId,
      blurb: assignment.blurb ?? "",
      sortOrder: assignment.sortOrder,
      published: assignment.published,
      showPhone: assignment.showPhone,
      contactable: assignment.contactable,
      contactEmailMode: assignment.contactEmailMode,
      contactEmailOverride: assignment.contactEmailOverride ?? "",
      isActive: assignment.isActive,
    });
    setShowForm(true);
    setError("");
    setMessage("");
  }

  function closeForm() {
    setShowForm(false);
    setEditingAssignmentId(null);
    setForm(emptyForm);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!form.committeeRoleId) {
      setError("Select a committee role");
      return;
    }

    const trimmedOverride = form.contactEmailOverride.trim();
    if (
      form.contactable &&
      form.contactEmailMode === "CUSTOM" &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedOverride)
    ) {
      setError("Enter a valid custom committee email");
      return;
    }

    setSaving(true);
    setError("");
    setMessage("");

    const contactEmailMode = form.contactable ? form.contactEmailMode : "ROLE";
    const contactEmailOverride =
      form.contactable && form.contactEmailMode === "CUSTOM"
        ? trimmedOverride || null
        : null;

    const payload = {
      memberId: member.id,
      committeeRoleId: form.committeeRoleId,
      blurb: form.blurb || null,
      sortOrder: form.sortOrder,
      published: form.published,
      showPhone: form.showPhone,
      contactable: form.contactable,
      contactEmailMode,
      contactEmailOverride,
      isActive: form.isActive,
    };

    try {
      const response = await fetch(
        editingAssignmentId
          ? `/api/admin/committee/assignments/${editingAssignmentId}`
          : "/api/admin/committee/assignments",
        {
          method: editingAssignmentId ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(
            editingAssignmentId
              ? {
                  blurb: payload.blurb,
                  sortOrder: payload.sortOrder,
                  published: payload.published,
                  showPhone: payload.showPhone,
                  contactable: payload.contactable,
                  contactEmailMode: payload.contactEmailMode,
                  contactEmailOverride: payload.contactEmailOverride,
                  isActive: payload.isActive,
                }
              : payload,
          ),
        },
      );
      const body = await readJson(response);
      if (!response.ok) {
        throw new Error(
          responseErrorMessage(body, "Failed to save committee assignment"),
        );
      }
      setMessage("Committee assignment saved");
      closeForm();
      await onSaved();
      await loadRoles();
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to save committee assignment",
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDeactivate(assignment: CommitteeAssignmentSummary) {
    if (!confirm(`Remove ${member.firstName} ${member.lastName} from ${assignment.committeeRole.name}?`)) {
      return;
    }

    setSaving(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(
        `/api/admin/committee/assignments/${assignment.id}`,
        {
          method: "DELETE",
          credentials: "same-origin",
        },
      );
      const body = await readJson(response);
      if (!response.ok) {
        throw new Error(
          responseErrorMessage(body, "Failed to remove committee assignment"),
        );
      }
      setMessage("Committee assignment removed");
      await onSaved();
      await loadRoles();
    } catch (removeError) {
      setError(
        removeError instanceof Error
          ? removeError.message
          : "Failed to remove committee assignment",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className={className}>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <UsersRound className="h-5 w-5" />
            Committee Assignments
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Committee status is separate from access role and seasonal
            membership type.
          </p>
        </div>
        <ViewOnlyActionButton canEdit={canEdit} describeReason={!ancestorRendersViewOnlyBanner} onClick={openAddForm} disabled={rolesLoading || activeRoles.length === 0}>
          <Plus className="mr-2 h-4 w-4" />
          Add Assignment
        </ViewOnlyActionButton>
      </CardHeader>
      <CardContent className="space-y-4">
        {/*
          #2168: dropped only when an ancestor vouches that it states the same
          membership scope above this card — on `/admin/members/[id]` the page
          banner does, and repeating it here would be the same sentence twice.
          Rendered standalone, or under any parent that does not vouch, the
          Notice stays and this card still explains itself.
        */}
        {!ancestorRendersViewOnlyBanner ? (
          <AdminViewOnlyNotice canEdit={canEdit}>
            Your admin role can view committee assignments but cannot add, edit,
            or remove them.
          </AdminViewOnlyNotice>
        ) : null}
        {error ? (
          <div className="rounded-md border border-danger-6 bg-danger-3 p-3 text-sm text-danger-11">
            {error}
          </div>
        ) : null}
        {message ? (
          <div className="rounded-md border border-success-6 bg-success-3 p-3 text-sm text-success-11">
            {message}
          </div>
        ) : null}

        {showForm ? (
          <form
            onSubmit={handleSubmit}
            className="rounded-md border border-border p-4"
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-medium text-foreground">
                {editingAssignmentId ? "Edit Assignment" : "Add Assignment"}
              </h3>
              <Button type="button" variant="ghost" size="icon" onClick={closeForm}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_160px]">
              <div>
                <Label htmlFor="committeeRole">Role</Label>
                <Select
                  value={form.committeeRoleId}
                  onValueChange={(value) =>
                    setForm({ ...form, committeeRoleId: value })
                  }
                  disabled={Boolean(editingAssignmentId)}
                >
                  <SelectTrigger id="committeeRole">
                    <SelectValue placeholder="Select role" />
                  </SelectTrigger>
                  <SelectContent>
                    {(editingAssignmentId ? roles : activeRoles).map((role) => (
                      <SelectItem key={role.id} value={role.id}>
                        {role.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="committeeSortOrder">Sort Order</Label>
                <Input
                  id="committeeSortOrder"
                  type="number"
                  min={0}
                  value={form.sortOrder}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      sortOrder: parseInt(event.target.value, 10) || 0,
                    })
                  }
                />
              </div>
            </div>
            <div className="mt-4">
              <Label htmlFor="committeeBlurb">Blurb</Label>
              <Textarea
                id="committeeBlurb"
                rows={3}
                maxLength={1000}
                value={form.blurb}
                onChange={(event) =>
                  setForm({ ...form, blurb: event.target.value })
                }
              />
            </div>
            <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-4">
              {/* `as const` makes each row a 2-tuple of literals, so `key` is
                  one of the four boolean field names rather than
                  `string | undefined` — which is what a computed property name
                  and the form lookup both need. Two casts go with it
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
                    checked={form[key]}
                    onChange={(event) =>
                      setForm({ ...form, [key]: event.target.checked })
                    }
                    className="h-4 w-4 rounded border-border"
                  />
                  {label}
                </label>
              ))}
            </div>
            {form.contactable ? (
              <div className="mt-4 space-y-2 rounded-md border border-border bg-muted p-3">
                <Label htmlFor="committeeContactEmailMode">Contact email</Label>
                <p className="text-xs text-muted-foreground">
                  Choose where the public contact form delivers messages for this
                  committee role. The default is the committee role email — not this
                  member&apos;s own inbox.
                </p>
                <Select
                  value={form.contactEmailMode}
                  onValueChange={(value) =>
                    setForm({
                      ...form,
                      contactEmailMode: value as "ROLE" | "MEMBER" | "CUSTOM",
                    })
                  }
                >
                  <SelectTrigger id="committeeContactEmailMode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ROLE" disabled={!selectedRoleEmail}>
                      Committee role email ({selectedRoleEmail ?? "none set"})
                    </SelectItem>
                    <SelectItem value="MEMBER">
                      Member&apos;s own email ({member.email})
                    </SelectItem>
                    <SelectItem value="CUSTOM">Custom email</SelectItem>
                  </SelectContent>
                </Select>
                {!selectedRoleEmail ? (
                  <p className="text-xs text-muted-foreground">
                    This role has no email — set one under Admin → Committee, or
                    choose another option.
                  </p>
                ) : null}
                {form.contactEmailMode === "CUSTOM" ? (
                  <div>
                    <Label htmlFor="committeeContactEmailOverride">
                      Custom committee email
                    </Label>
                    <Input
                      id="committeeContactEmailOverride"
                      type="email"
                      value={form.contactEmailOverride}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          contactEmailOverride: event.target.value,
                        })
                      }
                    />
                  </div>
                ) : null}
                <p
                  className="rounded border border-info-6 bg-info-3 px-2.5 py-2 text-sm text-info-11"
                  role="status"
                  aria-live="polite"
                >
                  Public contact messages will be sent to{" "}
                  <span className="font-semibold">
                    {resolvedContact.email ?? "— no address set —"}
                  </span>{" "}
                  <span className="text-info-11">({resolvedContact.source})</span>
                  {resolvedContact.email ? "." : " — set an address so messages are not lost."}
                </p>
              </div>
            ) : null}
            <div className="mt-4 flex gap-2">
              <ViewOnlyActionButton canEdit={canEdit} describeReason={!ancestorRendersViewOnlyBanner} type="submit" disabled={saving}>
                <Save className="mr-2 h-4 w-4" />
                Save Assignment
              </ViewOnlyActionButton>
              <Button type="button" variant="outline" onClick={closeForm}>
                Cancel
              </Button>
            </div>
          </form>
        ) : null}

        {assignments.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">
            No committee assignments are linked to this member.
          </div>
        ) : (
          <div className="space-y-3">
            {assignments.map((assignment) => (
              <div
                key={assignment.id}
                className={`rounded-md border border-border p-4 ${
                  assignment.isActive ? "" : "opacity-60"
                }`}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-medium text-foreground">
                        {assignment.committeeRole.name}
                      </h3>
                      <VisibilityBadge visible={assignment.published} />
                      {assignment.isActive ? (
                        <Badge className="border-success-6 bg-success-3 text-success-11">
                          Active
                        </Badge>
                      ) : (
                        <Badge variant="secondary">Inactive</Badge>
                      )}
                    </div>
                    {assignment.blurb ? (
                      <p className="mt-2 text-sm text-muted-foreground">
                        {assignment.blurb}
                      </p>
                    ) : null}
                    <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                      <span>Sort {assignment.sortOrder}</span>
                      <span>
                        {assignment.showPhone ? "Phone allowed" : "Phone hidden"}
                      </span>
                      <span>
                        {assignment.contactable ? "Contactable" : "Not contactable"}
                      </span>
                      {assignment.contactable ? (
                        <span>
                          {assignment.contactEmailMode === "MEMBER"
                            ? `Contact via member email ${assignment.member.email}`
                            : assignment.contactEmailMode === "CUSTOM"
                              ? `Contact via custom email ${assignment.contactEmailOverride ?? "(none set)"}`
                              : `Contact via role email ${assignment.committeeRole.contactEmail ?? "(none set)"}`}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <ViewOnlyActionButton
                      canEdit={canEdit}
                      describeReason={!ancestorRendersViewOnlyBanner}
                      variant="ghost"
                      size="sm"
                      aria-label="Edit assignment"
                      onClick={() => openEditForm(assignment)}
                    >
                      <Pencil className="h-4 w-4" />
                    </ViewOnlyActionButton>
                    <ViewOnlyActionButton
                      canEdit={canEdit}
                      describeReason={!ancestorRendersViewOnlyBanner}
                      variant="ghost"
                      size="sm"
                      aria-label="Remove assignment"
                      className="text-danger-11 hover:bg-danger-3 hover:text-danger-11"
                      onClick={() => handleDeactivate(assignment)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </ViewOnlyActionButton>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
