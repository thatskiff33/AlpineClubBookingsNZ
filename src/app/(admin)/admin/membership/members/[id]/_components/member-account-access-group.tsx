"use client";

import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Pencil } from "lucide-react";
import { MemberAccessRolePicker } from "@/components/member-access-role-picker";
import { getLoginBadge } from "@/lib/admin-member-badges";
import {
  accessRoleTokensForUserType,
  deriveUserType,
  hasPrivilegedAccess,
  normalizeAssignableAccessRoleTokens,
  storedAccessRolesForFullAdminGate,
  USER_TYPE_LABELS,
  type UserType,
} from "@/lib/access-roles";
import { accessRoleLabelForToken } from "@/lib/access-role-definitions";
import {
  buildAccessRolePatch,
  type MemberAccountEditForm,
} from "@/lib/admin-member-edit-groups";
import { useAccessRoleOptions } from "@/hooks/use-access-role-options";
import type { useInheritEmailSearch } from "../_hooks/use-inherit-email-search";
import type { MemberGroupEditState } from "../_hooks/use-member-group-edit";
import type { MemberDetail } from "../_types";

interface MemberAccountAccessGroupProps {
  member: MemberDetail;
  isSelf: boolean;
  actorIsFullAdmin: boolean;
  memberLifecycleLocked: boolean;
  edit: MemberGroupEditState<MemberAccountEditForm>;
  inheritEmail: ReturnType<typeof useInheritEmailSearch>;
  /** Whether the actor may edit account/access details (membership edit, #1997). */
  // Tri-state (#2065): `undefined` while the session resolves (neutral disabled).
  canEdit: boolean | undefined;
}

