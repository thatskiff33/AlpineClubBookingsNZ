"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Search } from "lucide-react";
import { MemberAddressFields } from "@/components/member-address-fields";
import { GENDER_OPTIONS, TITLE_OPTIONS } from "@/lib/member-enums";
import { useMemberFieldsSettings } from "@/lib/use-member-fields-settings";
import {
  dedupeParentOptions,
  formatMemberDateNz,
  parentLinkTypeLabel,
} from "@/lib/admin-member-detail-helpers";
import type { MemberAddressValues } from "@/lib/member-address";
import type {
  DependentDialogMode,
  DependentForm,
  LinkDependentSearchResult,
  MemberDetail,
} from "../_types";

interface MemberDependentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  member: MemberDetail;
  mode: DependentDialogMode;
  onChangeMode: (value: DependentDialogMode) => void;
  error: string;
  saving: boolean;
  // create tab
  createForm: DependentForm;
  createPostalSameAsPhysical: boolean;
  onChangeCreateForm: (
    next: DependentForm | ((prev: DependentForm) => DependentForm),
  ) => void;
  onChangeCreatePostalSameAsPhysical: (value: boolean) => void;
  onChangeCreateAddressFields: (patch: Partial<MemberAddressValues>) => void;
  onSubmitCreate: () => void;
  // link tab
  linkSearch: string;
  linkSearching: boolean;
  linkSearchResults: LinkDependentSearchResult[];
  linkSelected: LinkDependentSearchResult | null;
  linkNotificationParentId: string;
  linkDisableLogin: boolean;
  linkFamilyGroupIds: string[];
  onChangeLinkSearch: (value: string) => void;
  onSelectLinkCandidate: (candidate: LinkDependentSearchResult) => void;
  onClearLinkSelection: () => void;
  onChangeLinkNotificationParentId: (value: string) => void;
  onChangeLinkDisableLogin: (value: boolean) => void;
  onToggleLinkFamilyGroup: (familyGroupId: string, checked: boolean) => void;
  onSubmitLink: () => void;
}

