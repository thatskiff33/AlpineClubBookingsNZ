"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
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
} from "lucide-react";
import { BackLink } from "@/components/admin/back-link";
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
import { useClubTime } from "@/components/club-time-provider";
import { clubSeasonYear } from "@/lib/financial-year";
import { seasonSelectLabel } from "@/lib/season-label";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";

type BookingBehavior = "MEMBER_RATE" | "NON_MEMBER_RATE" | "BLOCK_BOOKING";
type SubscriptionBehavior = "REQUIRED" | "NOT_REQUIRED" | "BASED_ON_AGE_TIER";
type AgeTier = string;

interface MembershipType {
  id: string;
  key: string;
  name: string;
  description: string | null;
  publicDescription: string | null;
  publiclyListed: boolean;
  isActive: boolean;
  isBuiltIn: boolean;
  bookingBehavior: BookingBehavior;
  subscriptionBehavior: SubscriptionBehavior;
  sortOrder: number;
  assignmentCount: number;
  allowedAgeTiers: AgeTier[];
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
  publicDescription: string;
  publiclyListed: boolean;
  isActive: boolean;
  bookingBehavior: BookingBehavior;
  subscriptionBehavior: SubscriptionBehavior;
  allowedAgeTiers: AgeTier[];
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
  BASED_ON_AGE_TIER: "Subscription required based on age tier",
};

// Selectable age tiers, in display order. "N/A (no age)" (NOT_APPLICABLE) is the
// explicit age-exempt option for organisation/school types and always sorts last
// (#2069).
const knownAgeTierOrder = ["INFANT", "CHILD", "YOUTH", "ADULT", "NOT_APPLICABLE"];

// The tiers a brand-new membership type pre-checks. N/A is opt-in, so it is never
// part of this default even though it is selectable (#2069).
const defaultNewTypeAgeTiers = ["INFANT", "CHILD", "YOUTH", "ADULT"];

function formatAgeTierLabel(ageTier: AgeTier) {
  if (ageTier === "NOT_APPLICABLE") {
    return "N/A (no age)";
  }
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
    publicDescription: "",
    publiclyListed: false,
    isActive: true,
    bookingBehavior: "MEMBER_RATE",
    subscriptionBehavior: "REQUIRED",
    allowedAgeTiers: sortAgeTiers(ageTiers),
  };
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
    publicDescription: type.publicDescription ?? "",
    publiclyListed: type.publiclyListed,
    isActive: type.isActive,
    bookingBehavior: type.bookingBehavior,
    subscriptionBehavior: type.subscriptionBehavior,
    allowedAgeTiers: [...type.allowedAgeTiers],
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
    publicDescription: draft.publicDescription.trim(),
    allowedAgeTiers: sortAgeTiers(availableAgeTiers).filter((ageTier) =>
      draft.allowedAgeTiers.includes(ageTier),
    ),
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
    draft.publicDescription.trim().length > 0 ||
    draft.publiclyListed
  );
}

function validateDraft(draft: DraftMembershipType): string | null {
  if (draft.name.trim().length === 0) {
    return "Enter a membership type name.";
  }
  if (draft.allowedAgeTiers.length === 0) {
    return "Select at least one allowed age tier.";
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
    publicDescription: draft.publicDescription,
    publiclyListed: draft.publiclyListed,
    isActive: draft.isActive,
    bookingBehavior: draft.bookingBehavior,
    subscriptionBehavior: draft.subscriptionBehavior,
    allowedAgeTiers: sortAgeTiers(availableAgeTiers).filter((ageTier) =>
      draft.allowedAgeTiers.includes(ageTier),
    ),
  };
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
  const fromTypes = types.flatMap((type) => [...type.allowedAgeTiers]);
  // Always offer the full selectable set (including "N/A (no age)") so the
  // dialog can add N/A even when no existing type uses it yet, plus any extra
  // tiers already configured on a type (#2069).
  return sortAgeTiers([...knownAgeTierOrder, ...fromTypes]);
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
  saving: boolean;
  canEdit: boolean | undefined;
  error: string;
  onDraftChange: (patch: Partial<DraftMembershipType>) => void;
  onSave: () => void;
  onCancel: () => void;
  onSetActive: (isActive: boolean) => void;
}