export function MemberAccountAccessGroup({
  member,
  isSelf,
  actorIsFullAdmin,
  memberLifecycleLocked,
  edit,
  inheritEmail,
  canEdit,
}: MemberAccountAccessGroupProps) {
  const roleOptions = useAccessRoleOptions();
  const loginBadge = getLoginBadge(member.canLogin);
  const accessRoles = member.accessRoles ?? [];
  // Lodge/kiosk accounts surface as a read-only type label (issue #1439);
  // canLogin is ignored here so a login toggle mid-edit cannot silently
  // reclassify a kiosk account.
  const isLodgeAccount = deriveUserType(accessRoles) === "lodge";
  // The User Type select only exposes the admin-role picker while "Admin" is
  // chosen. Selection is sticky UI state (not purely derived from tokens):
  // switching to Admin starts with no admin roles ticked, and unticking an
  // admin member's last role must not collapse the section mid-edit.
  const [adminTypeSelected, setAdminTypeSelected] = useState(false);
  const wasEditing = useRef(false);
  // Mirror the server-side Full Admin gates (#1012/#1026/#1038) so scoped
  // admins see disabled controls instead of a 403 after the fact. "live" =
  // the member's effective roles are privileged; "dormant" = only the stored
  // legacy role fields are (archive/cancel clears canLogin, not the roles).
  const memberPrivilege: "live" | "dormant" | null = hasPrivilegedAccess(member)
    ? "live"
    : storedAccessRolesForFullAdminGate(member).some(
          (role) => role !== "USER" && role !== "ORG",
        )
      ? "dormant"
      : null;

  const { editing, form, saving, error, errorRef } = edit;

  // Seed the sticky type selection once per edit session, from the form
  // snapshot taken at unlock time; in-session token edits go through the
  // handlers below so "Admin" stays selected while roles are being picked.
  useEffect(() => {
    if (editing && !wasEditing.current && form) {
      setAdminTypeSelected(
        deriveUserType(form.accessRoles, form.canLogin) === "admin",
      );
    }
    wasEditing.current = editing;
  }, [editing, form]);

  if (editing && form) {
    const updateForm = edit.updateForm;
    const toggleAccessRole = (token: string, checked: boolean) => {
      updateForm((current) => {
        const nextRoles = normalizeAssignableAccessRoleTokens(
          checked
            ? [...current.accessRoles, token]
            : current.accessRoles.filter((value) => value !== token),
          { canLogin: current.canLogin },
        );
        return {
          ...current,
          ...buildAccessRolePatch(nextRoles, roleOptions),
        };
      });
    };

    const scopedActor = !actorIsFullAdmin;
    const displayedType: UserType = adminTypeSelected
      ? "admin"
      : deriveUserType(form.accessRoles, form.canLogin);
    // Options for the picker inside the Admin disclosure: USER is driven by
    // the "Also a club member" checkbox, ORG is mutually exclusive with
    // Admin, and LODGE is a read-only account type here — none of the three
    // carries an admin permission bundle, so the matrix preview is unchanged.
    const adminRoleOptions = roleOptions.filter(
      (option) =>
        option.token !== "USER" &&
        option.token !== "ORG" &&
        option.token !== "LODGE",
    );
    const typeSelectDisabled =
      isSelf ||
      !form.canLogin ||
      (scopedActor && memberPrivilege !== null);
    const typeSelectMessage =
      displayedType === "admin"
        ? null // the picker below explains its own gating
        : isSelf
          ? "You cannot change your own access roles."
          : !form.canLogin
            ? "Access roles only apply to login-enabled records."
            : scopedActor && memberPrivilege === "dormant"
              ? "This member holds a dormant privileged legacy role, so any reclassification (including User/Org) requires Full Admin."
              : scopedActor
                ? "Only a Full Admin can classify a member as an Admin."
                : null;

    const changeUserType = (value: string) => {
      const nextType = value as Exclude<UserType, "lodge">;
      setAdminTypeSelected(nextType === "admin");
      updateForm((current) => {
        // Switching to Admin restores the member's stored privileged roles
        // (a user→admin→user round trip within one session is a no-op);
        // "also a club member" defaults ON per the owner decision.
        const base =
          nextType === "admin"
            ? [...current.accessRoles, ...accessRoles]
            : current.accessRoles;
        const nextRoles = normalizeAssignableAccessRoleTokens(
          accessRoleTokensForUserType(nextType, base),
          { canLogin: current.canLogin },
        );
        return {
          ...current,
          ...buildAccessRolePatch(nextRoles, roleOptions),
        };
      });
    };

    const toggleAlsoClubMember = (checked: boolean) => {
      updateForm((current) => {
        const nextRoles = normalizeAssignableAccessRoleTokens(
          checked
            ? ["USER", ...current.accessRoles]
            : current.accessRoles.filter((value) => value !== "USER"),
          { canLogin: current.canLogin },
        );
        return {
          ...current,
          ...buildAccessRolePatch(nextRoles, roleOptions),
        };
      });
    };

    return (
      <div className="space-y-4">
        {error && (
          <div
            ref={errorRef}
            role="alert"
            tabIndex={-1}
            className="scroll-mt-20 whitespace-pre-line rounded border border-danger-6 bg-danger-3 p-2 text-sm text-danger-11 focus:outline-none"
          >
            {error}
          </div>
        )}
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="account-canLogin"
            checked={form.canLogin}
            onChange={(e) =>
              updateForm((f) => ({
                ...f,
                canLogin: e.target.checked,
                ...buildAccessRolePatch(
                  normalizeAssignableAccessRoleTokens(
                    e.target.checked
                      ? f.accessRoles.length > 0
                        ? f.accessRoles
                        : accessRoles.length > 0
                          ? accessRoles
                          : ["USER"]
                      : [],
                    { canLogin: e.target.checked },
                  ),
                  roleOptions,
                ),
              }))
            }
            className="h-4 w-4 rounded border-border"
            disabled={isSelf || memberLifecycleLocked}
          />
          <Label htmlFor="account-canLogin">Can Login</Label>
          <p className="text-xs text-muted-foreground ml-2">
            Adults who can sign in and make bookings. Uncheck for infants,
            children, or youth managed by family group.
            {isSelf
              ? " You cannot disable login for your own admin account."
              : ""}
            {memberLifecycleLocked
              ? " Cancelled and archived members stay non-login."
              : ""}
          </p>
        </div>
        {isLodgeAccount ? (
          <div className="space-y-1">
            <Label>User Type</Label>
            <p className="text-sm font-medium">
              {USER_TYPE_LABELS.lodge}
            </p>
            <p className="text-xs text-muted-foreground">
              Lodge kiosk accounts keep their access as-is; this type cannot
              be changed here.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="account-userType">User Type</Label>
            <Select
              value={displayedType === "lodge" ? "user" : displayedType}
              onValueChange={changeUserType}
              disabled={typeSelectDisabled}
            >
              <SelectTrigger id="account-userType" className="max-w-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="user">
                  {USER_TYPE_LABELS.user}
                </SelectItem>
                <SelectItem value="organisation">
                  {USER_TYPE_LABELS.organisation}
                </SelectItem>
                <SelectItem value="admin" disabled={!actorIsFullAdmin}>
                  {USER_TYPE_LABELS.admin}
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              User is an ordinary member account, Organisation is a school or
              group account, and Admin unlocks the admin access roles below.
            </p>
            {typeSelectMessage && (
              <p className="text-xs text-muted-foreground">
                {typeSelectMessage}
              </p>
            )}
          </div>
        )}
        {!isLodgeAccount && displayedType === "admin" && (
          <>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="account-alsoClubMember"
                checked={form.accessRoles.includes("USER")}
                onChange={(e) => toggleAlsoClubMember(e.target.checked)}
                className="h-4 w-4 rounded border-border"
                disabled={
                  isSelf || !form.canLogin || !actorIsFullAdmin
                }
              />
              <Label htmlFor="account-alsoClubMember">
                Also a club member
              </Label>
              <p className="text-xs text-muted-foreground ml-2">
                Keeps normal member features (own bookings, family) alongside
                admin access.
              </p>
            </div>
            <MemberAccessRolePicker
              roleOptions={adminRoleOptions}
              accessRoles={form.accessRoles}
              canLogin={form.canLogin}
              disabled={isSelf}
              disabledMessage={
                isSelf ? "You cannot change your own access roles." : undefined
              }
              actorIsFullAdmin={actorIsFullAdmin}
              memberPrivilege={memberPrivilege}
              onToggleRole={toggleAccessRole}
            />
            {form.canLogin &&
              deriveUserType(form.accessRoles, form.canLogin) !== "admin" && (
                <p className="text-xs text-muted-foreground">
                  No admin roles are ticked yet — saving now stores this
                  member as a plain User.
                </p>
              )}
          </>
        )}
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="account-active"
            checked={form.active}
            onChange={(e) =>
              updateForm((f) => ({ ...f, active: e.target.checked }))
            }
            className="h-4 w-4 rounded border-border"
            disabled={isSelf || memberLifecycleLocked}
          />
          <Label htmlFor="account-active">Active</Label>
          {isSelf && (
            <span className="text-xs text-muted-foreground ml-1">
              (cannot deactivate own account)
            </span>
          )}
          {memberLifecycleLocked && (
            <span className="text-xs text-muted-foreground ml-1">
              (locked by lifecycle state)
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="account-forcePasswordChange"
            checked={form.forcePasswordChange}
            onChange={(e) =>
              updateForm((f) => ({
                ...f,
                forcePasswordChange: e.target.checked,
              }))
            }
            className="h-4 w-4 rounded border-border"
          />
          <Label htmlFor="account-forcePasswordChange">
            Force Password Change on Next Login
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="account-requiresInduction"
            checked={form.requiresInduction}
            onChange={(e) =>
              updateForm((f) => ({
                ...f,
                requiresInduction: e.target.checked,
              }))
            }
            className="h-4 w-4 rounded border-border"
          />
          <Label htmlFor="account-requiresInduction">Requires Induction</Label>
          <p className="text-xs text-muted-foreground ml-2">
            Flag this member as needing to complete a lodge induction (outside
            the automatic new-member process).
          </p>
        </div>
        {!form.canLogin && (
          <div className="space-y-2">
            <Label htmlFor="account-inheritEmailSearch">
              Notification Email Recipient (optional)
            </Label>
            <p className="text-xs text-muted-foreground">
              Search for a primary adult member who should receive this
              member&apos;s notifications. Leave it blank to use this
              member&apos;s own email address instead.
            </p>
            <div className="rounded-lg border border-border bg-muted p-3 text-sm">
              {inheritEmail.selected ? (
                <div className="space-y-2">
                  <div className="font-medium text-foreground">
                    Sending notifications to {inheritEmail.selected.firstName}{" "}
                    {inheritEmail.selected.lastName}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {inheritEmail.selected.email} · Member ID{" "}
                    {inheritEmail.selected.id}
                    {inheritEmail.selected.active === false
                      ? " · Inactive"
                      : ""}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      inheritEmail.clear();
                      updateForm((f) => ({ ...f, inheritEmailFromId: null }));
                    }}
                  >
                    Use this member&apos;s own email instead
                  </Button>
                </div>
              ) : (
                <div className="space-y-1">
                  <div className="font-medium text-foreground">
                    Using this member&apos;s own email
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {member.email || "No email set on this member"}
                  </div>
                </div>
              )}
            </div>
            <div className="space-y-2">
              <Input
                id="account-inheritEmailSearch"
                value={inheritEmail.search}
                onChange={(e) => inheritEmail.setSearch(e.target.value)}
                placeholder={
                  inheritEmail.selected
                    ? "Search to replace the selected adult"
                    : "Search adult members by name or email"
                }
              />
              {inheritEmail.searching ? (
                <p className="text-xs text-muted-foreground">
                  Searching eligible adult members...
                </p>
              ) : inheritEmail.error ? (
                <p className="text-xs text-danger-11">{inheritEmail.error}</p>
              ) : inheritEmail.search.trim().length >= 2 ? (
                inheritEmail.results.length > 0 ? (
                  <div className="max-h-48 space-y-2 overflow-auto rounded-md border border-border bg-card p-2">
                    {inheritEmail.results.map((candidate) => (
                      <button
                        key={candidate.id}
                        type="button"
                        className="w-full rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-accent"
                        onClick={() => {
                          inheritEmail.select(candidate);
                          updateForm((f) => ({
                            ...f,
                            inheritEmailFromId: candidate.id,
                          }));
                        }}
                      >
                        <div className="font-medium text-foreground">
                          {candidate.firstName} {candidate.lastName}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {candidate.email} · Member ID {candidate.id}
                          {candidate.active === false ? " · Inactive" : ""}
                        </div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No eligible primary adult members matched &quot;
                    {inheritEmail.search.trim()}&quot;.
                  </p>
                )
              ) : (
                <p className="text-xs text-muted-foreground">
                  Only primary adult members can be selected. Start typing at
                  least 2 characters to search.
                </p>
              )}
            </div>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={edit.cancelEdit} disabled={saving}>
            Cancel
          </Button>
          <ViewOnlyActionButton
            canEdit={canEdit}
            onClick={() => void edit.save()}
            disabled={saving}
          >
            {saving ? "Saving..." : "Save Changes"}
          </ViewOnlyActionButton>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <ViewOnlyActionButton canEdit={canEdit} variant="outline" size="sm" onClick={edit.startEdit}>
          <Pencil className="h-4 w-4 mr-1" />
          Edit
        </ViewOnlyActionButton>
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">User Type</dt>
          <dd className="font-medium">
            {USER_TYPE_LABELS[deriveUserType(accessRoles, member.canLogin)]}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Login</dt>
          <dd className="font-medium">
            <Badge variant="secondary" className={loginBadge.className}>
              {loginBadge.label}
            </Badge>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Access Roles</dt>
          <dd className="flex flex-wrap gap-1 font-medium">
            {accessRoles.length > 0 ? (
              accessRoles.map((role) => (
                <Badge
                  key={role}
                  variant={role.startsWith("ADMIN") ? "default" : "secondary"}
                >
                  {accessRoleLabelForToken(role, roleOptions)}
                </Badge>
              ))
            ) : (
              <Badge variant="secondary">No Login</Badge>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Account Status</dt>
          <dd className="font-medium">
            {member.active ? "Active" : "Inactive"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Password Reset Required</dt>
          <dd className="font-medium">
            {member.forcePasswordChange ? "Yes" : "No"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Requires Induction</dt>
          <dd className="font-medium">
            {member.requiresInduction ? "Yes" : "No"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Email Inheritance</dt>
          <dd className="font-medium">
            {member.inheritEmailFrom ? (
              <span className="text-xs">
                {member.inheritEmailFrom.firstName}{" "}
                {member.inheritEmailFrom.lastName}{" "}
                <span className="text-muted-foreground">
                  ({member.inheritEmailFrom.email})
                </span>
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">Own email</span>
            )}
          </dd>
        </div>
      </dl>
    </div>
  );
}
