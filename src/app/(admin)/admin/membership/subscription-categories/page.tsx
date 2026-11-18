"use client";

import Link from "next/link";
import {
  Archive,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
} from "lucide-react";
import { BackLink } from "@/components/admin/back-link";
import { adminHref, adminLink, getAdminPage } from "@/lib/admin-hubs";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
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
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import type {
  DraftSubscriptionCategory,
  SubscriptionCategory,
} from "./_components/subscription-category-draft";
import { useSubscriptionCategories } from "./_components/use-subscription-categories";

export default function AdminSubscriptionCategoriesPage() {
  const canEdit = useAdminAreaEditAccess("membership");
  const {
    subscriptionCategories,
    loading,
    error,
    savedMessage,
    creating,
    savingId,
    deletingId,
    editorTarget,
    setEditorTarget,
    editingCategory,
    editorDraft,
    setEditorDraft,
    editorSaving,
    loadSubscriptionCategories,
    openNewEditor,
    openEditEditor,
    setActive,
    requestDelete,
    saveEditor,
    confirmDialog,
  } = useSubscriptionCategories();

  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-8">
      Your admin role can view subscription categories but cannot change
      them. Membership edit access is required.
    </AdminViewOnlySectionBanner>
  );

  if (loading && subscriptionCategories.length === 0) {
    return (
      <div>
        {viewOnlyBanner}
        <div className="space-y-6">
          <BackLink {...adminLink("membership-setup")} />
          <div className="flex min-h-[320px] items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-8">
        <BackLink {...adminLink("membership-setup")} />
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">{getAdminPage("subscription-categories").label}</h1>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Flat-rate billing categories — e.g. Couple, Family — that decide
              how a member&apos;s annual subscription is billed, independent of
              their membership type. A member&apos;s membership type still
              governs their booking rights and rate; set the amount each
              category bills on the{" "}
              <Link className="underline" href={adminHref("fees")}>
                Fees
              </Link>{" "}
              page.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => void loadSubscriptionCategories()}
              disabled={loading || creating || savingId !== null}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
            <ViewOnlyActionButton canEdit={canEdit} describeReason={false} type="button" onClick={openNewEditor}>
              <Plus className="mr-2 h-4 w-4" />
              New category
            </ViewOnlyActionButton>
          </div>
        </div>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {savedMessage && !error && (
          <p role="status" className="text-sm text-muted-foreground">
            {savedMessage}
          </p>
        )}

        <div className="space-y-4">
          {subscriptionCategories.length === 0 ? (
            <p className="text-sm text-muted-foreground">No subscription categories yet.</p>
          ) : (
            subscriptionCategories.map((category) => (
              <SubscriptionCategoryCard
                key={category.id}
                category={category}
                canEdit={canEdit}
                saving={savingId === category.id}
                deleting={deletingId === category.id}
                onEdit={() => openEditEditor(category)}
                onToggleActive={() => void setActive(category, !category.isActive)}
                onDelete={() => void requestDelete(category)}
              />
            ))
          )}
        </div>
      </div>

      <SubscriptionCategoryEditorDialog
        open={editorTarget !== null}
        isNew={editorTarget?.mode === "new"}
        editingCategory={editingCategory}
        draft={editorDraft}
        canEdit={canEdit}
        saving={editorSaving}
        onDraftChange={setEditorDraft}
        onClose={() => setEditorTarget(null)}
        onSave={() => void saveEditor()}
      />

      {confirmDialog}
    </div>
  );
}

