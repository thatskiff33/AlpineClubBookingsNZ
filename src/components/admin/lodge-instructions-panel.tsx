"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  WysiwygEditor,
  type WysiwygEditorHandle,
} from "@/components/admin/page-content-panel";
import {
  isPolicyScopeReady,
  PolicyScopeSelect,
  usePolicyScopeOptions,
} from "@/components/admin/booking-policies/policy-scope-select";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  AdminForbiddenSaveNotice,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { useClubTime } from "@/components/club-time-provider";

// Mirrors LODGE_INSTRUCTION_KEYS / LODGE_INSTRUCTION_LABELS in
// src/lib/lodge-instructions.ts (that module is server-only).
const DOCUMENTS = [
  {
    key: "OPEN",
    title: "Opening the Lodge",
    description: "Steps to open the lodge at the start of a stay or season.",
  },
  {
    key: "CLOSE",
    title: "Closing the Lodge",
    description: "Steps to shut the lodge down safely before leaving.",
  },
  {
    key: "DAY_TO_DAY",
    title: "Day-to-Day Running",
    description: "Daily routines and duties while the lodge is occupied.",
  },
] as const;

type DocumentKey = (typeof DOCUMENTS)[number]["key"];

type ApiDocument = {
  key: DocumentKey;
  contentHtml: string;
  updatedAt: string | null;
  hasOverride?: boolean;
};

type KeyedRecord<T> = Record<DocumentKey, T>;

function emptyRecord<T>(value: T): KeyedRecord<T> {
  return { OPEN: value, CLOSE: value, DAY_TO_DAY: value };
}

function partitionUrl(lodgeId: string | null): string {
  return lodgeId
    ? `/api/admin/lodge-instructions?lodgeId=${encodeURIComponent(lodgeId)}`
    : "/api/admin/lodge-instructions";
}

/**
 * "Last saved", in the club's time rather than the admin's own.
 *
 * The stamp says when the CLUB's document changed, so an officer abroad must not
 * read it in their zone (#2264). The stamp is a real INSTANT, so it projects through the club's PERSISTED
 * timezone (CT-4, #2870; INV-CONFIG-002) rather than the container's `TZ`. Same
 * shape as before - only the zone's AUTHORITY moved, from the environment to
 * the club's recorded setting. A hook because that setting reaches the browser
 * as data through `ClubTimeProvider`, so it is not a module constant any more.
 */
function useUpdatedAtFormatter() {
  const clubTime = useClubTime();
  return (value: string | null): string =>
    value ? clubTime.instantDateTime(new Date(value)) : "Never updated";
}

