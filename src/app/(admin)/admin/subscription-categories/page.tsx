"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { apiErrorMessageFromBody } from "@/lib/api-error-message";

interface SubscriptionCategory {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isActive: boolean;
  isBuiltIn: boolean;
  sortOrder: number;
  assignmentCount: number;
  feeCount: number;
}

interface SubscriptionCategoriesResponse {
  subscriptionCategories: SubscriptionCategory[];
}

interface DraftSubscriptionCategory {
  name: string;
  description: string;
  isActive: boolean;
  sortOrder: string;
}

type EditorTarget =
  | { mode: "new" }
  | { mode: "edit"; subscriptionCategoryId: string };

function createEmptyDraft(): DraftSubscriptionCategory {
  return { name: "", description: "", isActive: true, sortOrder: "" };
}

function draftFromCategory(category: SubscriptionCategory): DraftSubscriptionCategory {
  return {
    name: category.name,
    description: category.description ?? "",
    isActive: category.isActive,
    sortOrder: String(category.sortOrder),
  };
}

function validateDraft(draft: DraftSubscriptionCategory): string | null {
  if (draft.name.trim().length === 0) {
    return "Enter a subscription category name.";
  }
  if (draft.sortOrder.trim().length > 0 && !/^\d+$/.test(draft.sortOrder.trim())) {
    return "Sort order must be a whole number.";
  }
  return null;
}

function draftPayload(draft: DraftSubscriptionCategory) {
  const trimmedSortOrder = draft.sortOrder.trim();
  return {
    name: draft.name,
    description: draft.description,
    isActive: draft.isActive,
    ...(trimmedSortOrder.length > 0 ? { sortOrder: Number(trimmedSortOrder) } : {}),
  };
}