/** One category's summary row and its Edit, Archive/Reactivate and Delete actions. */
function SubscriptionCategoryCard({
  category,
  canEdit,
  saving,
  deleting,
  onEdit,
  onToggleActive,
  onDelete,
}: {
  category: SubscriptionCategory;
  canEdit: ReturnType<typeof useAdminAreaEditAccess>;
  saving: boolean;
  deleting: boolean;
  onEdit: () => void;
  onToggleActive: () => void;
  onDelete: () => void;
}) {
  return (
    <article
      className="rounded-lg border border-border bg-card p-4 shadow-sm"
    >
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-foreground">{category.name}</h2>
            <Badge variant={category.isActive ? "default" : "secondary"}>
              {category.isActive ? "Active" : "Archived"}
            </Badge>
            <Badge variant={category.isBuiltIn ? "outline" : "secondary"}>
              {category.isBuiltIn ? "Built-in" : "Custom"}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            Key: {category.key} · {category.assignmentCount} member
            {category.assignmentCount === 1 ? "" : "s"} assigned ·{" "}
            {category.feeCount} fee schedule{category.feeCount === 1 ? "" : "s"}
          </p>
          {category.description && (
            <p className="max-w-2xl text-sm text-muted-foreground">{category.description}</p>
          )}
        </div>

        <div className="flex flex-wrap gap-2 xl:justify-end">
          <ViewOnlyActionButton
            canEdit={canEdit}
            describeReason={false}
            type="button"
            variant="outline"
            onClick={onEdit}
          >
            <Pencil className="mr-2 h-4 w-4" />
            Edit
          </ViewOnlyActionButton>
          {!category.isBuiltIn && (
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              type="button"
              variant="outline"
              onClick={onToggleActive}
              disabled={saving}
            >
              {saving ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : category.isActive ? (
                <Archive className="mr-2 h-4 w-4" />
              ) : (
                <RotateCcw className="mr-2 h-4 w-4" />
              )}
              {category.isActive ? "Archive" : "Reactivate"}
            </ViewOnlyActionButton>
          )}
          {!category.isBuiltIn && (
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              type="button"
              variant="outline"
              onClick={onDelete}
              disabled={deleting}
              aria-label={`Delete ${category.name}`}
            >
              {deleting ? (
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
}

/** The create/edit dialog for one category draft. */
function SubscriptionCategoryEditorDialog({
  open,
  isNew,
  editingCategory,
  draft,
  canEdit,
  saving,
  onDraftChange,
  onClose,
  onSave,
}: {
  open: boolean;
  isNew: boolean;
  editingCategory: SubscriptionCategory | null;
  draft: DraftSubscriptionCategory | null;
  canEdit: ReturnType<typeof useAdminAreaEditAccess>;
  saving: boolean;
  onDraftChange: (next: DraftSubscriptionCategory) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isNew ? "New subscription category" : `Edit ${editingCategory?.name ?? ""}`}
          </DialogTitle>
          <DialogDescription>
            Categories only affect how a member&apos;s subscription is billed
            — never their booking rights or rate.
          </DialogDescription>
        </DialogHeader>
        {draft && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="subscription-category-name">Name</Label>
              <Input
                id="subscription-category-name"
                value={draft.name}
                onChange={(event) => onDraftChange({ ...draft, name: event.target.value })}
                placeholder="e.g. Couple"
                disabled={editingCategory?.isBuiltIn}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="subscription-category-description">Description</Label>
              <Textarea
                id="subscription-category-description"
                value={draft.description}
                onChange={(event) => onDraftChange({ ...draft, description: event.target.value })}
                placeholder="Optional note for other admins"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="subscription-category-sort-order">Sort order</Label>
              <Input
                id="subscription-category-sort-order"
                inputMode="numeric"
                value={draft.sortOrder}
                onChange={(event) => onDraftChange({ ...draft, sortOrder: event.target.value })}
                placeholder="Lower numbers list first"
              />
            </div>
            {editingCategory && !editingCategory.isBuiltIn && (
              <div className="flex items-center gap-2">
                <Checkbox
                  id="subscription-category-active"
                  checked={draft.isActive}
                  onCheckedChange={(checked) => onDraftChange({ ...draft, isActive: checked })}
                />
                <Label htmlFor="subscription-category-active">Active</Label>
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <ViewOnlyActionButton
            canEdit={canEdit}
            describeReason={false}
            type="button"
            onClick={onSave}
            disabled={saving}
          >
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            Save
          </ViewOnlyActionButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