export function LodgeInstructionsPanel() {
  const formatUpdatedAt = useUpdatedAtFormatter();
  // Scope (lodge-scoping contract): null edits the club-wide (null lodgeId)
  // documents; a lodge edits that lodge's override rows, each of which
  // replaces the club-wide document of that key at that lodge. The scope
  // control renders nothing while fewer than two lodges exist.
  const [scopeLodgeId, setScopeLodgeId] = useState<string | null>(null);
  const policyScope = usePolicyScopeOptions(scopeLodgeId);
  const policyScopeReady = isPolicyScopeReady(policyScope);
  const scopeLodgeName =
    policyScope.state.kind === "lodge" ? policyScope.state.lodgeName : null;
  // Lodge instructions gate on the LODGE area, not content (#1927).
  const canEdit = useAdminAreaEditAccess("lodge");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [drafts, setDrafts] = useState<KeyedRecord<string>>(emptyRecord(""));
  const [updatedAt, setUpdatedAt] = useState<KeyedRecord<string | null>>(
    emptyRecord(null),
  );
  const [hasOverride, setHasOverride] = useState<KeyedRecord<boolean>>(
    emptyRecord(false),
  );
  // Keys where the admin has started an override (seeded from the club-wide
  // content) but not saved it yet.
  const [pendingOverride, setPendingOverride] = useState<
    KeyedRecord<boolean>
  >(emptyRecord(false));
  const [savingKey, setSavingKey] = useState<DocumentKey | null>(null);
  const editorRefs = useRef<KeyedRecord<WysiwygEditorHandle | null>>(
    emptyRecord(null),
  );
  const activeScopeRef = useRef<string | null>(scopeLodgeId);
  /*
    #2887: ownership follows the COMMIT, not the render, and this must stay a
    LAYOUT effect - a passive one is flushed after paint, leaving a window in
    which a late lodge-A response still reads A as current. Full reasoning and
    both mutation proofs live in one place:
    `src/lib/__tests__/lodge-scope-committed-ownership.test.tsx`.
  */
  useLayoutEffect(() => {
    activeScopeRef.current = scopeLodgeId;
  }, [scopeLodgeId]);
  const loadSequenceRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);

  // Load all three documents of the selected partition for editing.
  const loadDocuments = useCallback(async () => {
    const requestedScope = scopeLodgeId;
    const sequence = ++loadSequenceRef.current;
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    if (!policyScopeReady) {
      setDrafts(emptyRecord(""));
      setUpdatedAt(emptyRecord(null));
      setHasOverride(emptyRecord(false));
      setPendingOverride(emptyRecord(false));
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(partitionUrl(requestedScope), {
        credentials: "same-origin",
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error("load-failed");
      }
      const body = (await res.json()) as { documents: ApiDocument[] };
      if (
        sequence !== loadSequenceRef.current ||
        activeScopeRef.current !== requestedScope
      ) {
        return;
      }
      const nextDrafts = emptyRecord("");
      const nextUpdatedAt = emptyRecord<string | null>(null);
      const nextHasOverride = emptyRecord(false);
      for (const doc of body.documents) {
        nextDrafts[doc.key] = doc.contentHtml;
        nextUpdatedAt[doc.key] = doc.updatedAt;
        nextHasOverride[doc.key] = doc.hasOverride === true;
      }
      setDrafts(nextDrafts);
      setUpdatedAt(nextUpdatedAt);
      setHasOverride(nextHasOverride);
      setPendingOverride(emptyRecord(false));
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (
        sequence !== loadSequenceRef.current ||
        activeScopeRef.current !== requestedScope
      ) {
        return;
      }
      setLoadError("Failed to load lodge instructions. Please try again.");
    } finally {
      if (
        sequence === loadSequenceRef.current &&
        activeScopeRef.current === requestedScope
      ) {
        setLoading(false);
      }
    }
  }, [policyScopeReady, scopeLodgeId]);

  useEffect(() => {
    loadDocuments();
    return () => loadAbortRef.current?.abort();
  }, [loadDocuments]);

  // Save a single document into the selected partition; content is
  // sanitised again server-side.
  async function saveDocument(key: DocumentKey, title: string) {
    if (!policyScopeReady) return;
    const requestedScope = scopeLodgeId;
    const contentHtml = editorRefs.current[key]?.getHtml() ?? drafts[key];
    setSavingKey(key);
    setForbidden(false);
    try {
      const res = await fetch("/api/admin/lodge-instructions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          key,
          contentHtml,
          ...(requestedScope ? { lodgeId: requestedScope } : {}),
        }),
      });
      if (!res.ok) {
        if (res.status === 403) {
          setForbidden(true);
        }
        const body = await res.json().catch(() => null);
        toast.error(body?.error ?? `Failed to save ${title}`);
        return;
      }
      const body = (await res.json()) as { document: ApiDocument };
      if (activeScopeRef.current !== requestedScope) return;
      setDrafts((prev) => ({ ...prev, [key]: body.document.contentHtml }));
      setUpdatedAt((prev) => ({ ...prev, [key]: body.document.updatedAt }));
      if (requestedScope) {
        setHasOverride((prev) => ({ ...prev, [key]: true }));
        setPendingOverride((prev) => ({ ...prev, [key]: false }));
      }
      toast.success(
        requestedScope
          ? `${title} override saved for ${scopeLodgeName ?? "lodge"}`
          : `${title} saved`,
      );
    } catch {
      toast.error(`Failed to save ${title}`);
    } finally {
      setSavingKey(null);
    }
  }

  // Start a lodge override as a copy of the club-wide document, so the
  // admin adjusts existing content rather than writing from a blank slate.
  async function createOverride(key: DocumentKey, title: string) {
    if (!policyScopeReady) return;
    const requestedScope = scopeLodgeId;
    try {
      const res = await fetch(partitionUrl(null), {
        credentials: "same-origin",
      });
      if (!res.ok) {
        throw new Error("load-failed");
      }
      const body = (await res.json()) as { documents: ApiDocument[] };
      if (activeScopeRef.current !== requestedScope) return;
      const clubWide = body.documents.find((doc) => doc.key === key);
      setDrafts((prev) => ({ ...prev, [key]: clubWide?.contentHtml ?? "" }));
      setPendingOverride((prev) => ({ ...prev, [key]: true }));
    } catch {
      toast.error(`Failed to load the club-wide ${title.toLowerCase()} content`);
    }
  }

  // Remove a lodge's override row so the lodge reverts to the club-wide
  // document (explicit remove flag; see the admin route).
  async function removeOverride(key: DocumentKey, title: string) {
    if (!policyScopeReady) return;
    const requestedScope = scopeLodgeId;
    if (
      !window.confirm(
        `Remove ${scopeLodgeName ?? "this lodge"}'s ${title.toLowerCase()} override? Hut leaders there will see the club-wide document again.`,
      )
    ) {
      return;
    }
    setSavingKey(key);
    setForbidden(false);
    try {
      const res = await fetch("/api/admin/lodge-instructions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ key, lodgeId: requestedScope, remove: true }),
      });
      if (!res.ok) {
        if (res.status === 403) {
          setForbidden(true);
        }
        const body = await res.json().catch(() => null);
        toast.error(body?.error ?? `Failed to remove the ${title} override`);
        return;
      }
      if (activeScopeRef.current !== requestedScope) return;
      setDrafts((prev) => ({ ...prev, [key]: "" }));
      setUpdatedAt((prev) => ({ ...prev, [key]: null }));
      setHasOverride((prev) => ({ ...prev, [key]: false }));
      setPendingOverride((prev) => ({ ...prev, [key]: false }));
      toast.success(`${title} override removed — this lodge uses the club-wide document`);
    } catch {
      toast.error(`Failed to remove the ${title} override`);
    } finally {
      setSavingKey(null);
    }
  }

  const scopeIsLodge = scopeLodgeId !== null;

  /*
    #2160: the view-only explanation lives here, once, at the top of the panel —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before
    its content appears; a region injected already-populated is silently dropped
    by some screen-reader/browser pairings. That is why it is hoisted above the
    loading/error early-returns and rendered in every branch. It sits OUTSIDE
    the `space-y-*` stack so the empty wrapper an edit-capable admin gets costs
    no layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view lodge instructions but cannot change them.
      The editors below are read-only.
    </AdminViewOnlySectionBanner>
  );

  const scopeControl = (
    <PolicyScopeSelect
      options={policyScope}
      value={scopeLodgeId}
      onChange={(nextScope) => {
        loadAbortRef.current?.abort();
        loadSequenceRef.current += 1;
        activeScopeRef.current = nextScope;
        setDrafts(emptyRecord(""));
        setUpdatedAt(emptyRecord(null));
        setHasOverride(emptyRecord(false));
        setPendingOverride(emptyRecord(false));
        setScopeLodgeId(nextScope);
      }}
      id="lodge-instructions-scope"
    />
  );

  if (!policyScopeReady) {
    return (
      <div>
        {viewOnlyBanner}
        <div className="space-y-6">{scopeControl}</div>
      </div>
    );
  }

  if (loading) {
    return (
      <div>
        {viewOnlyBanner}
        <div className="space-y-6">
        {scopeControl}
        <p className="text-sm text-muted-foreground">Loading lodge instructions...</p>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div>
        {viewOnlyBanner}
        <div className="space-y-3">
        {scopeControl}
        <p className="text-sm text-danger-11">{loadError}</p>
        <Button type="button" variant="outline" onClick={loadDocuments}>
          Retry
        </Button>
        </div>
      </div>
    );
  }

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-6">
      {scopeControl}

      {forbidden ? <AdminForbiddenSaveNotice /> : null}

      {DOCUMENTS.map((doc) => {
        const showEditor =
          !scopeIsLodge || hasOverride[doc.key] || pendingOverride[doc.key];
        return (
          <Card key={doc.key}>
            <CardHeader>
              <CardTitle>
                {scopeIsLodge
                  ? `${doc.title} — ${scopeLodgeName ?? "Lodge"} override`
                  : doc.title}
              </CardTitle>
              <CardDescription>
                {scopeIsLodge
                  ? `Replaces the club-wide ${doc.title.toLowerCase()} document for this lodge.`
                  : doc.description}{" "}
                Last saved: {formatUpdatedAt(updatedAt[doc.key])}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {!showEditor ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    {scopeLodgeName ?? "This lodge"} uses the club-wide{" "}
                    {doc.title.toLowerCase()} document. An override replaces it
                    entirely for this lodge.
                  </p>
                  <ViewOnlyActionButton
                    canEdit={canEdit}
                    describeReason={false}
                    type="button"
                    variant="outline"
                    onClick={() => createOverride(doc.key, doc.title)}
                    disabled={savingKey !== null}
                  >
                    Create override (copies club-wide content)
                  </ViewOnlyActionButton>
                </>
              ) : (
                <>
                  <WysiwygEditor
                    key={`${scopeLodgeId ?? "club-wide"}-${doc.key}-${pendingOverride[doc.key] ? "pending" : "saved"}`}
                    ref={(handle) => {
                      editorRefs.current[doc.key] = handle;
                    }}
                    value={drafts[doc.key]}
                    onChange={(html) =>
                      setDrafts((prev) => ({ ...prev, [doc.key]: html }))
                    }
                    placeholder={`Write the ${doc.title.toLowerCase()} instructions...`}
                    tokenHelpContext="lodge-instructions"
                    readOnly={!canEdit}
                    resolvingAccess={canEdit === undefined}
                  />
                  <div className="flex flex-wrap items-center justify-end gap-3">
                    {scopeIsLodge && pendingOverride[doc.key] ? (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          setPendingOverride((prev) => ({
                            ...prev,
                            [doc.key]: false,
                          }));
                          setDrafts((prev) => ({ ...prev, [doc.key]: "" }));
                        }}
                        disabled={savingKey !== null}
                      >
                        Cancel
                      </Button>
                    ) : null}
                    {scopeIsLodge && hasOverride[doc.key] ? (
                      <ViewOnlyActionButton
                        canEdit={canEdit}
                        describeReason={false}
                        type="button"
                        variant="outline"
                        onClick={() => removeOverride(doc.key, doc.title)}
                        disabled={savingKey !== null}
                      >
                        Remove override
                      </ViewOnlyActionButton>
                    ) : null}
                    <ViewOnlyActionButton
                      canEdit={canEdit}
                      describeReason={false}
                      type="button"
                      onClick={() => saveDocument(doc.key, doc.title)}
                      disabled={savingKey !== null}
                    >
                      <Save className="mr-2 h-4 w-4" />
                      {savingKey === doc.key
                        ? "Saving..."
                        : scopeIsLodge
                          ? "Save Override"
                          : `Save ${doc.title}`}
                    </ViewOnlyActionButton>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        );
      })}
      </div>
    </div>
  );
}
