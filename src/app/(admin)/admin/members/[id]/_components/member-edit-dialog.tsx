"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCommitteeRoleOptions } from "@/lib/use-committee-role-options";
import { GENDER_OPTIONS, TITLE_OPTIONS } from "@/lib/member-enums";
import { ExternalLink, Link2, Plus } from "lucide-react";
import { MemberAddressFields } from "@/components/member-address-fields";
import type { XeroSearchResult } from "@/components/admin/xero-suggested-contact-card";
import { getMissingFieldsForXeroCreate } from "@/lib/admin-member-detail-helpers";
import type { MemberAddressValues } from "@/lib/member-address";
import type { FinanceAccessLevel } from "@prisma/client";
import type {
  EditForm,
  EmailInheritanceSearchResult,
  MemberDetail,
} from "../_types";

interface MemberEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  member: MemberDetail;
  form: EditForm;
  formError: string;
  saving: boolean;
  isSelf: boolean;
  memberLifecycleLocked: boolean;
  adminOnlyFieldsDisabled: boolean;
  postalSameAsPhysical: boolean;
  // inherit email search
  selectedInheritEmailSource: EmailInheritanceSearchResult | null;
  inheritEmailSearch: string;
  inheritEmailSearching: boolean;
  inheritEmailSearchError: string;
  inheritEmailSearchResults: EmailInheritanceSearchResult[];
  // xero state inside edit
  xeroError: string;
  xeroChoice: "" | "change";
  xeroSearchQuery: string;
  xeroSearchResults: XeroSearchResult[];
  xeroSearching: boolean;
  xeroLinking: boolean;
  xeroUnlinking: boolean;
  xeroPushing: boolean;
  selectedXeroContactId: string;
  onChangeForm: (next: EditForm | ((prev: EditForm) => EditForm)) => void;
  onChangeAddressFields: (patch: Partial<MemberAddressValues>) => void;
  onChangePostalSameAsPhysical: (value: boolean) => void;
  onChangeInheritEmailSearch: (value: string) => void;
  onSelectInheritEmailSource: (source: EmailInheritanceSearchResult) => void;
  onClearInheritEmailSource: () => void;
  onChangeXeroSearchQuery: (value: string) => void;
  onChangeSelectedXeroContactId: (value: string) => void;
  onChangeXeroChoice: (value: "" | "change") => void;
  onClearXeroError: () => void;
  onOpenLinkXero: () => void;
  onOpenCreateXero: () => void;
  onXeroSearch: () => void;
  onXeroLink: (contactId: string) => void;
  onXeroUnlink: () => void;
  onSubmit: () => void;
}

