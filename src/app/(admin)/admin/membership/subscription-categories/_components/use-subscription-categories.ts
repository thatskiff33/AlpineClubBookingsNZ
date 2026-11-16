"use client";

import { useEffect, useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { ADMIN_FORBIDDEN_SAVE_REASON } from "@/components/admin/view-only-action";
import {
  ApiRefusalError,
  apiErrorMessageFromBody,
  readApiErrorBody,
  refusalMessageOr,
  readApiObjectOrEmpty,
} from "@/lib/api-error-message";
import {
  createEmptyDraft,
  draftFromCategory,
  draftPayload,
  validateDraft,
  type DraftSubscriptionCategory,
  type EditorTarget,
  type SubscriptionCategoriesResponse,
  type SubscriptionCategory,
} from "./subscription-category-draft";

/**
 * The Subscription Categories page's state and its calls to
 * `/api/admin/subscription-categories`: load, create, save, archive or
 * reactivate, and delete (after a confirm), plus the editor dialog's target and
 * draft. The page renders; this owns what it renders from.
 */
export function useSubscriptionCategories() {
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
      const body = (await readApiObjectOrEmpty(response)) as
        | SubscriptionCategoriesResponse
        | { error?: string };
      if (!response.ok || !("subscriptionCategories" in body)) {
        throw new ApiRefusalError(apiErrorMessageFromBody(body, "Failed to load subscription categories"));
      }
      setSubscriptionCategories(body.subscriptionCategories);
      setDrafts(Object.fromEntries(body.subscriptionCategories.map((category) => [category.id, draftFromCategory(category)])));
    } catch (loadError) {
      setError(refusalMessageOr(loadError, "Failed to load subscription categories"));
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
        setError(validationError);
        return;
      }
      const response = await fetch("/api/admin/subscription-categories", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftPayload(newDraft)),
      });
      const body = (await readApiObjectOrEmpty(response)) as
        | { subscriptionCategory: SubscriptionCategory }
        | { error?: string };
      if (!response.ok || !("subscriptionCategory" in body)) {
        if (response.status === 403) {
          setError(ADMIN_FORBIDDEN_SAVE_REASON);
          return;
        }
        throw new ApiRefusalError(apiErrorMessageFromBody(body, "Failed to create subscription category"));
      }
      setSubscriptionCategories((current) => [...current, body.subscriptionCategory]);
      setDrafts((current) => ({ ...current, [body.subscriptionCategory.id]: draftFromCategory(body.subscriptionCategory) }));
      setNewDraft(createEmptyDraft());
      setEditorTarget(null);
      setSavedMessage("Subscription category created.");
    } catch (createError) {
      setError(refusalMessageOr(createError, "Failed to create subscription category"));
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
        setError(validationError);
        return false;
      }
      const response = await fetch(`/api/admin/subscription-categories/${category.id}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftPayload(draft)),
      });
      const body = (await readApiObjectOrEmpty(response)) as
        | { subscriptionCategory: SubscriptionCategory }
        | { error?: string };
      if (!response.ok || !("subscriptionCategory" in body)) {
        if (response.status === 403) {
          setError(ADMIN_FORBIDDEN_SAVE_REASON);
          return false;
        }
        throw new ApiRefusalError(apiErrorMessageFromBody(body, "Failed to save subscription category"));
      }
      setSubscriptionCategories((current) =>
        current.map((item) => (item.id === body.subscriptionCategory.id ? body.subscriptionCategory : item)));
      setDrafts((current) => ({ ...current, [body.subscriptionCategory.id]: draftFromCategory(body.subscriptionCategory) }));
      setSavedMessage("Subscription category saved.");
      return true;
    } catch (saveError) {
      setError(refusalMessageOr(saveError, "Failed to save subscription category"));
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
      const body = (await readApiErrorBody(response)) as { ok?: boolean; error?: string } | null;
      if (!response.ok || !body?.ok) {
        if (response.status === 403) {
          setError(ADMIN_FORBIDDEN_SAVE_REASON);
          return;
        }
        throw new ApiRefusalError(apiErrorMessageFromBody(body, "Failed to delete subscription category"));
      }
      setSubscriptionCategories((current) => current.filter((item) => item.id !== category.id));
      setDrafts((current) => {
        const next = { ...current };
        delete next[category.id];
        return next;
      });
      setSavedMessage(`Deleted ${category.name}.`);
    } catch (deleteError) {
      setError(refusalMessageOr(deleteError, "Failed to delete subscription category"));
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

  return {
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
  };
}