function MembershipTypeEditorDialog({
  target,
  membershipType,
  draft,
  availableAgeTiers,
  saving,
  canEdit,
  error,
  onDraftChange,
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
    // While a save is in flight the editor auto-closes on success; treat
    // dismissal as inert so the X/Escape cannot open a discard-confirm that the
    // save's own close would then orphan (#2045 F2).
    if (saving) {
      return;
    }
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
          if (!open && !saving) {
            void requestDismiss();
          }
        }}
      >
        <DialogContent
          className="max-h-[92vh] overflow-y-auto sm:max-w-5xl"
          showCloseButton={!saving}
          onEscapeKeyDown={(event) => {
            // A save in flight makes Escape inert (mirrors the merge dialog's
            // guard) so it cannot race the auto-close (#2045 F2).
            if (saving) {
              event.preventDefault();
              return;
            }
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
              Configure identity, booking policy, and allowed tiers for this
              seasonal membership type.
            </DialogDescription>
          </DialogHeader>

        {error && (
          <div
            role="alert"
            className="rounded-md border border-danger-6 bg-danger-3 px-3 py-2 text-sm text-danger-11"
          >
            {error}
          </div>
        )}

        {validationError && dirty && (
          <div
            role="alert"
            className="rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-sm text-warning-11"
          >
            {validationError}
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.75fr)]">
          <div className="space-y-6">
            <section className="space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-foreground">
                  Identity
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
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
                    disabled={!canEdit}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Status</Label>
                  <div className="flex h-10 items-center gap-2 rounded-md border border-border px-3">
                    <Checkbox
                      id="membership-type-editor-active"
                      checked={draft.isActive}
                      onCheckedChange={(checked) =>
                        onDraftChange({ isActive: checked === true })
                      }
                      disabled={!canEdit}
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
                  disabled={!canEdit}
                />
              </div>
              <div className="space-y-2 rounded-md border border-border p-4">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="membership-type-editor-publicly-listed"
                    checked={draft.publiclyListed}
                    onCheckedChange={(checked) =>
                      onDraftChange({ publiclyListed: checked === true })
                    }
                    disabled={!canEdit}
                  />
                  <Label htmlFor="membership-type-editor-publicly-listed">
                    List this membership type publicly
                  </Label>
                </div>
                <p className="text-xs text-muted-foreground">
                  Existing and newly created types stay hidden until this is explicitly enabled.
                </p>
                <Label htmlFor="membership-type-editor-public-description">
                  Public description
                </Label>
                <Textarea
                  id="membership-type-editor-public-description"
                  value={draft.publicDescription}
                  onChange={(event) =>
                    onDraftChange({ publicDescription: event.target.value })
                  }
                  maxLength={4000}
                  rows={4}
                  disabled={!canEdit}
                />
              </div>
            </section>

            <Separator />

            <section className="space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-foreground">
                  Booking and subscription behavior
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  These settings drive future booking policy and effective
                  subscription status without changing access roles.
                </p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Booking behavior</Label>
                  <Select
                    value={draft.bookingBehavior}
                    disabled={!canEdit}
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
                    disabled={!canEdit}
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
                  {draft.subscriptionBehavior === "BASED_ON_AGE_TIER" ? (
                    <p className="text-sm text-muted-foreground">
                      Each member&apos;s subscription requirement is taken from
                      their age tier. Set which tiers need a subscription on the{" "}
                      <Link
                        href="/admin/age-tier-settings"
                        className="font-medium text-muted-foreground underline"
                      >
                        age tier settings
                      </Link>{" "}
                      page (typically Youth and Adult require one; Child and
                      Infant do not). A member&apos;s age tier for the whole
                      season is fixed by their age at the start of the club
                      financial year.
                    </p>
                  ) : null}
                </div>
              </div>
            </section>

            <Separator />

            <section className="space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-foreground">
                  Allowed age tiers
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
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
                      className="inline-flex min-h-10 items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"
                    >
                      <Checkbox
                        id={inputId}
                        checked={draft.allowedAgeTiers.includes(ageTier)}
                        onCheckedChange={(checked) =>
                          toggleAgeTier(ageTier, checked === true)
                        }
                        disabled={!canEdit}
                      />
                      {formatAgeTierLabel(ageTier)}
                    </label>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                Ticking only &ldquo;N/A (no age)&rdquo; makes the type
                age-exempt: every member on it becomes N/A instead of an age
                tier (only valid when this type&apos;s subscription behaviour is
                &ldquo;not required&rdquo;). Ticking &ldquo;N/A (no age)&rdquo;
                alongside person tiers lets admins hand-pick N/A for individual
                members while everyone else keeps a real age tier. Leaving
                &ldquo;N/A (no age)&rdquo; unticked means no member on this type
                can be N/A.
              </p>
            </section>
          </div>

        </div>

          <DialogFooter className="gap-2 sm:justify-between sm:space-x-0">
            <div>
              {target?.mode === "edit" && membershipType ? (
                <ViewOnlyActionButton
                  canEdit={canEdit}
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
                </ViewOnlyActionButton>
              ) : null}
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="outline" onClick={onCancel}>
                Cancel
              </Button>
              <ViewOnlyActionButton
                canEdit={canEdit}
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
              </ViewOnlyActionButton>
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
  error: string;
  canEdit: boolean | undefined;
  onTargetChange: (targetId: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

function MembershipTypeMergeDialog({
  source,
  membershipTypes,
  targetId,
  merging,
  error,
  canEdit,
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

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open && !merging) onCancel();
      }}
    >
      <DialogContent className="max-w-lg" showCloseButton={!merging}>
        <DialogHeader>
          <DialogTitle>Delete {source?.name ?? "membership type"}</DialogTitle>
          <DialogDescription>
            {source?.name ?? "This type"} still has {assignmentCount} seasonal
            assignment{assignmentCount === 1 ? "" : "s"}. Move{" "}
            {assignmentCount === 1 ? "it" : "them"} to another type, then delete
            this one. This cannot be undone.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div
            role="alert"
            className="rounded-md border border-danger-6 bg-danger-3 px-3 py-2 text-sm text-danger-11"
          >
            {error}
          </div>
        )}

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="membership-type-merge-target">Move assignments to</Label>
            <Select
              value={targetId || ""}
              onValueChange={onTargetChange}
              disabled={merging || targetOptions.length === 0 || !canEdit}
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
              <p className="text-sm text-warning-11">
                No active target type is available. Reactivate or create a type
                to merge into.
              </p>
            )}
          </div>

          {target && (
            <div className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
              Move {assignmentCount} assignment
              {assignmentCount === 1 ? "" : "s"} from{" "}
              <span className="font-medium">{source?.name}</span> to{" "}
              <span className="font-medium">{target.name}</span>, then delete{" "}
              <span className="font-medium">{source?.name}</span>.
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
          <ViewOnlyActionButton
            canEdit={canEdit}
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
          </ViewOnlyActionButton>
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
  canEdit: boolean | undefined;
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
  canEdit,
  onEdit,
  onMove,
  onSetActive,
  onDelete,
}: MembershipTypeListProps) {
  if (membershipTypes.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
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
            className="rounded-md border border-border bg-card p-4 shadow-sm"
          >
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1.7fr)_120px_112px] xl:items-center">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="truncate text-base font-semibold text-foreground">
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
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>{type.key}</span>
                  <span aria-hidden="true">/</span>
                  <span>
                    {type.assignmentCount} assignment
                    {type.assignmentCount === 1 ? "" : "s"}
                  </span>
                </div>
                {type.description ? (
                  <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
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
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {sortAgeTiers(type.allowedAgeTiers).map((ageTier) => (
                    <span
                      key={ageTier}
                      className="rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground"
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
                  disabled={index === 0 || reordering || !canEdit}
                  aria-label={`Move ${type.name} up`}
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => onMove(index, 1)}
                  disabled={
                    index === membershipTypes.length - 1 ||
                    reordering ||
                    !canEdit
                  }
                  aria-label={`Move ${type.name} down`}
                >
                  <ArrowDown className="h-4 w-4" />
                </Button>
              </div>

              <div className="flex flex-wrap gap-2 xl:justify-end">
                <ViewOnlyActionButton
                  canEdit={canEdit}
                  describeReason={false}
                  type="button"
                  variant="outline"
                  onClick={() => onEdit(type)}
                >
                  <Pencil className="mr-2 h-4 w-4" />
                  Edit
                </ViewOnlyActionButton>
                <ViewOnlyActionButton
                  canEdit={canEdit}
                  describeReason={false}
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
                </ViewOnlyActionButton>
                {!type.isBuiltIn && (
                  <ViewOnlyActionButton
                    canEdit={canEdit}
                    describeReason={false}
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
                  </ViewOnlyActionButton>
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
  // The club's season, from the zone the SERVER read and handed to the provider
  // (CT-4 group F1, #2870). Before this it went through a helper that read a
  // `Date`'s host-local components, so it answered from whatever zone the bundle
  // was built with rather than the club's.
  // Season NAMES come from `season-label.ts`, which also records why the
  // year-end is unplumbed here and why that keeps name and value in step.
  const clubTime = useClubTime();
  const defaultSeasonYear = clubSeasonYear(clubTime.zone);
  const [membershipTypes, setMembershipTypes] = useState<MembershipType[]>([]);
  const [drafts, setDrafts] = useState<Record<string, DraftMembershipType>>({});
  const [newDraft, setNewDraft] = useState<DraftMembershipType>(() =>
    createEmptyDraft(defaultNewTypeAgeTiers),
  );
  const [editorTarget, setEditorTarget] = useState<EditorTarget | null>(null);
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
  // Membership types resolve to the membership area (their write routes enforce
  // membership:edit), so gate all editors on that area (#1940).
  const canEdit = useAdminAreaEditAccess("membership");

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

  function openNewEditor() {
    setNewDraft((current) =>
      isNewDirty(current) ? current : createEmptyDraft(defaultNewTypeAgeTiers),
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
      setNewDraft(createEmptyDraft(defaultNewTypeAgeTiers));
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
        // Stale-tab / narrowed-permission save surfaces the persistent
        // forbidden-save reason in the existing error banner (#1940).
        if (response.status === 403) {
          setError(ADMIN_FORBIDDEN_SAVE_REASON);
          return;
        }
        throw new Error(
          responseErrorMessage(body, "Failed to create membership type"),
        );
      }
      setMembershipTypes((current) => [...current, body.membershipType]);
      setDrafts((current) => replaceOrAppendDraft(current, body.membershipType));
      setNewDraft(createEmptyDraft(defaultNewTypeAgeTiers));
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
  ): Promise<boolean> {
    const draft = overrideDraft ?? drafts[type.id];
    if (!draft) return false;

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
        if (response.status === 403) {
          setError(ADMIN_FORBIDDEN_SAVE_REASON);
          return false;
        }
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
      return true;
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to save membership type",
      );
      return false;
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
        if (response.status === 403) {
          setError(ADMIN_FORBIDDEN_SAVE_REASON);
          return;
        }
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
        if (response.status === 403) {
          setError(ADMIN_FORBIDDEN_SAVE_REASON);
          return;
        }
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
        if (response.status === 403) {
          setError(ADMIN_FORBIDDEN_SAVE_REASON);
          return;
        }
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
        if (response.status === 403) {
          setError(ADMIN_FORBIDDEN_SAVE_REASON);
          return;
        }
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

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It is rendered in the loading branch too
    so the region exists from the first paint rather than from whenever the
    membership-type fetch settles, and it sits OUTSIDE the `space-y-*` stack so
    the empty wrapper an edit-capable admin gets costs no layout.

    It covers `MembershipTypeList` as well — that component lives in this file
    and is only ever rendered by this page, beneath this banner. The two DIALOGS
    above are a different matter: their contents are a separate accessibility
    container this banner does not reach, so their gated buttons keep their own
    per-button reason.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-8">
      Your admin role can view membership types but cannot change them.
      Membership edit access is required.
    </AdminViewOnlySectionBanner>
  );

  if (loading && membershipTypes.length === 0) {
    return (
      <div>
        {viewOnlyBanner}
        <div className="space-y-6">
          <BackLink href="/admin/membership-setup" label="Membership & Members" />
          <div className="flex min-h-[320px] items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </div>
      </div>
    );
  }

  const editorSaving =
    editorTarget?.mode === "new"
      ? creating
      : Boolean(editingType && savingId === editingType.id);

  return (
    <div ref={pageRef}>
      {viewOnlyBanner}
      <div className="space-y-8">
      <BackLink href="/admin/membership-setup" label="Membership & Members" />
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            Membership types
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
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
          <ViewOnlyActionButton
            canEdit={canEdit}
            describeReason={false}
            type="button"
            onClick={openNewEditor}
          >
            <Plus className="mr-2 h-4 w-4" />
            New membership type
          </ViewOnlyActionButton>
        </div>
      </div>

      {(error || savedMessage) && (
        <div
          ref={feedbackRef}
          role={error ? "alert" : "status"}
          tabIndex={error ? -1 : undefined}
          className={
            error
              ? "scroll-mt-20 rounded-md border border-danger-6 bg-danger-3 px-4 py-3 text-sm text-danger-11 focus:outline-none"
              : "rounded-md border border-success-6 bg-success-3 px-4 py-3 text-sm text-success-11"
          }
        >
          {error || savedMessage}
        </div>
      )}

      <section className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              Type list
            </h2>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Scan policy behavior, allowed tiers, assignment count, and order.
              Open a type to edit its details.
            </p>
          </div>
          <div className="text-sm text-muted-foreground">
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
          canEdit={canEdit}
          onEdit={openEditEditor}
          onMove={moveType}
          onSetActive={(type, isActive) => void setActive(type, isActive)}
          onDelete={(type) => void requestDelete(type)}
        />
      </section>

      <section className="rounded-md border border-border bg-card p-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              Roll forward seasonal assignments
            </h2>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
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
                disabled={!canEdit}
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
                disabled={!canEdit}
              />
            </div>
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
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
            </ViewOnlyActionButton>
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
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
            </ViewOnlyActionButton>
          </div>
        </div>

        {rollForwardResult && (
          <div className="mt-4 space-y-3 rounded-md border border-border bg-muted p-3">
            <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-5">
              <div>
                <div className="text-xs font-medium uppercase text-muted-foreground">
                  Seasons
                </div>
                <div className="mt-1 text-foreground">
                  {seasonSelectLabel(rollForwardResult.fromSeasonYear)} to{" "}
                  {seasonSelectLabel(rollForwardResult.toSeasonYear)}
                </div>
              </div>
              <div>
                <div className="text-xs font-medium uppercase text-muted-foreground">
                  Source
                </div>
                <div className="mt-1 text-foreground">
                  {rollForwardResult.sourceAssignmentCount}
                </div>
              </div>
              <div>
                <div className="text-xs font-medium uppercase text-muted-foreground">
                  Would copy
                </div>
                <div className="mt-1 text-foreground">
                  {rollForwardResult.wouldCopyCount}
                </div>
              </div>
              <div>
                <div className="text-xs font-medium uppercase text-muted-foreground">
                  Copied
                </div>
                <div className="mt-1 text-foreground">
                  {rollForwardResult.copiedCount}
                </div>
              </div>
              <div>
                <div className="text-xs font-medium uppercase text-muted-foreground">
                  Existing target
                </div>
                <div className="mt-1 text-foreground">
                  {rollForwardResult.skippedExistingCount}
                </div>
              </div>
            </div>

            {rollForwardResult.exceptionCount > 0 && (
              <div className="rounded-md border border-warning-6 bg-warning-3 p-3">
                <div className="text-sm font-medium text-warning-11">
                  Exceptions ({rollForwardResult.exceptionCount})
                </div>
                <div className="mt-2 space-y-1">
                  {rollForwardResult.exceptions
                    .slice(0, 10)
                    .map((exception) => (
                      <div
                        key={`${exception.code}-${exception.memberId}`}
                        className="text-xs text-warning-11"
                      >
                        {exception.memberName} ({exception.memberEmail}) -{" "}
                        {rollForwardExceptionLabel(exception)}
                      </div>
                    ))}
                </div>
                {rollForwardResult.exceptionCount > 10 && (
                  <p className="mt-2 text-xs text-warning-11">
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
        saving={editorSaving}
        canEdit={canEdit}
        error={editorTarget ? error : ""}
        onDraftChange={updateEditorDraft}
        onSave={() => {
          if (editorTarget?.mode === "new") {
            void createMembershipType();
          } else if (editingType) {
            // Close the editor once an edit save succeeds so admins never need
            // Cancel to leave a saved state (#2045). saveMembershipType has
            // already synced the draft to the saved values, so clearing the
            // target (rather than cancelEditor) closes without discarding them.
            // Archive/Reactivate routes through onSetActive/setActive and keeps
            // the dialog open, so it is unaffected by this success path.
            void saveMembershipType(editingType).then((saved) => {
              if (saved) setEditorTarget(null);
            });
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
        error={mergeSource ? error : ""}
        canEdit={canEdit}
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
    </div>
  );
}