export function MemberEditDialog({
  open,
  onOpenChange,
  member,
  form,
  formError,
  saving,
  isSelf,
  memberLifecycleLocked,
  adminOnlyFieldsDisabled,
  postalSameAsPhysical,
  selectedInheritEmailSource,
  inheritEmailSearch,
  inheritEmailSearching,
  inheritEmailSearchError,
  inheritEmailSearchResults,
  xeroError,
  xeroChoice,
  xeroSearchQuery,
  xeroSearchResults,
  xeroSearching,
  xeroLinking,
  xeroUnlinking,
  xeroPushing,
  selectedXeroContactId,
  onChangeForm,
  onChangeAddressFields,
  onChangePostalSameAsPhysical,
  onChangeInheritEmailSearch,
  onSelectInheritEmailSource,
  onClearInheritEmailSource,
  onChangeXeroSearchQuery,
  onChangeSelectedXeroContactId,
  onChangeXeroChoice,
  onClearXeroError,
  onOpenLinkXero,
  onOpenCreateXero,
  onXeroSearch,
  onXeroLink,
  onXeroUnlink,
  onSubmit,
}: MemberEditDialogProps) {
  const committeeRoleOptions = useCommitteeRoleOptions();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Member</DialogTitle>
          <DialogDescription>
            Update details for {member.firstName} {member.lastName}.
          </DialogDescription>
        </DialogHeader>
        {formError && (
          <div className="p-2 bg-red-50 border border-red-200 text-red-700 rounded text-sm">
            {formError}
          </div>
        )}
        <div className="grid gap-4 py-2">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="edit-canLogin"
              checked={form.canLogin}
              onChange={(e) =>
                onChangeForm((f) => ({
                  ...f,
                  canLogin: e.target.checked,
                  financeAccessLevel: e.target.checked
                    ? f.financeAccessLevel
                    : "NONE",
                }))
              }
              className="h-4 w-4 rounded border-gray-300"
              disabled={isSelf || memberLifecycleLocked}
            />
            <Label htmlFor="edit-canLogin">Can Login</Label>
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
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="edit-title">Title</Label>
              <Select
                value={form.title || "__none__"}
                onValueChange={(value) =>
                  onChangeForm((f) => ({
                    ...f,
                    title:
                      value === "__none__" ? "" : (value as EditForm["title"]),
                  }))
                }
              >
                <SelectTrigger id="edit-title">
                  <SelectValue placeholder="Select title" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">None</SelectItem>
                  {TITLE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-gender">Gender</Label>
              <Select
                value={form.gender || "__none__"}
                onValueChange={(value) =>
                  onChangeForm((f) => ({
                    ...f,
                    gender:
                      value === "__none__" ? "" : (value as EditForm["gender"]),
                  }))
                }
              >
                <SelectTrigger id="edit-gender">
                  <SelectValue placeholder="Select gender" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">None</SelectItem>
                  {GENDER_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="edit-firstName">First Name *</Label>
              <Input
                id="edit-firstName"
                value={form.firstName}
                onChange={(e) =>
                  onChangeForm((f) => ({ ...f, firstName: e.target.value }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-lastName">Last Name *</Label>
              <Input
                id="edit-lastName"
                value={form.lastName}
                onChange={(e) =>
                  onChangeForm((f) => ({ ...f, lastName: e.target.value }))
                }
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-email">Email *</Label>
            <Input
              id="edit-email"
              type="email"
              value={form.email}
              onChange={(e) =>
                onChangeForm((f) => ({ ...f, email: e.target.value }))
              }
            />
          </div>
          <div className="space-y-2">
            <Label>Phone</Label>
            <div className="flex gap-2">
              <Input
                className="w-20"
                placeholder="64"
                value={form.phoneCountryCode}
                onChange={(e) =>
                  onChangeForm((f) => ({
                    ...f,
                    phoneCountryCode: e.target.value,
                  }))
                }
                maxLength={5}
                aria-label="Country code"
              />
              <Input
                className="w-20"
                placeholder="27"
                value={form.phoneAreaCode}
                onChange={(e) =>
                  onChangeForm((f) => ({ ...f, phoneAreaCode: e.target.value }))
                }
                maxLength={5}
                aria-label="Area code"
              />
              <Input
                className="flex-1"
                placeholder="123 4567"
                value={form.phoneNumber}
                onChange={(e) =>
                  onChangeForm((f) => ({ ...f, phoneNumber: e.target.value }))
                }
                maxLength={15}
                aria-label="Phone number"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-dateOfBirth">Date of Birth</Label>
            <Input
              id="edit-dateOfBirth"
              type="date"
              value={form.dateOfBirth}
              onChange={(e) =>
                onChangeForm((f) => ({ ...f, dateOfBirth: e.target.value }))
              }
            />
            <p className="text-xs text-muted-foreground">
              Age tier is calculated automatically from date of birth.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-joinedDate">Joined Date</Label>
            <Input
              id="edit-joinedDate"
              type="date"
              value={form.joinedDate}
              onChange={(e) =>
                onChangeForm((f) => ({ ...f, joinedDate: e.target.value }))
              }
            />
            <p className="text-xs text-muted-foreground">
              Used for finance and Xero-linked member history.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-committeeRole">Committee Role</Label>
            <Select
              value={form.committeeRole || "__none__"}
              onValueChange={(value) =>
                onChangeForm((f) => ({
                  ...f,
                  committeeRole: value === "__none__" ? "" : value,
                }))
              }
              disabled={adminOnlyFieldsDisabled}
            >
              <SelectTrigger id="edit-committeeRole">
                <SelectValue placeholder="Select a committee position" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Not set</SelectItem>
                {(form.committeeRole &&
                !committeeRoleOptions.includes(form.committeeRole)
                  ? [form.committeeRole, ...committeeRoleOptions]
                  : committeeRoleOptions
                ).map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <fieldset className="space-y-3 rounded-md border border-slate-200 p-4">
            <legend className="px-1 text-sm font-medium">Xero</legend>
            <p className="text-sm text-slate-600">
              Manage this member&apos;s linked Xero contact from the same
              editor.
            </p>
            {xeroError && (
              <div className="p-2 bg-red-50 border border-red-200 text-red-700 rounded text-sm">
                {xeroError}
              </div>
            )}
            {member.xeroContactId ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant="secondary"
                    className="bg-blue-50 text-blue-700 border-blue-200"
                  >
                    Linked
                  </Badge>
                  <a
                    href={`https://go.xero.com/Contacts/View/${member.xeroContactId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-blue-600 hover:underline inline-flex items-center gap-1"
                  >
                    View in Xero
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
                {member.xeroContactGroups.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {member.xeroContactGroups.map((group) => (
                      <Badge
                        key={group.id}
                        variant="secondary"
                        className="bg-emerald-50 text-emerald-700 border-emerald-200"
                      >
                        {group.name}
                      </Badge>
                    ))}
                  </div>
                )}
                {member.xeroContactId && !member.xeroContactGroupsLoaded && (
                  <p className="text-xs text-slate-500">
                    Cached contact groups have not been refreshed yet.
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      onChangeXeroChoice(
                        xeroChoice === "change" ? "" : "change",
                      );
                      onChangeSelectedXeroContactId("");
                      onChangeXeroSearchQuery("");
                      onClearXeroError();
                    }}
                  >
                    <Link2 className="h-4 w-4 mr-1" />
                    {xeroChoice === "change" ? "Cancel Change" : "Change Link"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={onXeroUnlink}
                    disabled={xeroUnlinking}
                  >
                    {xeroUnlinking ? "Unlinking..." : "Unlink"}
                  </Button>
                </div>
                {xeroChoice === "change" && (
                  <div className="space-y-3 rounded-md border border-blue-200 bg-blue-50 p-3">
                    <p className="text-sm text-blue-800">
                      Search for a different Xero contact to link to this
                      member. The current link will be replaced.
                    </p>
                    <div className="flex gap-2">
                      <Input
                        placeholder="Search Xero by name or email"
                        value={xeroSearchQuery}
                        onChange={(e) =>
                          onChangeXeroSearchQuery(e.target.value)
                        }
                        onKeyDown={(e) => e.key === "Enter" && onXeroSearch()}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={onXeroSearch}
                        disabled={
                          xeroSearching || xeroSearchQuery.trim().length < 2
                        }
                      >
                        {xeroSearching ? "Searching..." : "Search"}
                      </Button>
                    </div>
                    {xeroSearchResults.filter((contact) => !contact.isLinked)
                      .length > 0 && (
                      <div className="space-y-2">
                        <Label>Available Xero contacts</Label>
                        <Select
                          value={selectedXeroContactId || undefined}
                          onValueChange={onChangeSelectedXeroContactId}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select a Xero contact" />
                          </SelectTrigger>
                          <SelectContent>
                            {xeroSearchResults
                              .filter((contact) => !contact.isLinked)
                              .map((contact) => (
                                <SelectItem
                                  key={contact.contactId}
                                  value={contact.contactId}
                                >
                                  {contact.name}
                                  {contact.email ? ` (${contact.email})` : ""}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    {selectedXeroContactId && (
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => onXeroLink(selectedXeroContactId)}
                        disabled={xeroLinking}
                      >
                        {xeroLinking
                          ? "Linking..."
                          : "Link to Selected Contact"}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-slate-600">
                  This member is not linked to a Xero contact.
                </p>
                <p className="text-xs text-amber-700">
                  Membership refresh skips unlinked members. Link or create a
                  Xero contact before expecting subscription status to update
                  automatically.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={onOpenLinkXero}
                  >
                    <Link2 className="h-4 w-4 mr-1" />
                    Link to Xero
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={onOpenCreateXero}
                    disabled={xeroPushing}
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    {xeroPushing ? "Creating..." : "Create in Xero"}
                  </Button>
                </div>
                {getMissingFieldsForXeroCreate(form).length > 0 && (
                  <p className="text-xs text-slate-500">
                    Missing for Xero creation:{" "}
                    {getMissingFieldsForXeroCreate(form).join(", ")}
                  </p>
                )}
              </div>
            )}
          </fieldset>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>Role</Label>
              <Select
                value={form.role}
                onValueChange={(v) =>
                  onChangeForm((f) => ({ ...f, role: v as "MEMBER" | "ADMIN" }))
                }
                disabled={isSelf}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="MEMBER">Member</SelectItem>
                  <SelectItem value="ADMIN">Admin</SelectItem>
                </SelectContent>
              </Select>
              {isSelf && (
                <p className="text-xs text-muted-foreground">
                  You cannot change your own role.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label>Finance Access</Label>
              <Select
                value={form.financeAccessLevel}
                onValueChange={(v) =>
                  onChangeForm((f) => ({
                    ...f,
                    financeAccessLevel: v as FinanceAccessLevel,
                  }))
                }
                disabled={!form.canLogin}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NONE">No Finance Access</SelectItem>
                  <SelectItem value="VIEWER">Finance Viewer</SelectItem>
                  <SelectItem value="MANAGER">Finance Manager</SelectItem>
                </SelectContent>
              </Select>
              {!form.canLogin && (
                <p className="text-xs text-muted-foreground">
                  Finance access only applies to login-enabled members.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label>Age Tier</Label>
              <Select
                value={form.ageTier}
                onValueChange={(v) =>
                  onChangeForm((f) => ({ ...f, ageTier: v }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="INFANT">Infant</SelectItem>
                  <SelectItem value="CHILD">Child</SelectItem>
                  <SelectItem value="YOUTH">Youth</SelectItem>
                  <SelectItem value="ADULT">Adult</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="edit-active"
              checked={form.active}
              onChange={(e) =>
                onChangeForm((f) => ({ ...f, active: e.target.checked }))
              }
              className="h-4 w-4 rounded border-gray-300"
              disabled={isSelf || memberLifecycleLocked}
            />
            <Label htmlFor="edit-active">Active</Label>
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
              id="edit-forcePasswordChange"
              checked={form.forcePasswordChange}
              onChange={(e) =>
                onChangeForm((f) => ({
                  ...f,
                  forcePasswordChange: e.target.checked,
                }))
              }
              className="h-4 w-4 rounded border-gray-300"
            />
            <Label htmlFor="edit-forcePasswordChange">
              Force Password Change on Next Login
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="edit-requiresInduction"
              checked={form.requiresInduction}
              onChange={(e) =>
                onChangeForm((f) => ({
                  ...f,
                  requiresInduction: e.target.checked,
                }))
              }
              className="h-4 w-4 rounded border-gray-300"
            />
            <Label htmlFor="edit-requiresInduction">Requires Induction</Label>
            <p className="text-xs text-muted-foreground ml-2">
              Flag this member as needing to complete a lodge induction (outside
              the automatic new-member process).
            </p>
          </div>
          {!form.canLogin && (
            <div className="space-y-2">
              <Label htmlFor="edit-inheritEmailSearch">
                Notification Email Recipient (optional)
              </Label>
              <p className="text-xs text-muted-foreground">
                Search for a primary adult member who should receive this
                member&apos;s notifications. Leave it blank to use this
                member&apos;s own email address instead.
              </p>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
                {selectedInheritEmailSource ? (
                  <div className="space-y-2">
                    <div className="font-medium text-slate-900">
                      Sending notifications to{" "}
                      {selectedInheritEmailSource.firstName}{" "}
                      {selectedInheritEmailSource.lastName}
                    </div>
                    <div className="text-xs text-slate-600">
                      {selectedInheritEmailSource.email} · Member ID{" "}
                      {selectedInheritEmailSource.id}
                      {selectedInheritEmailSource.active === false
                        ? " · Inactive"
                        : ""}
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={onClearInheritEmailSource}
                    >
                      Use this member&apos;s own email instead
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <div className="font-medium text-slate-900">
                      Using this member&apos;s own email
                    </div>
                    <div className="text-xs text-slate-600">
                      {form.email || "No email set on this member"}
                    </div>
                  </div>
                )}
              </div>
              <div className="space-y-2">
                <Input
                  id="edit-inheritEmailSearch"
                  value={inheritEmailSearch}
                  onChange={(e) => onChangeInheritEmailSearch(e.target.value)}
                  placeholder={
                    selectedInheritEmailSource
                      ? "Search to replace the selected adult"
                      : "Search adult members by name or email"
                  }
                />
                {inheritEmailSearching ? (
                  <p className="text-xs text-muted-foreground">
                    Searching eligible adult members...
                  </p>
                ) : inheritEmailSearchError ? (
                  <p className="text-xs text-red-600">
                    {inheritEmailSearchError}
                  </p>
                ) : inheritEmailSearch.trim().length >= 2 ? (
                  inheritEmailSearchResults.length > 0 ? (
                    <div className="max-h-48 space-y-2 overflow-auto rounded-md border border-slate-200 bg-white p-2">
                      {inheritEmailSearchResults.map((candidate) => (
                        <button
                          key={candidate.id}
                          type="button"
                          className="w-full rounded-md border border-slate-200 px-3 py-2 text-left text-sm hover:bg-slate-50"
                          onClick={() => onSelectInheritEmailSource(candidate)}
                        >
                          <div className="font-medium text-slate-900">
                            {candidate.firstName} {candidate.lastName}
                          </div>
                          <div className="text-xs text-slate-600">
                            {candidate.email} · Member ID {candidate.id}
                            {candidate.active === false ? " · Inactive" : ""}
                          </div>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      No eligible primary adult members matched &quot;
                      {inheritEmailSearch.trim()}&quot;.
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
          <MemberAddressFields
            idPrefix="edit-member"
            onSameAsPhysicalChange={onChangePostalSameAsPhysical}
            onValuesChange={onChangeAddressFields}
            sameAsPhysical={postalSameAsPhysical}
            values={form}
          />

          <div className="space-y-2">
            <Label htmlFor="edit-lifeMemberDate">Life Member</Label>
            <Input
              id="edit-lifeMemberDate"
              type="date"
              value={form.lifeMemberDate}
              onChange={(e) =>
                onChangeForm((f) => ({ ...f, lifeMemberDate: e.target.value }))
              }
              disabled={adminOnlyFieldsDisabled}
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="edit-associateMember"
              checked={form.associateMember}
              onChange={(e) =>
                onChangeForm((f) => ({
                  ...f,
                  associateMember: e.target.checked,
                }))
              }
              className="h-4 w-4 rounded border-gray-300"
              disabled={adminOnlyFieldsDisabled}
            />
            <Label htmlFor="edit-associateMember">Associate Member</Label>
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-comments">Comments</Label>
            <Textarea
              id="edit-comments"
              rows={4}
              value={form.comments}
              onChange={(e) =>
                onChangeForm((f) => ({ ...f, comments: e.target.value }))
              }
              disabled={adminOnlyFieldsDisabled}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={saving}>
            {saving ? "Saving..." : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
