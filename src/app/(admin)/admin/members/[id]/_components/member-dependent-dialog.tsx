"use client";

import { useId } from "react";
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
import { FieldHint, describedByFieldHint } from "@/components/ui/field-hint";
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
  parentLinkTypeLabel,
} from "@/lib/admin-member-detail-helpers";
import { formatPayloadCalendarDay } from "../../../_lib/calendar-day";
import {
  DEPENDENT_PARENT_CREATE_ERRORS,
  DEPENDENT_PARENT_LINK_ERRORS,
  dependentParentStateBlocker,
} from "@/lib/dependent-link-eligibility";
import { useDependentEmailSource } from "@/hooks/use-dependent-email-source";
import {
  DependentNotice,
  DependentNotificationRoutingNotice,
} from "./dependent-notices";
import type { MemberAddressValues } from "@/lib/member-address";
import type {
  DependentDialogMode,
  DependentForm,
  LinkDependentIneligibleMatch,
  LinkDependentSearchResult,
  MemberDetail,
} from "../_types";

/*
  #2264 — ONE hint for the whole phone row (country / area / number) instead of
  an example parked in each box's placeholder, where grey text reads as a value
  already entered. A hook cannot serve three controls (one `useFieldHint` pairs
  with exactly one `fieldProps` spread), so the id is a module constant wired to
  each box with `describedByFieldHint`.
*/
const PHONE_HINT_ID = "member-dependent-phone-hint";

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
  /**
   * Members the search matched but could not offer, each with the reason
   * (#2254). Only populated when the eligible list is empty.
   */
  linkIneligibleMatches: LinkDependentIneligibleMatch[];
  /**
   * #2254: the server's own "the text search matched no member at all" signal.
   * The rendered results list cannot stand in for it — it is filtered
   * client-side — so the empty state only claims nobody matched when this says
   * so.
   */
  linkSearchMatchedNobody: boolean;
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
  linkIneligibleMatches,
  linkSearchMatchedNobody,
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
  // #2282: the dialog states the block for ITSELF rather than trusting that the
  // button which opened it was disabled. The two tabs are two endpoints with
  // two messages, and gating only one would leave the identical dead end on the
  // other — so the notice follows the active tab and the submit is disabled in
  // both. The dialog is also its own accessibility container, so a reason shown
  // out on the page behind it does not reach a screen reader in here.
  //
  // DEFENCE IN DEPTH, and deliberately so: both openers are already disabled
  // whenever this reason is set, and the member cannot change while the dialog
  // is open, so an admin does not normally meet these two sentences. They are
  // kept because the dialog is a component anyone can render, not because
  // `member-dependents-add-gating.test.tsx` is evidence of admin-visible
  // behaviour — do not read that suite's two "blocks the CREATE/LINK tab" cases
  // that way. The tab-level blocks BELOW are a different matter: those are
  // reachable, because nothing disables the opener for them.
  const blockReason = dependentParentStateBlocker(member);
  const blockMessage = blockReason
    ? mode === "create"
      ? DEPENDENT_PARENT_CREATE_ERRORS[blockReason]
      : DEPENDENT_PARENT_LINK_ERRORS[blockReason]
    : null;
  const blockMessageId = useId();
  // Where a created dependent's club email will actually land. Resolved by the
  // server with the same walk the write uses, so this is a statement rather than
  // a guess: for a young or address-less parent it names an adult further up.
  const emailSource = member.dependentEmailSource;
  // #2282 review: the CREATE tab always sends `inheritParentEmail: true` and no
  // explicit source, so `dependentEmailSource === null` is EXACTLY the condition
  // `createAdminMember` 422s on. That is the flagship case of this issue — a
  // young parent whose own parent is not a member — and it was the one path
  // still offering a control that could only fail on save. The tab now refuses
  // up front and names the route that does work.
  const createBlockedByNoEmailSource = !blockReason && !emailSource;
  const createNoticeId = useId();
  // The LINK tab's equivalent, but conditional on what the admin picked rather
  // than on the member: linking is legitimate here with "use their own email",
  // and with an adult candidate it does not inherit at all. Only a selection
  // that would resolve to nobody is refused, so the opener stays enabled.
  const linkRouting = useDependentEmailSource(
    linkSelected ? linkNotificationParentId : null,
  );
  const linkRoutingNoticeId = useId();
  const linkBlockedByNoEmailSource =
    linkRouting.status === "ready" && linkRouting.source === null;
  const linkNotificationParentName = (() => {
    if (linkNotificationParentId === member.id) {
      return `${member.firstName} ${member.lastName}`;
    }
    const parent = (linkSelected?.parentLinks ?? []).find(
      (link) => link.id === linkNotificationParentId,
    );
    return parent
      ? `${parent.firstName} ${parent.lastName}`
      : "the selected parent";
  })();
  const submitBlockMessageId =
    mode === "create"
      ? blockMessage
        ? blockMessageId
        : createBlockedByNoEmailSource
          ? createNoticeId
          : undefined
      : blockMessage
        ? blockMessageId
        : linkBlockedByNoEmailSource
          ? linkRoutingNoticeId
          : undefined;
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
          <div className="p-2 bg-danger-3 border border-danger-6 text-danger-11 rounded text-sm whitespace-pre-line">
            {error}
          </div>
        )}
        <DependentNotice
          id={blockMessageId}
          tone="warning"
          className="p-2 text-sm"
        >
          {blockMessage}
        </DependentNotice>
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
              {/* #2282: name the mailbox rather than saying "the parent email".
                  Parentage is recordable at any age, but the contact of record
                  must be an adult, so for a young parent the notifications go to
                  an adult further up the family — and the admin should read that
                  here, not deduce it from a stored pointer afterwards. */}
              {emailSource ? (
                <div className="rounded-md border border-border bg-muted p-3 text-sm text-muted-foreground">
                  {`This dependent will be created as a non-login member. Club notifications for them go to ${emailSource.firstName} ${emailSource.lastName} (${emailSource.email}).`}
                </div>
              ) : (
                <DependentNotice
                  id={createNoticeId}
                  tone="warning"
                  className="p-3 text-sm"
                >
                  No adult the club can email is recorded at or above{" "}
                  {member.firstName} {member.lastName}, and a dependent created
                  here always inherits their contact of record — so this would
                  be refused on save. Record an email address for an adult in
                  the family, or add the member on their own from the Members
                  list and then use <strong>Link existing</strong> here with{" "}
                  <em>Use their own email</em>.
                </DependentNotice>
              )}

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
                    value={createForm.phoneCountryCode}
                    onChange={(e) =>
                      onChangeCreateForm((f) => ({
                        ...f,
                        phoneCountryCode: e.target.value,
                      }))
                    }
                    maxLength={5}
                    aria-label="Country code"
                    aria-describedby={describedByFieldHint(PHONE_HINT_ID)}
                  />
                  <Input
                    className="w-20"
                    value={createForm.phoneAreaCode}
                    onChange={(e) =>
                      onChangeCreateForm((f) => ({
                        ...f,
                        phoneAreaCode: e.target.value,
                      }))
                    }
                    maxLength={5}
                    aria-label="Area code"
                    aria-describedby={describedByFieldHint(PHONE_HINT_ID)}
                  />
                  <Input
                    className="flex-1"
                    value={createForm.phoneNumber}
                    onChange={(e) =>
                      onChangeCreateForm((f) => ({
                        ...f,
                        phoneNumber: e.target.value,
                      }))
                    }
                    maxLength={15}
                    aria-label="Phone number"
                    aria-describedby={describedByFieldHint(PHONE_HINT_ID)}
                  />
                </div>
                <FieldHint id={PHONE_HINT_ID}>Example: 64 27 123 4567</FieldHint>
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
                  <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="link-dependent-search"
                    value={linkSearch}
                    onChange={(e) => onChangeLinkSearch(e.target.value)}
                    placeholder="Search by name, email, or member ID"
                    className="pl-9"
                  />
                  {linkSearching && (
                    <div className="absolute right-3 top-2.5 text-xs text-muted-foreground">
                      Searching...
                    </div>
                  )}
                </div>
              </div>

              {linkSelected ? (
                <div className="rounded-md border border-border p-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium text-foreground">
                          {linkSelected.firstName} {linkSelected.lastName}
                        </p>
                        <Badge variant="secondary">
                          {linkSelected.ageTier}
                        </Badge>
                        {!linkSelected.active && (
                          <Badge
                            variant="secondary"
                            className="bg-muted text-muted-foreground border-border"
                          >
                            Inactive
                          </Badge>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {linkSelected.email}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {linkSelected.canLogin ? "Can login" : "Non-login"}
                        {linkSelected.dateOfBirth
                          ? ` · DOB ${formatPayloadCalendarDay(linkSelected.dateOfBirth)}`
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
                <div className="max-h-56 overflow-y-auto rounded-md border border-border">
                  {linkSearchResults.map((candidate) => (
                    <button
                      key={candidate.id}
                      type="button"
                      onClick={() => onSelectLinkCandidate(candidate)}
                      className="w-full border-b border-border px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent"
                    >
                      <span className="font-medium">
                        {candidate.firstName} {candidate.lastName}
                      </span>
                      <span className="ml-2 text-muted-foreground">
                        {candidate.email}
                      </span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {candidate.ageTier}
                      </span>
                    </button>
                  ))}
                </div>
              ) : linkSearch.trim().length >= 2 && !linkSearching ? (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    {linkIneligibleMatches.length > 0
                      ? "No eligible members found. These members matched your search but cannot be linked:"
                      : linkSearchMatchedNobody
                        ? "No members matched your search."
                        : "No eligible members found."}
                  </p>
                  {linkIneligibleMatches.length > 0 && (
                    <ul className="space-y-1 rounded-md border border-border p-3">
                      {linkIneligibleMatches.map((candidate) => (
                        <li
                          key={candidate.id}
                          className="text-xs text-muted-foreground"
                        >
                          <span className="font-medium text-foreground">
                            {candidate.firstName} {candidate.lastName}
                          </span>{" "}
                          ({candidate.email}) {candidate.explanation}.
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Start typing at least 2 characters to search.
                </p>
              )}

              {linkSelected && (
                <div className="space-y-4">
                  <div className="space-y-3 rounded-md border border-border p-3">
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
                        className="flex h-10 w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground"
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
                      {/* #2282 review: the options above name PARENTS, and the
                          write resolves the chosen parent to the nearest adult
                          who can actually receive mail — so the option label is
                          not the answer. This is. */}
                      <DependentNotificationRoutingNotice
                        id={linkRoutingNoticeId}
                        state={linkRouting}
                        selectedParentId={linkNotificationParentId}
                        selectedParentName={linkNotificationParentName}
                        ownEmailOptionLabel={`Use ${linkSelected.firstName}'s own email`}
                      />
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
                      <div className="space-y-2 rounded-md border border-border p-3">
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
                      <p className="text-sm text-muted-foreground">
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
            aria-describedby={submitBlockMessageId}
            disabled={
              saving ||
              // #2282: both tabs, not one — the create and link paths hit
              // different endpoints and would otherwise dead-end identically.
              Boolean(blockReason) ||
              // #2282 review: and the same is true of the OTHER dead end this
              // change creates. A parent with no adult the club can email is
              // refused by the create route every time and by the link route
              // whenever the admin routes notifications through somebody, so
              // each tab refuses exactly when its own endpoint would.
              (mode === "create"
                ? createBlockedByNoEmailSource
                : linkBlockedByNoEmailSource) ||
              (mode === "link" && !linkSelected)
            }
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
