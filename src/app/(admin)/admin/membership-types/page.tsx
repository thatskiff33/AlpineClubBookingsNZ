"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Archive,
  ArrowDown,
  ArrowUp,
  Eye,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirm } from "@/components/confirm-dialog";
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
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { useScrollToFeedback } from "@/hooks/use-scroll-to-feedback";
import { getSeasonYear } from "@/lib/utils";

type BookingBehavior = "MEMBER_RATE" | "NON_MEMBER_RATE" | "BLOCK_BOOKING";
type SubscriptionBehavior = "REQUIRED" | "NOT_REQUIRED";
type AgeTier = string;
type XeroContactGroupRuleMode = "MANAGED" | "ACCEPTED";

interface MembershipType {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isActive: boolean;
  isBuiltIn: boolean;
  bookingBehavior: BookingBehavior;
  subscriptionBehavior: SubscriptionBehavior;
  sortOrder: number;
  assignmentCount: number;
  allowedAgeTiers: AgeTier[];
  xeroContactGroupRules: Array<{
    id: string;
    ageTier: AgeTier | null;
    mode: XeroContactGroupRuleMode;
    groupId: string;
    groupName: string | null;
    isActive: boolean;
    sortOrder: number;
  }>;
}

interface XeroContactGroup {
  id: string;
  name: string;
  contactCount: number;
}

interface MembershipTypesResponse {
  membershipTypes: MembershipType[];
}

interface RollForwardException {
  code: "missing_prior_assignment" | "inactive_membership_type";
  memberId: string;
  memberName: string;
  memberEmail: string;
  membershipTypeName?: string;
}

interface RollForwardResponse {
  fromSeasonYear: number;
  toSeasonYear: number;
  dryRun: boolean;
  sourceAssignmentCount: number;
  wouldCopyCount: number;
  copiedCount: number;
  skippedExistingCount: number;
  exceptionCount: number;
  exceptions: RollForwardException[];
}

interface DraftMembershipType {
  name: string;
  description: string;
  isActive: boolean;
  bookingBehavior: BookingBehavior;
  subscriptionBehavior: SubscriptionBehavior;
  allowedAgeTiers: AgeTier[];
  xeroContactGroupRules: DraftXeroContactGroupRule[];
}

interface DraftXeroContactGroupRule {
  draftId: string;
  ageTier: AgeTier | null;
  mode: XeroContactGroupRuleMode;
  groupId: string;
  groupName: string;
  isActive: boolean;
  sortOrder: number;
}

type EditorTarget =
  | { mode: "new" }
  | { mode: "edit"; membershipTypeId: string };

const bookingBehaviorLabels: Record<BookingBehavior, string> = {
  MEMBER_RATE: "Member rate",
  NON_MEMBER_RATE: "Non-member rate",
  BLOCK_BOOKING: "Block booking",
};

const subscriptionBehaviorLabels: Record<SubscriptionBehavior, string> = {
  REQUIRED: "Subscription required",
  NOT_REQUIRED: "Subscription not required",
};

const xeroRuleModeLabels: Record<XeroContactGroupRuleMode, string> = {
  MANAGED: "Managed - sync adds members to this group",
  ACCEPTED: "Accepted - allowed, but not synced",
};

const xeroRuleModeHelper =
  "Managed rules add matching members during Xero sync. Accepted rules only allow an existing group; each age scope can have one Managed rule.";

const knownAgeTierOrder = ["INFANT", "CHILD", "YOUTH", "ADULT"];
const allAgeTierValue = "__all__";
const noXeroGroupValue = "__none__";

type XeroContactGroupRule = MembershipType["xeroContactGroupRules"][number];

function normalizedXeroRuleKey(rule: XeroContactGroupRule) {
  return `${rule.mode}:${rule.ageTier ?? "ALL"}:${rule.groupId}:${
    rule.isActive
  }`;
}

// Compares the meaningful Xero-rule surface (mode, age scope, group, active) of
// two types so the merge dialog can warn when reassigned members would land on a
// type with different Xero contact-group behavior.
function xeroRulesDiffer(
  left: readonly XeroContactGroupRule[],
  right: readonly XeroContactGroupRule[],
) {
  const leftKeys = new Set(left.map(normalizedXeroRuleKey));
  const rightKeys = new Set(right.map(normalizedXeroRuleKey));
  if (leftKeys.size !== rightKeys.size) return true;
  for (const key of leftKeys) {
    if (!rightKeys.has(key)) return true;
  }
  return false;
}