export default function AdminSubscriptionCategoriesPage() {
  const canEdit = useAdminAreaEditAccess("membership");
  const { confirm, confirmDialog } = useConfirm();

  const [subscriptionCategories, setSubscriptionCategories] = useState<SubscriptionCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [savedMessage, setSavedMessage] = useState("");

  const [editorTarget, setEditorTarget] = useState<EditorTarget | null>(null);
  const [newDraft, setNewDraft] = useState<DraftSubscriptionCategory>(createEmptyDraft());
  const [drafts, setDrafts] = useState<Record<string, DraftSubscriptionCategory>>({});
  const [creating, setCreating] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function loadSubscriptionCategories() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/subscription-categories", {
        credentials: "same-origin",
      });
      const body = (await response.json()) as SubscriptionCategoriesResponse | { error?: string };
      if (!response.ok || !("subscriptionCategories" in body)) {
        throw new Error(apiErrorMessageFromBody(body, "Failed to load subscription categories"));
      }
      setSubscriptionCategories(body.subscriptionCategories);
      setDrafts(Object.fromEntries(body.subscriptionCategories.map((category) => [category.id, draftFromCategory(category)])));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load subscription categories");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadSubscriptionCategories();
  }, []);

  function openNewEditor() {
    setNewDraft(createEmptyDraft());
    setEditorTarget({ mode: "new" });
  }

  function openEditEditor(category: SubscriptionCategory) {
    setDrafts((current) => ({ ...current, [category.id]: draftFromCategory(category) }));
    setEditorTarget({ mode: "edit", subscriptionCategoryId: category.id });
  }

  async function createSubscriptionCategory() {
    setCreating(true);
    setError("");
    setSavedMessage("");
    try {
      const validationError = validateDraft(newDraft);
      if (validationError) {
        throw new Error(validationError);
      }
      const response = await fetch("/api/admin/subscription-categories", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftPayload(newDraft)),
      });
      const body = (await response.json()) as
        | { subscriptionCategory: SubscriptionCategory }
        | { error?: string };
      if (!response.ok || !("subscriptionCategory" in body)) {
        if (response.status === 403) {
          setError(ADMIN_FORBIDDEN_SAVE_REASON);
          return;
        }
        throw new Error(apiErrorMessageFromBody(body, "Failed to create subscription category"));
      }
      setSubscriptionCategories((current) => [...current, body.subscriptionCategory]);
      setDrafts((current) => ({ ...current, [body.subscriptionCategory.id]: draftFromCategory(body.subscriptionCategory) }));
      setNewDraft(createEmptyDraft());
      setEditorTarget(null);
      setSavedMessage("Subscription category created.");
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Failed to create subscription category");
    } finally {
      setCreating(false);
    }
  }

  async function saveSubscriptionCategory(category: SubscriptionCategory, overrideDraft?: DraftSubscriptionCategory) {
    const draft = overrideDraft ?? drafts[category.id];
    if (!draft) return false;

    setSavingId(category.id);
    setError("");
    setSavedMessage("");
    try {
      const validationError = validateDraft(draft);
      if (validationError) {
        throw new Error(validationError);
      }
      const response = await fetch(`/api/admin/subscription-categories/${category.id}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftPayload(draft)),
      });
      const body = (await response.json()) as
        | { subscriptionCategory: SubscriptionCategory }
        | { error?: string };
      if (!response.ok || !("subscriptionCategory" in body)) {
        if (response.status === 403) {
          setError(ADMIN_FORBIDDEN_SAVE_REASON);
          return false;
        }
        throw new Error(apiErrorMessageFromBody(body, "Failed to save subscription category"));
      }
      setSubscriptionCategories((current) =>
        current.map((item) => (item.id === body.subscriptionCategory.id ? body.subscriptionCategory : item)));
      setDrafts((current) => ({ ...current, [body.subscriptionCategory.id]: draftFromCategory(body.subscriptionCategory) }));
      setSavedMessage("Subscription category saved.");
      return true;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save subscription category");
      return false;
    } finally {
      setSavingId(null);
    }
  }

  async function setActive(category: SubscriptionCategory, isActive: boolean) {
    const draft = drafts[category.id] ?? draftFromCategory(category);
    const nextDraft = { ...draft, isActive };
    setDrafts((current) => ({ ...current, [category.id]: nextDraft }));
    await saveSubscriptionCategory(category, nextDraft);
  }

  async function deleteSubscriptionCategory(category: SubscriptionCategory) {
    setDeletingId(category.id);
    setError("");
    setSavedMessage("");
    try {
      const response = await fetch(`/api/admin/subscription-categories/${category.id}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!response.ok || !body?.ok) {
        if (response.status === 403) {
          setError(ADMIN_FORBIDDEN_SAVE_REASON);
          return;
        }
        throw new Error(apiErrorMessageFromBody(body, "Failed to delete subscription category"));
      }
      setSubscriptionCategories((current) => current.filter((item) => item.id !== category.id));
      setDrafts((current) => {
        const next = { ...current };
        delete next[category.id];
        return next;
      });
      setSavedMessage(`Deleted ${category.name}.`);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Failed to delete subscription category");
    } finally {
      setDeletingId(null);
    }
  }

  async function requestDelete(category: SubscriptionCategory) {
    setError("");
    setSavedMessage("");
    const confirmed = await confirm({
      title: `Delete ${category.name}?`,
      description: "Permanently deletes this subscription category. This cannot be undone.",
      confirmLabel: "Delete category",
      cancelLabel: "Cancel",
      destructive: true,
    });
    if (!confirmed) return;
    await deleteSubscriptionCategory(category);
  }

  const editingCategory =
    editorTarget?.mode === "edit"
      ? subscriptionCategories.find((category) => category.id === editorTarget.subscriptionCategoryId) ?? null
      : null;
  const editorDraft =
    editorTarget?.mode === "new"
      ? newDraft
      : editingCategory
        ? drafts[editingCategory.id] ?? draftFromCategory(editingCategory)
        : null;

  function setEditorDraft(next: DraftSubscriptionCategory) {
    if (editorTarget?.mode === "new") {
      setNewDraft(next);
    } else if (editingCategory) {
      setDrafts((current) => ({ ...current, [editingCategory.id]: next }));
    }
  }

  async function saveEditor() {
    if (editorTarget?.mode === "new") {
      await createSubscriptionCategory();
      return;
    }
    if (editingCategory && editorDraft) {
      const ok = await saveSubscriptionCategory(editingCategory, editorDraft);
      if (ok) setEditorTarget(null);
    }
  }

  const editorSaving = editorTarget?.mode === "new" ? creating : Boolean(editingCategory && savingId === editingCategory.id);

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
          <BackLink href="/admin/membership-setup" label="Membership & Members" />
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
        <BackLink href="/admin/membership-setup" label="Membership & Members" />
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Subscription categories</h1>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Flat-rate billing categories — e.g. Couple, Family — that decide
              how a member&apos;s annual subscription is billed, independent of
              their membership type. A member&apos;s membership type still
              governs their booking rights and rate; set the amount each
              category bills on the{" "}
              <Link className="underline" href="/admin/fees">
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
              <article
                key={category.id}
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
                      onClick={() => openEditEditor(category)}
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
                        onClick={() => void setActive(category, !category.isActive)}
                        disabled={savingId === category.id}
                      >
                        {savingId === category.id ? (
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
                        onClick={() => void requestDelete(category)}
                        disabled={deletingId === category.id}
                        aria-label={`Delete ${category.name}`}
                      >
                        {deletingId === category.id ? (
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
            ))
          )}
        </div>
      </div>

      <Dialog open={editorTarget !== null} onOpenChange={(open) => !open && setEditorTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editorTarget?.mode === "new" ? "New subscription category" : `Edit ${editingCategory?.name ?? ""}`}
            </DialogTitle>
            <DialogDescription>
              Categories only affect how a member&apos;s subscription is billed
              — never their booking rights or rate.
            </DialogDescription>
          </DialogHeader>
          {editorDraft && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="subscription-category-name">Name</Label>
                <Input
                  id="subscription-category-name"
                  value={editorDraft.name}
                  onChange={(event) => setEditorDraft({ ...editorDraft, name: event.target.value })}
                  placeholder="e.g. Couple"
                  disabled={editingCategory?.isBuiltIn}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="subscription-category-description">Description</Label>
                <Textarea
                  id="subscription-category-description"
                  value={editorDraft.description}
                  onChange={(event) => setEditorDraft({ ...editorDraft, description: event.target.value })}
                  placeholder="Optional note for other admins"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="subscription-category-sort-order">Sort order</Label>
                <Input
                  id="subscription-category-sort-order"
                  inputMode="numeric"
                  value={editorDraft.sortOrder}
                  onChange={(event) => setEditorDraft({ ...editorDraft, sortOrder: event.target.value })}
                  placeholder="Lower numbers list first"
                />
              </div>
              {editingCategory && !editingCategory.isBuiltIn && (
                <div className="flex items-center gap-2">
                  <input
                    id="subscription-category-active"
                    type="checkbox"
                    checked={editorDraft.isActive}
                    onChange={(event) => setEditorDraft({ ...editorDraft, isActive: event.target.checked })}
                    className="h-4 w-4"
                  />
                  <Label htmlFor="subscription-category-active">Active</Label>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setEditorTarget(null)}>
              Cancel
            </Button>
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              type="button"
              onClick={() => void saveEditor()}
              disabled={editorSaving}
            >
              {editorSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              Save
            </ViewOnlyActionButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {confirmDialog}
    </div>
  );
}