export function MemberDependentDialog({
  open,
  onOpenChange,
  member,
  mode,
  onChangeMode,
  error,
  saving,
  createForm,
  createPostalSameAsPhysical,
  onChangeCreateForm,
  onChangeCreatePostalSameAsPhysical,
  onChangeCreateAddressFields,
  onSubmitCreate,
  linkSearch,
  linkSearching,
  linkSearchResults,
  linkSelected,
  linkNotificationParentId,
  linkDisableLogin,
  linkFamilyGroupIds,
  onChangeLinkSearch,
  onSelectLinkCandidate,
  onClearLinkSelection,
  onChangeLinkNotificationParentId,
  onChangeLinkDisableLogin,
  onToggleLinkFamilyGroup,
  onSubmitLink,
}: MemberDependentDialogProps) {
  const { showTitle, showGender } = useMemberFieldsSettings();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Dependent</DialogTitle>
          <DialogDescription>
            Create a new dependent or link an existing member under{" "}
            {member.firstName} {member.lastName}.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <div className="p-2 bg-red-50 border border-red-200 text-red-700 rounded text-sm">
            {error}
          </div>
        )}
        <Tabs
          value={mode}
          onValueChange={(value) => onChangeMode(value as DependentDialogMode)}
        >
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="create">Create new</TabsTrigger>
            <TabsTrigger value="link">Link existing</TabsTrigger>
          </TabsList>
          <TabsContent value="create" className="mt-4">
            <div className="grid gap-4 py-2">
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
                This dependent will be created as a non-login member and inherit
                notifications from the parent email.
              </div>

              {(showTitle || showGender) && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {showTitle && (
                    <div className="space-y-2">
                      <Label htmlFor="dependent-title">Title</Label>
                      <Select
                        value={createForm.title || "__none__"}
                        onValueChange={(value) =>
                          onChangeCreateForm((f) => ({
                            ...f,
                            title:
                              value === "__none__"
                                ? ""
                                : (value as DependentForm["title"]),
                          }))
                        }
                      >
                        <SelectTrigger id="dependent-title">
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
                  )}
                  {showGender && (
                    <div className="space-y-2">
                      <Label htmlFor="dependent-gender">Gender</Label>
                      <Select
                        value={createForm.gender || "__none__"}
                        onValueChange={(value) =>
                          onChangeCreateForm((f) => ({
                            ...f,
                            gender:
                              value === "__none__"
                                ? ""
                                : (value as DependentForm["gender"]),
                          }))
                        }
                      >
                        <SelectTrigger id="dependent-gender">
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
                  )}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="dependent-firstName">First Name *</Label>
                  <Input
                    id="dependent-firstName"
                    value={createForm.firstName}
                    onChange={(e) =>
                      onChangeCreateForm((f) => ({
                        ...f,
                        firstName: e.target.value,
                      }))
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="dependent-lastName">Last Name *</Label>
                  <Input
                    id="dependent-lastName"
                    value={createForm.lastName}
                    onChange={(e) =>
                      onChangeCreateForm((f) => ({
                        ...f,
                        lastName: e.target.value,
                      }))
                    }
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="dependent-email">Email *</Label>
                <Input
                  id="dependent-email"
                  type="email"
                  value={createForm.email}
                  onChange={(e) =>
                    onChangeCreateForm((f) => ({ ...f, email: e.target.value }))
                  }
                />
                <p className="text-xs text-muted-foreground">
                  This can match the parent email. Delivery will still be
                  controlled by the inherited-email settings.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="dependent-dateOfBirth">Date of Birth *</Label>
                <Input
                  id="dependent-dateOfBirth"
                  type="date"
                  value={createForm.dateOfBirth}
                  onChange={(e) =>
                    onChangeCreateForm((f) => ({
                      ...f,
                      dateOfBirth: e.target.value,
                    }))
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Age tier will be calculated from date of birth.
                </p>
              </div>

              <div className="space-y-2">
                <Label>Phone</Label>
                <div className="flex gap-2">
                  <Input
                    className="w-20"
                    placeholder="64"
                    value={createForm.phoneCountryCode}
                    onChange={(e) =>
                      onChangeCreateForm((f) => ({
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
                    value={createForm.phoneAreaCode}
                    onChange={(e) =>
                      onChangeCreateForm((f) => ({
                        ...f,
                        phoneAreaCode: e.target.value,
                      }))
                    }
                    maxLength={5}
                    aria-label="Area code"
                  />
                  <Input
                    className="flex-1"
                    placeholder="123 4567"
                    value={createForm.phoneNumber}
                    onChange={(e) =>
                      onChangeCreateForm((f) => ({
                        ...f,
                        phoneNumber: e.target.value,
                      }))
                    }
                    maxLength={15}
                    aria-label="Phone number"
                  />
                </div>
              </div>

              <MemberAddressFields
                idPrefix="dependent"
                onSameAsPhysicalChange={onChangeCreatePostalSameAsPhysical}
                onValuesChange={onChangeCreateAddressFields}
                sameAsPhysical={createPostalSameAsPhysical}
                values={createForm}
              />
            </div>
          </TabsContent>
          <TabsContent value="link" className="mt-4">
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label htmlFor="link-dependent-search">Member search</Label>
                <div className="relative">
                  <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                  <Input
                    id="link-dependent-search"
                    value={linkSearch}
                    onChange={(e) => onChangeLinkSearch(e.target.value)}
                    placeholder="Search by name, email, or member ID"
                    className="pl-9"
                  />
                  {linkSearching && (
                    <div className="absolute right-3 top-2.5 text-xs text-slate-400">
                      Searching...
                    </div>
                  )}
                </div>
              </div>

              {linkSelected ? (
                <div className="rounded-md border border-slate-200 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium text-slate-900">
                          {linkSelected.firstName} {linkSelected.lastName}
                        </p>
                        <Badge variant="secondary">
                          {linkSelected.ageTier}
                        </Badge>
                        {!linkSelected.active && (
                          <Badge
                            variant="secondary"
                            className="bg-slate-100 text-slate-600 border-slate-200"
                          >
                            Inactive
                          </Badge>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        {linkSelected.email}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        {linkSelected.canLogin ? "Can login" : "Non-login"}
                        {linkSelected.dateOfBirth
                          ? ` · DOB ${formatMemberDateNz(linkSelected.dateOfBirth)}`
                          : ""}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={onClearLinkSelection}
                      disabled={saving}
                    >
                      Change
                    </Button>
                  </div>
                </div>
              ) : linkSearch.trim().length >= 2 &&
                linkSearchResults.length > 0 ? (
                <div className="max-h-56 overflow-y-auto rounded-md border border-slate-200">
                  {linkSearchResults.map((candidate) => (
                    <button
                      key={candidate.id}
                      type="button"
                      onClick={() => onSelectLinkCandidate(candidate)}
                      className="w-full border-b border-slate-100 px-3 py-2 text-left text-sm last:border-b-0 hover:bg-slate-50"
                    >
                      <span className="font-medium">
                        {candidate.firstName} {candidate.lastName}
                      </span>
                      <span className="ml-2 text-slate-500">
                        {candidate.email}
                      </span>
                      <span className="ml-2 text-xs text-slate-400">
                        {candidate.ageTier}
                      </span>
                    </button>
                  ))}
                </div>
              ) : linkSearch.trim().length >= 2 && !linkSearching ? (
                <p className="text-sm text-slate-500">
                  No eligible members found.
                </p>
              ) : (
                <p className="text-sm text-slate-500">
                  Start typing at least 2 characters to search.
                </p>
              )}

              {linkSelected && (
                <div className="space-y-4">
                  <div className="space-y-3 rounded-md border border-slate-200 p-3">
                    <div className="space-y-2">
                      <Label htmlFor="link-dependent-notification-source">
                        Notification email recipient
                      </Label>
                      <select
                        id="link-dependent-notification-source"
                        value={linkNotificationParentId}
                        onChange={(event) =>
                          onChangeLinkNotificationParentId(event.target.value)
                        }
                        disabled={saving}
                        className="flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900"
                      >
                        <option value="">
                          Use {linkSelected.firstName}&apos;s own email
                        </option>
                        {dedupeParentOptions([
                          ...(linkSelected.parentLinks ?? []),
                          {
                            id: member.id,
                            firstName: member.firstName,
                            lastName: member.lastName,
                            email: member.email,
                            ageTier: member.ageTier,
                            active: member.active,
                            canLogin: member.canLogin,
                            inheritEmailFromId: member.inheritEmailFromId,
                            parentLinkType: ((linkSelected.parentLinks
                              ?.length ?? 0) === 0
                              ? "PRIMARY"
                              : "SECONDARY") as "PRIMARY" | "SECONDARY",
                          },
                        ]).map((parent) => (
                          <option key={parent.id} value={parent.id}>
                            {parent.firstName} {parent.lastName} (
                            {parentLinkTypeLabel(parent.parentLinkType)})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex items-start gap-2">
                      <Checkbox
                        id="link-dependent-disable-login"
                        checked={linkDisableLogin}
                        onCheckedChange={(checked) =>
                          onChangeLinkDisableLogin(checked === true)
                        }
                        disabled={saving}
                      />
                      <Label
                        htmlFor="link-dependent-disable-login"
                        className="text-sm font-normal"
                      >
                        Disable login
                      </Label>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label>Add to family groups</Label>
                    {member.familyGroups.length > 0 ? (
                      <div className="space-y-2 rounded-md border border-slate-200 p-3">
                        {member.familyGroups.map((group) => (
                          <div
                            key={group.id}
                            className="flex items-center gap-2"
                          >
                            <Checkbox
                              id={`link-dependent-family-group-${group.id}`}
                              checked={linkFamilyGroupIds.includes(group.id)}
                              onCheckedChange={(checked) =>
                                onToggleLinkFamilyGroup(
                                  group.id,
                                  checked === true,
                                )
                              }
                              disabled={saving}
                            />
                            <Label
                              htmlFor={`link-dependent-family-group-${group.id}`}
                              className="text-sm font-normal"
                            >
                              {group.name || "Unnamed group"}
                            </Label>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-slate-500">
                        This parent is not in any family groups.
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            onClick={mode === "create" ? onSubmitCreate : onSubmitLink}
            disabled={saving || (mode === "link" && !linkSelected)}
          >
            {saving
              ? mode === "create"
                ? "Creating..."
                : "Linking..."
              : mode === "create"
                ? "Create Dependent"
                : "Link Dependent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