function formatAgeTierLabel(ageTier: AgeTier) {
  return ageTier
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function sortAgeTiers(ageTiers: readonly AgeTier[]) {
  const knownOrder = new Map(
    knownAgeTierOrder.map((ageTier, index) => [ageTier, index]),
  );
  return [...new Set(ageTiers)].sort((left, right) => {
    const leftOrder = knownOrder.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = knownOrder.get(right) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.localeCompare(right);
  });
}

function createEmptyDraft(ageTiers: readonly AgeTier[]): DraftMembershipType {
  return {
    name: "",
    description: "",
    isActive: true,
    bookingBehavior: "MEMBER_RATE",
    subscriptionBehavior: "REQUIRED",
    allowedAgeTiers: sortAgeTiers(ageTiers),
    xeroContactGroupRules: [],
  };
}

function nextDraftRuleId() {
  return `draft-rule-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

function draftFromType(type: MembershipType): DraftMembershipType {
  return {
    name: type.name,
    description: type.description ?? "",
    isActive: type.isActive,
    bookingBehavior: type.bookingBehavior,
    subscriptionBehavior: type.subscriptionBehavior,
    allowedAgeTiers: [...type.allowedAgeTiers],
    xeroContactGroupRules: type.xeroContactGroupRules.map((rule) => ({
      draftId: rule.id,
      ageTier: rule.ageTier,
      mode: rule.mode,
      groupId: rule.groupId,
      groupName: rule.groupName ?? "",
      isActive: rule.isActive,
      sortOrder: rule.sortOrder,
    })),
  };
}

function comparableDraft(
  draft: DraftMembershipType,
  availableAgeTiers: readonly AgeTier[],
) {
  return {
    ...draft,
    name: draft.name.trim(),
    description: draft.description.trim(),
    allowedAgeTiers: sortAgeTiers(availableAgeTiers).filter((ageTier) =>
      draft.allowedAgeTiers.includes(ageTier),
    ),
    xeroContactGroupRules: draft.xeroContactGroupRules.map((rule, index) => ({
      ageTier: rule.ageTier,
      mode: rule.mode,
      groupId: rule.groupId.trim(),
      groupName: rule.groupName.trim(),
      isActive: rule.isActive,
      sortOrder: rule.sortOrder ?? index,
    })),
  };
}

function isDirty(
  type: MembershipType,
  draft: DraftMembershipType,
  availableAgeTiers: readonly AgeTier[],
) {
  return (
    JSON.stringify(comparableDraft(draftFromType(type), availableAgeTiers)) !==
    JSON.stringify(comparableDraft(draft, availableAgeTiers))
  );
}

function isNewDirty(draft: DraftMembershipType) {
  return (
    draft.name.trim().length > 0 ||
    draft.description.trim().length > 0 ||
    draft.xeroContactGroupRules.length > 0
  );
}

function validateDraft(draft: DraftMembershipType): string | null {
  if (draft.name.trim().length === 0) {
    return "Enter a membership type name.";
  }
  if (draft.allowedAgeTiers.length === 0) {
    return "Select at least one allowed age tier.";
  }
  if (
    draft.xeroContactGroupRules.some((rule) => rule.groupId.trim().length === 0)
  ) {
    return "Every Xero group rule needs a group.";
  }
  return null;
}

function draftPayload(
  draft: DraftMembershipType,
  availableAgeTiers: readonly AgeTier[],
) {
  return {
    name: draft.name,
    description: draft.description,
    isActive: draft.isActive,
    bookingBehavior: draft.bookingBehavior,
    subscriptionBehavior: draft.subscriptionBehavior,
    allowedAgeTiers: sortAgeTiers(availableAgeTiers).filter((ageTier) =>
      draft.allowedAgeTiers.includes(ageTier),
    ),
    xeroContactGroupRules: draft.xeroContactGroupRules.map((rule, index) => ({
      ageTier: rule.ageTier,
      mode: rule.mode,
      groupId: rule.groupId,
      groupName: rule.groupName || null,
      isActive: rule.isActive,
      sortOrder: index,
    })),
  };
}

function formatSeasonLabel(seasonYear: number) {
  return `${seasonYear}/${seasonYear + 1}`;
}

function rollForwardExceptionLabel(exception: RollForwardException) {
  if (exception.code === "inactive_membership_type") {
    return `Inactive type${
      exception.membershipTypeName ? `: ${exception.membershipTypeName}` : ""
    }`;
  }
  return "Missing prior assignment";
}

function collectAvailableAgeTiers(types: readonly MembershipType[]) {
  const fromTypes = types.flatMap((type) => [
    ...type.allowedAgeTiers,
    ...type.xeroContactGroupRules
      .map((rule) => rule.ageTier)
      .filter((ageTier): ageTier is AgeTier => Boolean(ageTier)),
  ]);
  return sortAgeTiers(fromTypes.length > 0 ? fromTypes : knownAgeTierOrder);
}

function replaceOrAppendDraft(
  drafts: Record<string, DraftMembershipType>,
  type: MembershipType,
) {
  return {
    ...drafts,
    [type.id]: draftFromType(type),
  };
}

function mergeDraftsAfterMembershipTypeRefresh(
  currentDrafts: Record<string, DraftMembershipType>,
  previousTypes: readonly MembershipType[],
  nextTypes: readonly MembershipType[],
  availableAgeTiers: readonly AgeTier[],
) {
  const previousTypeById = new Map(previousTypes.map((type) => [type.id, type]));
  return Object.fromEntries(
    nextTypes.map((type) => {
      const currentDraft = currentDrafts[type.id];
      const previousType = previousTypeById.get(type.id);
      if (
        currentDraft &&
        previousType &&
        isDirty(previousType, currentDraft, availableAgeTiers)
      ) {
        return [type.id, currentDraft];
      }
      return [type.id, draftFromType(type)];
    }),
  );
}

interface MembershipTypeEditorDialogProps {
  target: EditorTarget | null;
  membershipType: MembershipType | null;
  draft: DraftMembershipType;
  availableAgeTiers: AgeTier[];
  xeroGroups: XeroContactGroup[];
  loadingXeroGroups: boolean;
  refreshingXeroGroups: boolean;
  saving: boolean;
  onDraftChange: (patch: Partial<DraftMembershipType>) => void;
  onRuleChange: (
    draftRuleId: string,
    patch: Partial<DraftXeroContactGroupRule>,
  ) => void;
  onAddRule: () => void;
  onRemoveRule: (draftRuleId: string) => void;
  onRefreshXeroGroups: () => void;
  onSave: () => void;
  onCancel: () => void;
  onSetActive: (isActive: boolean) => void;
}

function MembershipTypeEditorDialog({
  target,
  membershipType,
  draft,
  availableAgeTiers,
  xeroGroups,
  loadingXeroGroups,
  refreshingXeroGroups,
  saving,
  onDraftChange,
  onRuleChange,
  onAddRule,
  onRemoveRule,
  onRefreshXeroGroups,
  onSave,
  onCancel,
  onSetActive,
}: MembershipTypeEditorDialogProps) {
  const { confirm, confirmDialog } = useConfirm();
  const validationError = validateDraft(draft);
  const dirty =
    target?.mode === "edit" && membershipType
      ? isDirty(membershipType, draft, availableAgeTiers)
      : isNewDirty(draft);
  const isOpen = target !== null;
  const title =
    target?.mode === "new"
      ? "New membership type"
      : `Edit ${membershipType?.name ?? "membership type"}`;

  async function requestDismiss() {
    if (!dirty) {
      onCancel();
      return;
    }

    const discard = await confirm({
      title: "Discard unsaved changes?",
      description: "Your membership type changes have not been saved.",
      confirmLabel: "Discard changes",
      cancelLabel: "Keep editing",
      destructive: true,
    });
    if (discard) {
      onCancel();
    }
  }

  function toggleAgeTier(ageTier: AgeTier, checked: boolean) {
    onDraftChange({
      allowedAgeTiers: checked
        ? sortAgeTiers([...draft.allowedAgeTiers, ageTier])
        : draft.allowedAgeTiers.filter((tier) => tier !== ageTier),
    });
  }

  return (
    <>
      <Dialog
        open={isOpen}
        onOpenChange={(open) => {
          if (!open) {
            void requestDismiss();
          }
        }}
      >
        <DialogContent
          className="max-h-[92vh] overflow-y-auto sm:max-w-5xl"
          showCloseButton={false}
          onEscapeKeyDown={(event) => {
            if (dirty) {
              event.preventDefault();
              void requestDismiss();
            }
          }}
          onInteractOutside={(event) => {
            event.preventDefault();
          }}
        >
          <DialogHeader>
            <div className="flex flex-wrap items-center gap-2 pr-8">
              <DialogTitle>{title}</DialogTitle>
              {dirty && (
                <Badge variant="secondary" className="text-xs">
                  Unsaved changes
                </Badge>
              )}
            </div>
            <DialogDescription>
              Configure identity, booking policy, allowed tiers, and Xero group
              rules for this seasonal membership type.
            </DialogDescription>
          </DialogHeader>

        {validationError && dirty && (
          <div
            role="alert"
            className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          >
            {validationError}
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.75fr)]">
          <div className="space-y-6">
            <section className="space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  Identity
                </h3>
                <p className="mt-1 text-sm text-slate-500">
                  Display fields shown anywhere admins assign seasonal
                  membership policy.
                </p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="membership-type-editor-name">Name</Label>
                  <Input
                    id="membership-type-editor-name"
                    value={draft.name}
                    onChange={(event) =>
                      onDraftChange({ name: event.target.value })
                    }
                    maxLength={120}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Status</Label>
                  <div className="flex h-10 items-center gap-2 rounded-md border border-slate-200 px-3">
                    <Checkbox
                      id="membership-type-editor-active"
                      checked={draft.isActive}
                      onCheckedChange={(checked) =>
                        onDraftChange({ isActive: checked === true })
                      }
                    />
                    <Label htmlFor="membership-type-editor-active">
                      Active and assignable
                    </Label>
                  </div>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="membership-type-editor-description">
                  Description
                </Label>
                <Textarea
                  id="membership-type-editor-description"
                  value={draft.description}
                  onChange={(event) =>
                    onDraftChange({ description: event.target.value })
                  }
                  maxLength={1000}
                  rows={4}
                />
              </div>
            </section>

            <Separator />

            <section className="space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  Booking and subscription behavior
                </h3>
                <p className="mt-1 text-sm text-slate-500">
                  These settings drive future booking policy and effective
                  subscription status without changing access roles.
                </p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Booking behavior</Label>
                  <Select
                    value={draft.bookingBehavior}
                    onValueChange={(value) =>
                      onDraftChange({
                        bookingBehavior: value as BookingBehavior,
                      })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(bookingBehaviorLabels).map(
                        ([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Subscription behavior</Label>
                  <Select
                    value={draft.subscriptionBehavior}
                    onValueChange={(value) =>
                      onDraftChange({
                        subscriptionBehavior: value as SubscriptionBehavior,
                      })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(subscriptionBehaviorLabels).map(
                        ([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </section>

            <Separator />

            <section className="space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  Allowed age tiers
                </h3>
                <p className="mt-1 text-sm text-slate-500">
                  Select every age tier this membership type can be assigned to.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {availableAgeTiers.map((ageTier) => {
                  const inputId = `membership-type-editor-age-${ageTier}`;
                  return (
                    <label
                      key={ageTier}
                      htmlFor={inputId}
                      className="inline-flex min-h-10 items-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm"
                    >
                      <Checkbox
                        id={inputId}
                        checked={draft.allowedAgeTiers.includes(ageTier)}
                        onCheckedChange={(checked) =>
                          toggleAgeTier(ageTier, checked === true)
                        }
                      />
                      {formatAgeTierLabel(ageTier)}
                    </label>
                  );
                })}
              </div>
            </section>
          </div>

          <aside className="space-y-4 rounded-md border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  Xero rules
                </h3>
                <p className="mt-1 text-sm text-slate-500">
                  Membership Type Xero group rules are separate from age-tier
                  Xero groups.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={onRefreshXeroGroups}
                disabled={refreshingXeroGroups}
                aria-label="Refresh Xero groups"
              >
                <RefreshCw
                  className={`h-4 w-4 ${
                    refreshingXeroGroups ? "animate-spin" : ""
                  }`}
                />
              </Button>
            </div>

            <div className="space-y-3">
              {draft.xeroContactGroupRules.length === 0 ? (
                <div className="rounded-md border border-dashed border-slate-300 bg-white px-3 py-4 text-sm text-slate-500">
                  No membership-type Xero rules.
                </div>
              ) : (
                draft.xeroContactGroupRules.map((rule, index) => {
                  const selectedGroup = xeroGroups.find(
                    (group) => group.id === rule.groupId,
                  );
                  const groupSelectId = `membership-type-editor-xero-group-${rule.draftId}`;
                  const modeSelectId = `membership-type-editor-xero-mode-${rule.draftId}`;
                  const modeHelpId = `membership-type-editor-xero-mode-help-${rule.draftId}`;
                  const ageSelectId = `membership-type-editor-xero-age-${rule.draftId}`;
                  const activeInputId = `membership-type-editor-xero-active-${rule.draftId}`;

                  return (
                    <div
                      key={rule.draftId}
                      className="space-y-3 rounded-md border border-slate-200 bg-white p-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="text-sm font-medium text-slate-900">
                          Rule {index + 1}
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          onClick={() => onRemoveRule(rule.draftId)}
                          aria-label="Remove Xero group rule"
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
                        <div className="space-y-1.5">
                          <Label htmlFor={modeSelectId}>Mode</Label>
                          <Select
                            value={rule.mode}
                            onValueChange={(value) =>
                              onRuleChange(rule.draftId, {
                                mode: value as XeroContactGroupRuleMode,
                              })
                            }
                          >
                            <SelectTrigger
                              id={modeSelectId}
                              aria-describedby={modeHelpId}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {Object.entries(xeroRuleModeLabels).map(
                                ([value, label]) => (
                                  <SelectItem key={value} value={value}>
                                    {label}
                                  </SelectItem>
                                ),
                              )}
                            </SelectContent>
                          </Select>
                          <p id={modeHelpId} className="text-xs text-slate-500">
                            {xeroRuleModeHelper}
                          </p>
                        </div>

                        <div className="space-y-1.5">
                          <Label htmlFor={ageSelectId}>Age scope</Label>
                          <Select
                            value={rule.ageTier ?? allAgeTierValue}
                            onValueChange={(value) =>
                              onRuleChange(rule.draftId, {
                                ageTier:
                                  value === allAgeTierValue ? null : value,
                              })
                            }
                          >
                            <SelectTrigger id={ageSelectId}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={allAgeTierValue}>
                                All ages
                              </SelectItem>
                              {availableAgeTiers.map((ageTier) => (
                                <SelectItem key={ageTier} value={ageTier}>
                                  {formatAgeTierLabel(ageTier)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>

                      <div className="space-y-1.5">
                        <Label htmlFor={groupSelectId}>Group</Label>
                        <Select
                          value={rule.groupId || noXeroGroupValue}
                          onValueChange={(value) => {
                            if (value === noXeroGroupValue) {
                              onRuleChange(rule.draftId, {
                                groupId: "",
                                groupName: "",
                              });
                              return;
                            }
                            const group = xeroGroups.find(
                              (candidate) => candidate.id === value,
                            );
                            onRuleChange(rule.draftId, {
                              groupId: value,
                              groupName: group?.name ?? rule.groupName,
                            });
                          }}
                          disabled={loadingXeroGroups}
                        >
                          <SelectTrigger id={groupSelectId}>
                            <SelectValue placeholder="Select group" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={noXeroGroupValue}>
                              Select group
                            </SelectItem>
                            {rule.groupId && !selectedGroup ? (
                              <SelectItem value={rule.groupId}>
                                {rule.groupName || rule.groupId}
                              </SelectItem>
                            ) : null}
                            {xeroGroups.map((group) => (
                              <SelectItem key={group.id} value={group.id}>
                                {group.name} ({group.contactCount})
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="flex items-center gap-2">
                        <Checkbox
                          id={activeInputId}
                          checked={rule.isActive}
                          onCheckedChange={(checked) =>
                            onRuleChange(rule.draftId, {
                              isActive: checked === true,
                            })
                          }
                        />
                        <Label htmlFor={activeInputId}>Rule active</Label>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={onAddRule}
            >
              <Plus className="mr-2 h-4 w-4" />
              Add Xero rule
            </Button>
          </aside>
        </div>

          <DialogFooter className="gap-2 sm:justify-between sm:space-x-0">
            <div>
              {target?.mode === "edit" && membershipType ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onSetActive(!membershipType.isActive)}
                  disabled={saving}
                >
                  {membershipType.isActive ? (
                    <Archive className="mr-2 h-4 w-4" />
                  ) : (
                    <RotateCcw className="mr-2 h-4 w-4" />
                  )}
                  {membershipType.isActive ? "Archive" : "Reactivate"}
                </Button>
              ) : null}
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="outline" onClick={onCancel}>
                Cancel
              </Button>
              <Button
                type="button"
                onClick={onSave}
                disabled={saving || Boolean(validationError) || !dirty}
              >
                {saving ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : target?.mode === "new" ? (
                  <Plus className="mr-2 h-4 w-4" />
                ) : (
                  <Save className="mr-2 h-4 w-4" />
                )}
                {target?.mode === "new" ? "Create type" : "Save changes"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </>
  );
}

interface MembershipTypeMergeDialogProps {
  source: MembershipType | null;
  membershipTypes: MembershipType[];
  targetId: string;
  merging: boolean;
  onTargetChange: (targetId: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

function MembershipTypeMergeDialog({
  source,
  membershipTypes,
  targetId,
  merging,
  onTargetChange,
  onCancel,
  onConfirm,
}: MembershipTypeMergeDialogProps) {
  const isOpen = source !== null;
  // Only active, non-archived types other than the source can receive
  // assignments (mirrors the server merge guard).
  const targetOptions = source
    ? membershipTypes.filter(
        (type) => type.isActive && type.id !== source.id,
      )
    : [];
  const target = targetOptions.find((type) => type.id === targetId) ?? null;
  const assignmentCount = source?.assignmentCount ?? 0;
  const xeroWarning =
    source && target
      ? xeroRulesDiffer(
          source.xeroContactGroupRules,
          target.xeroContactGroupRules,
        )
      : false;

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open && !merging) onCancel();
      }}
    >
      <DialogContent className="max-w-lg" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Delete {source?.name ?? "membership type"}</DialogTitle>
          <DialogDescription>
            {source?.name ?? "This type"} still has {assignmentCount} seasonal
            assignment{assignmentCount === 1 ? "" : "s"}. Move{" "}
            {assignmentCount === 1 ? "it" : "them"} to another type, then delete
            this one. This cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="membership-type-merge-target">Move assignments to</Label>
            <Select
              value={targetId || ""}
              onValueChange={onTargetChange}
              disabled={merging || targetOptions.length === 0}
            >
              <SelectTrigger id="membership-type-merge-target">
                <SelectValue placeholder="Select a target type" />
              </SelectTrigger>
              <SelectContent>
                {targetOptions.map((type) => (
                  <SelectItem key={type.id} value={type.id}>
                    {type.name}
                    {type.isBuiltIn ? " (Built-in)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {targetOptions.length === 0 && (
              <p className="text-sm text-amber-800">
                No active target type is available. Reactivate or create a type
                to merge into.
              </p>
            )}
          </div>

          {target && (
            <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
              Move {assignmentCount} assignment
              {assignmentCount === 1 ? "" : "s"} from{" "}
              <span className="font-medium">{source?.name}</span> to{" "}
              <span className="font-medium">{target.name}</span>, then delete{" "}
              <span className="font-medium">{source?.name}</span>.
            </div>
          )}

          {xeroWarning && (
            <div
              role="alert"
              className="flex gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {source?.name} and {target?.name} have different Xero
                contact-group rules. Reassigned members keep their Xero group
                membership until the next Xero reconciliation; review the target
                type&apos;s Xero rules before confirming.
              </span>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:space-x-0">
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={merging}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={onConfirm}
            disabled={merging || !target}
          >
            {merging ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="mr-2 h-4 w-4" />
            )}
            Merge and delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface MembershipTypeListProps {
  membershipTypes: MembershipType[];
  drafts: Record<string, DraftMembershipType>;
  availableAgeTiers: AgeTier[];
  savingId: string | null;
  deletingId: string | null;
  reordering: boolean;
  onEdit: (type: MembershipType) => void;
  onMove: (index: number, direction: -1 | 1) => void;
  onSetActive: (type: MembershipType, isActive: boolean) => void;
  onDelete: (type: MembershipType) => void;
}

function MembershipTypeList({
  membershipTypes,
  drafts,
  availableAgeTiers,
  savingId,
  deletingId,
  reordering,
  onEdit,
  onMove,
  onSetActive,
  onDelete,
}: MembershipTypeListProps) {
  if (membershipTypes.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-500">
        No membership types have been configured yet.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {membershipTypes.map((type, index) => {
        const draft = drafts[type.id] ?? draftFromType(type);
        const dirty = isDirty(type, draft, availableAgeTiers);

        return (
          <article
            key={type.id}
            className="rounded-md border border-slate-200 bg-white p-4 shadow-sm"
          >
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1.7fr)_120px_112px] xl:items-center">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="truncate text-base font-semibold text-slate-900">
                    {type.name}
                  </h3>
                  <Badge variant={type.isActive ? "default" : "secondary"}>
                    {type.isActive ? "Active" : "Archived"}
                  </Badge>
                  <Badge variant={type.isBuiltIn ? "outline" : "secondary"}>
                    {type.isBuiltIn ? "Built-in" : "Custom"}
                  </Badge>
                  {dirty && <Badge variant="secondary">Unsaved</Badge>}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <span>{type.key}</span>
                  <span aria-hidden="true">/</span>
                  <span>
                    {type.assignmentCount} assignment
                    {type.assignmentCount === 1 ? "" : "s"}
                  </span>
                </div>
                {type.description ? (
                  <p className="mt-2 line-clamp-2 text-sm text-slate-600">
                    {type.description}
                  </p>
                ) : null}
              </div>

              <div className="space-y-2">
                <div className="flex flex-wrap gap-2">
                  <Badge variant="outline">
                    {bookingBehaviorLabels[type.bookingBehavior]}
                  </Badge>
                  <Badge variant="outline">
                    {subscriptionBehaviorLabels[type.subscriptionBehavior]}
                  </Badge>
                  {type.xeroContactGroupRules.length > 0 ? (
                    <Badge variant="secondary">
                      {type.xeroContactGroupRules.length} Xero rule
                      {type.xeroContactGroupRules.length === 1 ? "" : "s"}
                    </Badge>
                  ) : (
                    <Badge variant="outline">No Xero rules</Badge>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {sortAgeTiers(type.allowedAgeTiers).map((ageTier) => (
                    <span
                      key={ageTier}
                      className="rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700"
                    >
                      {formatAgeTierLabel(ageTier)}
                    </span>
                  ))}
                </div>
              </div>

              <div className="flex gap-1 xl:justify-center">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => onMove(index, -1)}
                  disabled={index === 0 || reordering}
                  aria-label={`Move ${type.name} up`}
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => onMove(index, 1)}
                  disabled={index === membershipTypes.length - 1 || reordering}
                  aria-label={`Move ${type.name} down`}
                >
                  <ArrowDown className="h-4 w-4" />
                </Button>
              </div>

              <div className="flex flex-wrap gap-2 xl:justify-end">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onEdit(type)}
                >
                  <Pencil className="mr-2 h-4 w-4" />
                  Edit
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onSetActive(type, !type.isActive)}
                  disabled={savingId === type.id}
                >
                  {savingId === type.id ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : type.isActive ? (
                    <Archive className="mr-2 h-4 w-4" />
                  ) : (
                    <RotateCcw className="mr-2 h-4 w-4" />
                  )}
                  {type.isActive ? "Archive" : "Reactivate"}
                </Button>
                {!type.isBuiltIn && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => onDelete(type)}
                    disabled={deletingId === type.id}
                    aria-label={`Delete ${type.name}`}
                  >
                    {deletingId === type.id ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="mr-2 h-4 w-4" />
                    )}
                    Delete
                  </Button>
                )}
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}

export default function AdminMembershipTypesPage() {
  const defaultSeasonYear = getSeasonYear(new Date());
  const [membershipTypes, setMembershipTypes] = useState<MembershipType[]>([]);
  const [drafts, setDrafts] = useState<Record<string, DraftMembershipType>>({});
  const [newDraft, setNewDraft] = useState<DraftMembershipType>(() =>
    createEmptyDraft(knownAgeTierOrder),
  );
  const [editorTarget, setEditorTarget] = useState<EditorTarget | null>(null);
  const [xeroGroups, setXeroGroups] = useState<XeroContactGroup[]>([]);
  const [loadingXeroGroups, setLoadingXeroGroups] = useState(true);
  const [refreshingXeroGroups, setRefreshingXeroGroups] = useState(false);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [mergeSource, setMergeSource] = useState<MembershipType | null>(null);
  const [mergeTargetId, setMergeTargetId] = useState("");
  const [merging, setMerging] = useState(false);
  const [creating, setCreating] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [rollForwardFromSeasonYear, setRollForwardFromSeasonYear] =
    useState(defaultSeasonYear);
  const [rollForwardToSeasonYear, setRollForwardToSeasonYear] = useState(
    defaultSeasonYear + 1,
  );
  const [rollForwardMode, setRollForwardMode] = useState<
    "preview" | "run" | null
  >(null);
  const [rollForwardResult, setRollForwardResult] =
    useState<RollForwardResponse | null>(null);
  const [error, setError] = useState("");
  const [savedMessage, setSavedMessage] = useState("");
  const pageRef = useRef<HTMLDivElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const { scrollToError, scrollToTop } = useScrollToFeedback();
  const { confirm, confirmDialog } = useConfirm();

  const sortedTypes = useMemo(
    () =>
      [...membershipTypes].sort((left, right) => {
        if (left.sortOrder !== right.sortOrder) {
          return left.sortOrder - right.sortOrder;
        }
        return left.name.localeCompare(right.name);
      }),
    [membershipTypes],
  );

  const availableAgeTiers = useMemo(
    () => collectAvailableAgeTiers(sortedTypes),
    [sortedTypes],
  );

  const editingType =
    editorTarget?.mode === "edit"
      ? (membershipTypes.find(
          (type) => type.id === editorTarget.membershipTypeId,
        ) ?? null)
      : null;

  const editorDraft =
    editorTarget?.mode === "edit" && editingType
      ? (drafts[editingType.id] ?? draftFromType(editingType))
      : newDraft;

  useEffect(() => {
    setNewDraft((current) => {
      if (isNewDirty(current)) return current;
      return createEmptyDraft(availableAgeTiers);
    });
  }, [availableAgeTiers]);

  async function loadMembershipTypes() {
    setLoading(true);
    setError("");
    setSavedMessage("");

    try {
      const response = await fetch("/api/admin/membership-types", {
        credentials: "same-origin",
      });
      const body = (await response.json()) as
        | MembershipTypesResponse
        | { error?: string };
      if (!response.ok || !("membershipTypes" in body)) {
        throw new Error(
          responseErrorMessage(body, "Failed to load membership types"),
        );
      }
      setMembershipTypes(body.membershipTypes);
      setDrafts(
        Object.fromEntries(
          body.membershipTypes.map((type) => [type.id, draftFromType(type)]),
        ),
      );
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load membership types",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadMembershipTypes();
  }, []);

  useEffect(() => {
    if (error) scrollToError(feedbackRef);
  }, [error, scrollToError]);

  useEffect(() => {
    if (savedMessage) scrollToTop(pageRef);
  }, [savedMessage, scrollToTop]);

  async function loadXeroGroups(refreshFromXero = false) {
    if (refreshFromXero) {
      setRefreshingXeroGroups(true);
    } else {
      setLoadingXeroGroups(true);
    }
    setError("");

    try {
      const response = await fetch(
        `/api/admin/xero/contact-groups${refreshFromXero ? "?refresh=1" : ""}`,
        { credentials: "same-origin" },
      );
      const body = (await response.json().catch(() => null)) as
        | { groups?: XeroContactGroup[]; error?: string }
        | null;
      if (!response.ok) {
        throw new Error(body?.error ?? "Failed to load Xero contact groups");
      }
      setXeroGroups(body?.groups ?? []);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load Xero contact groups",
      );
    } finally {
      setLoadingXeroGroups(false);
      setRefreshingXeroGroups(false);
    }
  }

  useEffect(() => {
    void loadXeroGroups();
  }, []);

  function updateEditorDraft(patch: Partial<DraftMembershipType>) {
    if (editorTarget?.mode === "edit" && editingType) {
      setDrafts((current) => ({
        ...current,
        [editingType.id]: {
          ...(current[editingType.id] ?? draftFromType(editingType)),
          ...patch,
        },
      }));
    } else {
      setNewDraft((current) => ({ ...current, ...patch }));
    }
    setSavedMessage("");
  }

  function updateEditorRule(
    draftRuleId: string,
    patch: Partial<DraftXeroContactGroupRule>,
  ) {
    updateEditorDraft({
      xeroContactGroupRules: editorDraft.xeroContactGroupRules.map((rule) =>
        rule.draftId === draftRuleId ? { ...rule, ...patch } : rule,
      ),
    });
  }

  function addEditorRule() {
    updateEditorDraft({
      xeroContactGroupRules: [
        ...editorDraft.xeroContactGroupRules,
        {
          draftId: nextDraftRuleId(),
          ageTier: null,
          mode: "MANAGED",
          groupId: "",
          groupName: "",
          isActive: true,
          sortOrder: editorDraft.xeroContactGroupRules.length,
        },
      ],
    });
  }

  function removeEditorRule(draftRuleId: string) {
    updateEditorDraft({
      xeroContactGroupRules: editorDraft.xeroContactGroupRules.filter(
        (rule) => rule.draftId !== draftRuleId,
      ),
    });
  }

  function openNewEditor() {
    setNewDraft((current) =>
      isNewDirty(current) ? current : createEmptyDraft(availableAgeTiers),
    );
    setEditorTarget({ mode: "new" });
    setError("");
    setSavedMessage("");
  }

  function openEditEditor(type: MembershipType) {
    setDrafts((current) =>
      current[type.id] ? current : replaceOrAppendDraft(current, type),
    );
    setEditorTarget({ mode: "edit", membershipTypeId: type.id });
    setError("");
    setSavedMessage("");
  }

  function cancelEditor() {
    if (editorTarget?.mode === "edit" && editingType) {
      setDrafts((current) => replaceOrAppendDraft(current, editingType));
    } else {
      setNewDraft(createEmptyDraft(availableAgeTiers));
    }
    setEditorTarget(null);
  }

  async function createMembershipType() {
    setCreating(true);
    setError("");
    setSavedMessage("");

    try {
      const validationError = validateDraft(newDraft);
      if (validationError) {
        throw new Error(validationError);
      }
      const response = await fetch("/api/admin/membership-types", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftPayload(newDraft, availableAgeTiers)),
      });
      const body = (await response.json()) as
        | { membershipType: MembershipType }
        | { error?: string };
      if (!response.ok || !("membershipType" in body)) {
        throw new Error(
          responseErrorMessage(body, "Failed to create membership type"),
        );
      }
      setMembershipTypes((current) => [...current, body.membershipType]);
      setDrafts((current) => replaceOrAppendDraft(current, body.membershipType));
      setNewDraft(createEmptyDraft(availableAgeTiers));
      setEditorTarget({ mode: "edit", membershipTypeId: body.membershipType.id });
      setSavedMessage("Membership type created.");
    } catch (createError) {
      setError(
        createError instanceof Error
          ? createError.message
          : "Failed to create membership type",
      );
    } finally {
      setCreating(false);
    }
  }

  async function saveMembershipType(
    type: MembershipType,
    overrideDraft?: DraftMembershipType,
  ) {
    const draft = overrideDraft ?? drafts[type.id];
    if (!draft) return;

    setSavingId(type.id);
    setError("");
    setSavedMessage("");

    try {
      const validationError = validateDraft(draft);
      if (validationError) {
        throw new Error(validationError);
      }
      const response = await fetch(`/api/admin/membership-types/${type.id}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftPayload(draft, availableAgeTiers)),
      });
      const body = (await response.json()) as
        | { membershipType: MembershipType }
        | { error?: string };
      if (!response.ok || !("membershipType" in body)) {
        throw new Error(
          responseErrorMessage(body, "Failed to save membership type"),
        );
      }
      setMembershipTypes((current) =>
        current.map((item) =>
          item.id === body.membershipType.id ? body.membershipType : item,
        ),
      );
      setDrafts((current) => replaceOrAppendDraft(current, body.membershipType));
      setSavedMessage("Membership type saved.");
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to save membership type",
      );
    } finally {
      setSavingId(null);
    }
  }

  async function setActive(type: MembershipType, isActive: boolean) {
    const draft = {
      ...(drafts[type.id] ?? draftFromType(type)),
      isActive,
    };
    setDrafts((current) => ({
      ...current,
      [type.id]: draft,
    }));
    setSavedMessage("");
    await saveMembershipType(type, draft);
  }

  async function reorder(nextOrder: MembershipType[]) {
    setReordering(true);
    setError("");
    setSavedMessage("");

    try {
      const response = await fetch("/api/admin/membership-types/reorder", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderedIds: nextOrder.map((type) => type.id) }),
      });
      const body = (await response.json()) as
        | MembershipTypesResponse
        | { error?: string };
      if (!response.ok || !("membershipTypes" in body)) {
        throw new Error(
          responseErrorMessage(body, "Failed to reorder membership types"),
        );
      }
      setMembershipTypes(body.membershipTypes);
      setDrafts((current) =>
        mergeDraftsAfterMembershipTypeRefresh(
          current,
          membershipTypes,
          body.membershipTypes,
          availableAgeTiers,
        ),
      );
      setSavedMessage("Membership type order saved.");
    } catch (reorderError) {
      setError(
        reorderError instanceof Error
          ? reorderError.message
          : "Failed to reorder membership types",
      );
    } finally {
      setReordering(false);
    }
  }

  async function deleteMembershipType(type: MembershipType) {
    setDeletingId(type.id);
    setError("");
    setSavedMessage("");

    try {
      const response = await fetch(`/api/admin/membership-types/${type.id}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string }
        | null;
      if (!response.ok || !body?.ok) {
        throw new Error(
          responseErrorMessage(body, "Failed to delete membership type"),
        );
      }
      setMembershipTypes((current) =>
        current.filter((item) => item.id !== type.id),
      );
      setDrafts((current) => {
        const next = { ...current };
        delete next[type.id];
        return next;
      });
      setSavedMessage(`Deleted ${type.name}.`);
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "Failed to delete membership type",
      );
    } finally {
      setDeletingId(null);
    }
  }

  async function requestDelete(type: MembershipType) {
    setError("");
    setSavedMessage("");

    // A custom type with seasonal assignments cannot be deleted outright — route
    // the admin into the merge (reassign-then-delete) flow instead.
    if (type.assignmentCount > 0) {
      setMergeTargetId("");
      setMergeSource(type);
      return;
    }

    const confirmed = await confirm({
      title: `Delete ${type.name}?`,
      description:
        "Permanently deletes this membership type. This cannot be undone.",
      confirmLabel: "Delete type",
      cancelLabel: "Cancel",
      destructive: true,
    });
    if (!confirmed) return;
    await deleteMembershipType(type);
  }

  async function mergeMembershipType() {
    if (!mergeSource || !mergeTargetId) return;

    const source = mergeSource;
    const sourceName = source.name;
    const targetName =
      membershipTypes.find((type) => type.id === mergeTargetId)?.name ?? "type";

    setMerging(true);
    setError("");
    setSavedMessage("");

    try {
      const response = await fetch(
        `/api/admin/membership-types/${source.id}/merge`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetId: mergeTargetId }),
        },
      );
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; reassignedCount?: number; error?: string }
        | null;
      if (!response.ok || !body?.ok) {
        throw new Error(
          responseErrorMessage(body, "Failed to merge membership type"),
        );
      }
      const reassignedCount = body.reassignedCount ?? 0;
      setMergeSource(null);
      setMergeTargetId("");
      // Reload so the deleted source disappears and the target's assignment
      // count reflects the reassignment.
      await loadMembershipTypes();
      setSavedMessage(
        `Moved ${reassignedCount} assignment${
          reassignedCount === 1 ? "" : "s"
        } from ${sourceName} to ${targetName}, then deleted ${sourceName}.`,
      );
    } catch (mergeError) {
      setError(
        mergeError instanceof Error
          ? mergeError.message
          : "Failed to merge membership type",
      );
    } finally {
      setMerging(false);
    }
  }

  function moveType(index: number, direction: -1 | 1) {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= sortedTypes.length) {
      return;
    }

    const next = [...sortedTypes];
    const [item] = next.splice(index, 1);
    next.splice(targetIndex, 0, item);
    void reorder(next);
  }

  async function rollForwardAssignments(dryRun: boolean) {
    setRollForwardMode(dryRun ? "preview" : "run");
    setError("");
    setSavedMessage("");

    try {
      const response = await fetch("/api/admin/membership-types/roll-forward", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromSeasonYear: rollForwardFromSeasonYear,
          toSeasonYear: rollForwardToSeasonYear,
          dryRun,
        }),
      });
      const body = (await response.json()) as
        | RollForwardResponse
        | { error?: string };
      if (!response.ok || !("wouldCopyCount" in body)) {
        throw new Error(
          responseErrorMessage(
            body,
            dryRun
              ? "Failed to preview seasonal assignment roll-forward"
              : "Failed to roll forward seasonal assignments",
          ),
        );
      }
      setRollForwardResult(body);
      if (!dryRun) {
        await loadMembershipTypes();
      }
      setSavedMessage(
        dryRun
          ? "Roll-forward preview ready."
          : `Rolled forward ${body.copiedCount} seasonal assignment${
              body.copiedCount === 1 ? "" : "s"
            }.`,
      );
    } catch (rollForwardError) {
      setError(
        rollForwardError instanceof Error
          ? rollForwardError.message
          : dryRun
            ? "Failed to preview seasonal assignment roll-forward"
            : "Failed to roll forward seasonal assignments",
      );
    } finally {
      setRollForwardMode(null);
    }
  }

  if (loading && membershipTypes.length === 0) {
    return (
      <div className="flex min-h-[320px] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-slate-500" />
      </div>
    );
  }

  const editorSaving =
    editorTarget?.mode === "new"
      ? creating
      : Boolean(editingType && savingId === editingType.id);

  return (
    <div ref={pageRef} className="space-y-8">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            Membership types
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-500">
            Manage seasonal membership policy labels and future booking and
            subscription behavior. Access roles stay separate.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => void loadMembershipTypes()}
            disabled={loading || creating || reordering || savingId !== null}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
          <Button type="button" onClick={openNewEditor}>
            <Plus className="mr-2 h-4 w-4" />
            New membership type
          </Button>
        </div>
      </div>

      {(error || savedMessage) && (
        <div
          ref={feedbackRef}
          role={error ? "alert" : "status"}
          tabIndex={error ? -1 : undefined}
          className={
            error
              ? "scroll-mt-20 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 focus:outline-none"
              : "rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800"
          }
        >
          {error || savedMessage}
        </div>
      )}

      <section className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Type list
            </h2>
            <p className="mt-1 max-w-3xl text-sm text-slate-500">
              Scan policy behavior, allowed tiers, assignment count, and order.
              Open a type to edit details or Xero rules.
            </p>
          </div>
          <div className="text-sm text-slate-500">
            {sortedTypes.length} configured type
            {sortedTypes.length === 1 ? "" : "s"}
          </div>
        </div>

        <MembershipTypeList
          membershipTypes={sortedTypes}
          drafts={drafts}
          availableAgeTiers={availableAgeTiers}
          savingId={savingId}
          deletingId={deletingId}
          reordering={reordering}
          onEdit={openEditEditor}
          onMove={moveType}
          onSetActive={(type, isActive) => void setActive(type, isActive)}
          onDelete={(type) => void requestDelete(type)}
        />
      </section>

      <section className="rounded-md border border-slate-200 bg-white p-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Roll forward seasonal assignments
            </h2>
            <p className="mt-1 max-w-3xl text-sm text-slate-500">
              Copy missing member membership-type assignments from one season to
              the next. Existing target-season assignments are kept.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-[150px_150px_auto_auto] sm:items-end">
            <div className="space-y-2">
              <Label htmlFor="roll-forward-from-season">From season</Label>
              <Input
                id="roll-forward-from-season"
                type="number"
                min={2020}
                max={2040}
                value={rollForwardFromSeasonYear}
                onChange={(event) =>
                  setRollForwardFromSeasonYear(
                    Number.parseInt(event.target.value, 10) || 2020,
                  )
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="roll-forward-to-season">To season</Label>
              <Input
                id="roll-forward-to-season"
                type="number"
                min={2020}
                max={2040}
                value={rollForwardToSeasonYear}
                onChange={(event) =>
                  setRollForwardToSeasonYear(
                    Number.parseInt(event.target.value, 10) || 2020,
                  )
                }
              />
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => void rollForwardAssignments(true)}
              disabled={
                rollForwardMode !== null ||
                rollForwardFromSeasonYear === rollForwardToSeasonYear
              }
            >
              {rollForwardMode === "preview" ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Eye className="mr-2 h-4 w-4" />
              )}
              Preview
            </Button>
            <Button
              type="button"
              onClick={() => void rollForwardAssignments(false)}
              disabled={
                rollForwardMode !== null ||
                rollForwardFromSeasonYear === rollForwardToSeasonYear
              }
            >
              {rollForwardMode === "run" ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RotateCcw className="mr-2 h-4 w-4" />
              )}
              Run
            </Button>
          </div>
        </div>

        {rollForwardResult && (
          <div className="mt-4 space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3">
            <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-5">
              <div>
                <div className="text-xs font-medium uppercase text-slate-500">
                  Seasons
                </div>
                <div className="mt-1 text-slate-900">
                  {formatSeasonLabel(rollForwardResult.fromSeasonYear)} to{" "}
                  {formatSeasonLabel(rollForwardResult.toSeasonYear)}
                </div>
              </div>
              <div>
                <div className="text-xs font-medium uppercase text-slate-500">
                  Source
                </div>
                <div className="mt-1 text-slate-900">
                  {rollForwardResult.sourceAssignmentCount}
                </div>
              </div>
              <div>
                <div className="text-xs font-medium uppercase text-slate-500">
                  Would copy
                </div>
                <div className="mt-1 text-slate-900">
                  {rollForwardResult.wouldCopyCount}
                </div>
              </div>
              <div>
                <div className="text-xs font-medium uppercase text-slate-500">
                  Copied
                </div>
                <div className="mt-1 text-slate-900">
                  {rollForwardResult.copiedCount}
                </div>
              </div>
              <div>
                <div className="text-xs font-medium uppercase text-slate-500">
                  Existing target
                </div>
                <div className="mt-1 text-slate-900">
                  {rollForwardResult.skippedExistingCount}
                </div>
              </div>
            </div>

            {rollForwardResult.exceptionCount > 0 && (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
                <div className="text-sm font-medium text-amber-900">
                  Exceptions ({rollForwardResult.exceptionCount})
                </div>
                <div className="mt-2 space-y-1">
                  {rollForwardResult.exceptions
                    .slice(0, 10)
                    .map((exception) => (
                      <div
                        key={`${exception.code}-${exception.memberId}`}
                        className="text-xs text-amber-900"
                      >
                        {exception.memberName} ({exception.memberEmail}) -{" "}
                        {rollForwardExceptionLabel(exception)}
                      </div>
                    ))}
                </div>
                {rollForwardResult.exceptionCount > 10 && (
                  <p className="mt-2 text-xs text-amber-800">
                    {rollForwardResult.exceptionCount - 10} more not shown.
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      <MembershipTypeEditorDialog
        target={editorTarget}
        membershipType={editingType}
        draft={editorDraft}
        availableAgeTiers={availableAgeTiers}
        xeroGroups={xeroGroups}
        loadingXeroGroups={loadingXeroGroups}
        refreshingXeroGroups={refreshingXeroGroups}
        saving={editorSaving}
        onDraftChange={updateEditorDraft}
        onRuleChange={updateEditorRule}
        onAddRule={addEditorRule}
        onRemoveRule={removeEditorRule}
        onRefreshXeroGroups={() => void loadXeroGroups(true)}
        onSave={() => {
          if (editorTarget?.mode === "new") {
            void createMembershipType();
          } else if (editingType) {
            void saveMembershipType(editingType);
          }
        }}
        onCancel={cancelEditor}
        onSetActive={(isActive) => {
          if (editingType) void setActive(editingType, isActive);
        }}
      />

      <MembershipTypeMergeDialog
        source={mergeSource}
        membershipTypes={sortedTypes}
        targetId={mergeTargetId}
        merging={merging}
        onTargetChange={setMergeTargetId}
        onCancel={() => {
          if (merging) return;
          setMergeSource(null);
          setMergeTargetId("");
        }}
        onConfirm={() => void mergeMembershipType()}
      />

      {confirmDialog}
    </div>
  );
}
