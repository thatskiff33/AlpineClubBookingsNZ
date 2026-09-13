"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ADMIN_VIEW_ONLY_ACTION_REASON } from "@/hooks/use-admin-area-edit-access";
import type {
  BedAllocationRemovalCategory,
  BedAllocationRemovalPreview,
  BedAllocationRemovalScope,
} from "@/lib/bed-allocation-removal";
import { unverifiedWriteMessage } from "@/lib/unverified-write-copy";

const CATEGORY_OPTIONS: Array<{
  value: BedAllocationRemovalCategory;
  label: string;
  explanation: string;
}> = [
  {
    value: "AUTO_DRAFT",
    label: "Auto draft",
    explanation: "Automatic placements that have not been approved",
  },
  {
    value: "MANUAL_DRAFT",
    label: "Manual draft",
    explanation: "Manual placements that have not been approved",
  },
  {
    value: "APPROVED",
    label: "Approved",
    explanation: "Any approved placement, regardless of how it was created",
  },
];

export interface RemovalAllocationAnchor {
  allocationId: string;
  bookingId: string;
  bookingGuestId: string;
  lodgeId: string;
  stayDate: string;
}

export interface BedAllocationRemovalDialogAnchor {
  allocations: RemovalAllocationAnchor[];
  lodgeId: string;
  lodgeName?: string;
  window: { from: string; to: string };
  guestName?: string;
  initialScope: BedAllocationRemovalScope["type"];
  initialCategories: BedAllocationRemovalCategory[];
  allowWindow?: boolean;
}

interface UseBedAllocationRemovalDialogOptions {
  canEdit: boolean | undefined;
  onApplied: (result: { removedRowCount: number }) => void | Promise<void>;
}

function currentReturnFocusTarget() {
  const active =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  if (!active) return null;

  // Dropdown items are portalled and disappear as their menu closes. Radix
  // connects that transient item back to its stable trigger via aria-controls,
  // so retain the trigger when this dialog is opened from the allocation menu.
  const menu = active.closest<HTMLElement>('[role="menu"][id]');
  if (menu) {
    const trigger = [...document.querySelectorAll<HTMLElement>("[aria-controls]")]
      .find((candidate) => candidate.getAttribute("aria-controls") === menu.id);
    if (trigger) return trigger;
  }

  return active;
}

function focusConnectedTarget(target: HTMLElement | null) {
  if (!target?.isConnected) return false;
  const hadTabIndex = target.hasAttribute("tabindex");
  if (!hadTabIndex && target.tabIndex < 0) target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
  if (!hadTabIndex) target.removeAttribute("tabindex");
  return document.activeElement === target;
}

/**
 * Stable integration seam for the board, booking panel, and follow-on entry
 * points: every trigger calls the same `openRemovalDialog(anchor)` function.
 */
export function useBedAllocationRemovalDialog(
  options: UseBedAllocationRemovalDialogOptions,
) {
  const [anchor, setAnchor] = useState<BedAllocationRemovalDialogAnchor | null>(
    null,
  );
  const [open, setOpen] = useState(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const fallbackFocusRef = useRef<HTMLElement | null>(null);

  const openRemovalDialog = useCallback(
    (nextAnchor: BedAllocationRemovalDialogAnchor) => {
      const returnTarget = currentReturnFocusTarget();
      returnFocusRef.current = returnTarget;
      fallbackFocusRef.current =
        returnTarget?.closest<HTMLElement>(
          "section, [role='region'], main, [role='main']",
        ) ?? document.querySelector<HTMLElement>("main, [role='main']");
      setAnchor(nextAnchor);
      setOpen(true);
    },
    [],
  );

  const onOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      window.setTimeout(() => {
        if (focusConnectedTarget(returnFocusRef.current)) return;
        focusConnectedTarget(fallbackFocusRef.current);
      }, 0);
    }
  }, []);

  const dialog = (
    <BedAllocationRemovalDialog
      open={open}
      onOpenChange={onOpenChange}
      anchor={anchor}
      canEdit={options.canEdit}
      onApplied={options.onApplied}
    />
  );

  return { openRemovalDialog, dialog };
}

interface BedAllocationRemovalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchor: BedAllocationRemovalDialogAnchor | null;
  canEdit: boolean | undefined;
  onApplied: (result: { removedRowCount: number }) => void | Promise<void>;
}

function categoryForAnchor(
  source: "AUTO" | "MANUAL",
  approvedAt: string | null,
): BedAllocationRemovalCategory {
  if (approvedAt) return "APPROVED";
  return source === "AUTO" ? "AUTO_DRAFT" : "MANUAL_DRAFT";
}

export { categoryForAnchor as bedAllocationRemovalCategoryForAnchor };

async function readResponseError(response: Response, fallback: string) {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}

export function BedAllocationRemovalDialog({
  open,
  onOpenChange,
  anchor,
  canEdit,
  onApplied,
}: BedAllocationRemovalDialogProps) {
  const [scopeType, setScopeType] = useState<BedAllocationRemovalScope["type"]>(
    "WINDOW",
  );
  const [selectedNight, setSelectedNight] = useState("");
  const [categories, setCategories] = useState<BedAllocationRemovalCategory[]>(
    [],
  );
  const [preview, setPreview] = useState<BedAllocationRemovalPreview | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const previewAbortRef = useRef<AbortController | null>(null);
  const requestGenerationRef = useRef(0);
  const previewInFlightRef = useRef(false);
  const applyInFlightRef = useRef(false);

  const invalidatePreview = useCallback(() => {
    requestGenerationRef.current += 1;
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
    previewInFlightRef.current = false;
    setPreview(null);
    setError("");
    setStatus("");
    setLoading(false);
  }, []);

  useEffect(() => {
    requestGenerationRef.current += 1;
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
    previewInFlightRef.current = false;
    if (!open || !anchor) return;
    setScopeType(anchor.initialScope);
    const [onlyAllocation] = anchor.allocations;
    setSelectedNight(
      anchor.allocations.length === 1 && onlyAllocation
        ? onlyAllocation.stayDate
        : "",
    );
    setCategories(anchor.initialCategories);
    setPreview(null);
    setLoading(false);
    setApplying(applyInFlightRef.current);
    setError("");
    setStatus("");
  }, [anchor, open]);

  const sortedAllocations = useMemo(
    () =>
      [...(anchor?.allocations ?? [])].sort((a, b) =>
        a.stayDate.localeCompare(b.stayDate),
      ),
    [anchor],
  );

  function selectedScope(): BedAllocationRemovalScope | null {
    if (!anchor) return null;
    if (scopeType === "WINDOW") {
      return {
        type: "WINDOW",
        lodgeId: anchor.lodgeId,
        from: anchor.window.from,
        to: anchor.window.to,
      };
    }
    const selected =
      scopeType === "ALLOCATION"
        ? sortedAllocations.find(
            (allocation) => allocation.stayDate === selectedNight,
          )
        : sortedAllocations[0];
    if (!selected) return null;
    return { type: scopeType, ...selected } as BedAllocationRemovalScope;
  }

  function toggleCategory(category: BedAllocationRemovalCategory) {
    setCategories((current) =>
      current.includes(category)
        ? current.filter((value) => value !== category)
        : [...current, category],
    );
    invalidatePreview();
  }

  async function loadPreview() {
    const scope = selectedScope();
    if (!scope || categories.length === 0 || previewInFlightRef.current) return;
    previewInFlightRef.current = true;
    previewAbortRef.current?.abort();
    const controller = new AbortController();
    previewAbortRef.current = controller;
    const generation = ++requestGenerationRef.current;
    setLoading(true);
    setPreview(null);
    setError("");
    setStatus("Loading removal preview…");
    try {
      const response = await fetch(
        "/api/admin/bed-allocation/allocations/removal",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope, categories }),
          signal: controller.signal,
        },
      );
      if (generation !== requestGenerationRef.current || !open) return;
      if (!response.ok) {
        const message = await readResponseError(
          response,
          "Removal preview failed",
        );
        if (generation !== requestGenerationRef.current || !open) return;
        setError(message);
        setStatus("");
        return;
      }
      const nextPreview = (await response.json()) as BedAllocationRemovalPreview;
      if (generation !== requestGenerationRef.current || !open) return;
      setPreview(nextPreview);
      setStatus(
        nextPreview.matchedRowCount === 0
          ? "No allocations match the selected scope and categories."
          : `Preview ready: ${nextPreview.matchedRowCount} allocation${nextPreview.matchedRowCount === 1 ? "" : "s"} will be removed.`,
      );
    } catch {
      if (controller.signal.aborted || generation !== requestGenerationRef.current) {
        return;
      }
      setError("Removal preview failed");
      setStatus("");
    } finally {
      if (generation === requestGenerationRef.current) {
        previewInFlightRef.current = false;
        previewAbortRef.current = null;
        setLoading(false);
      }
    }
  }

  async function applyRemoval() {
    if (
      !preview ||
      preview.matchedRowCount === 0 ||
      !canEdit ||
      applyInFlightRef.current
    ) {
      return;
    }
    applyInFlightRef.current = true;
    const generation = requestGenerationRef.current;
    setApplying(true);
    setError("");
    setStatus("Applying reviewed removal…");
    try {
      const response = await fetch(
        "/api/admin/bed-allocation/allocations/removal",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scope: preview.scope,
            categories,
            previewDigest: preview.digest,
          }),
        },
      );
      if (response.status === 409) {
        const body = (await response.json()) as {
          error?: string;
          refreshedPreview?: BedAllocationRemovalPreview;
        };
        if (generation !== requestGenerationRef.current || !open) return;
        if (body.refreshedPreview) {
          setPreview(body.refreshedPreview);
          if (body.refreshedPreview.scope.type !== "WINDOW") {
            setSelectedNight(body.refreshedPreview.scope.stayDate);
          }
          setScopeType(body.refreshedPreview.scope.type);
          setError(
            body.error ??
              "Allocations changed after the preview. Review the refreshed result.",
          );
          setStatus("Preview refreshed; nothing was removed.");
        } else {
          setPreview(null);
          setError(
            body.error ??
              "The removal could not be applied. Load a new preview before trying again.",
          );
          setStatus(
            "Preview is no longer current; nothing was removed. Load a new preview before trying again.",
          );
        }
        return;
      }
      if (!response.ok) {
        if (generation !== requestGenerationRef.current || !open) return;
        const message = await readResponseError(response, "Removal failed");
        if (generation !== requestGenerationRef.current || !open) return;
        setError(message);
        setStatus("");
        return;
      }
      const result = (await response.json()) as { removedRowCount: number };
      try {
        await onApplied(result);
      } catch {
        // The reviewed removal already committed. A parent refresh failure must
        // not be reported as though the server rolled the removal back.
      }
      if (generation === requestGenerationRef.current && open) {
        setStatus(
          `${result.removedRowCount} allocation${result.removedRowCount === 1 ? "" : "s"} removed. No replacement allocation was run.`,
        );
        onOpenChange(false);
      }
    } catch {
      if (generation !== requestGenerationRef.current || !open) return;
      /*
        #2668. This used to say "nothing was removed", which is the same claim
        the `onApplied` catch a few lines above already refuses to make: a
        rejected `fetch` covers the PUT that ran and lost its answer as well as
        the PUT that never arrived. The two 409 paths above keep their confident
        wording because there the SERVER said nothing was removed. Retrying is
        safe either way — the apply is digest-guarded, so a preview the server
        has already consumed is refused rather than replayed — but the board on
        screen may now be stale, so send the admin at it.
      */
      setError(
        unverifiedWriteMessage(
          "the removal was applied",
          "Reload the board to see the current allocations before trying again.",
        ),
      );
      setStatus("");
    } finally {
      applyInFlightRef.current = false;
      setApplying(false);
    }
  }

  const needsNight = scopeType === "ALLOCATION" && !selectedNight;
  const canPreview = categories.length > 0 && !needsNight && !loading && !applying;
  const approvedSelected = categories.includes("APPROVED");

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && applying) return;
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Remove bed allocations</DialogTitle>
          <DialogDescription>
            Review the exact rows and consequences before anything is removed.
            This action never runs automatic allocation afterwards.
          </DialogDescription>
        </DialogHeader>

        {/* Permanently mounted live regions: only their content changes. */}
        <div role="alert" aria-live="assertive" className="min-h-0">
          {error ? (
            <Alert variant="error" role="presentation">
              {error}
            </Alert>
          ) : null}
        </div>
        <div role="status" aria-live="polite" className="min-h-0">
          {status ? <p className="text-sm text-muted-foreground">{status}</p> : null}
        </div>

        {canEdit === false ? (
          <Alert variant="info" title="View-only access">
            {ADMIN_VIEW_ONLY_ACTION_REASON}
          </Alert>
        ) : null}

        <div className="rounded-md border p-3 text-sm">
          <p>
            <strong>Lodge:</strong>{" "}
            {preview?.context.lodgeName ?? anchor?.lodgeName ?? anchor?.lodgeId}
          </p>
          <p>
            <strong>Visible window:</strong> {anchor?.window.from} to {anchor?.window.to}
          </p>
          {anchor?.guestName ? (
            <p>
              <strong>Person:</strong> {anchor.guestName}
            </p>
          ) : null}
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold">Removal scope</legend>
          {sortedAllocations.length > 0 ? (
            <Select
              value={scopeType}
              disabled={applying}
              onValueChange={(value) => {
                setScopeType(value as BedAllocationRemovalScope["type"]);
                invalidatePreview();
              }}
            >
              <SelectTrigger aria-label="Removal scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALLOCATION">This night only</SelectItem>
                <SelectItem value="BOOKING_GUEST">
                  This person on this booking, including off-screen nights
                </SelectItem>
                <SelectItem value="BOOKING">
                  Whole booking, including off-screen people and nights
                </SelectItem>
                {anchor?.allowWindow !== false ? (
                  <SelectItem value="WINDOW">
                    Selected lodge and visible window only
                  </SelectItem>
                ) : null}
              </SelectContent>
            </Select>
          ) : (
            <p className="text-sm">
              Selected lodge and visible window only. Off-screen nights are not
              included.
            </p>
          )}
        </fieldset>

        {scopeType === "ALLOCATION" && sortedAllocations.length > 1 ? (
          <div className="space-y-1">
            <Label htmlFor="removal-night">Night</Label>
            <Select
              value={selectedNight}
              disabled={applying}
              onValueChange={(value) => {
                setSelectedNight(value);
                invalidatePreview();
              }}
            >
              <SelectTrigger id="removal-night" aria-label="Removal night">
                <SelectValue placeholder="Choose the night explicitly" />
              </SelectTrigger>
              <SelectContent>
                {sortedAllocations.map((allocation) => (
                  <SelectItem
                    key={allocation.allocationId}
                    value={allocation.stayDate}
                  >
                    {allocation.stayDate}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}

        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold">
            Allocation categories (choose at least one)
          </legend>
          {CATEGORY_OPTIONS.map((option) => (
            <label key={option.value} className="flex items-start gap-3 text-sm">
              <Checkbox
                checked={categories.includes(option.value)}
                disabled={applying}
                onCheckedChange={() => toggleCategory(option.value)}
              />
              <span>
                <span className="font-medium">{option.label}</span>
                <span className="block text-muted-foreground">
                  {option.explanation}
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        {categories.length === 0 ? (
          <Alert variant="warning">Choose at least one category to preview.</Alert>
        ) : null}
        {approvedSelected ? (
          <Alert variant="error" title="Approved beds will be removed">
            This can remove the booking&apos;s final approved bed and re-open
            requested-room editing for the member.
          </Alert>
        ) : null}

        {preview ? (
          <div className="space-y-3 rounded-md border p-3 text-sm">
            <p className="font-semibold">
              {preview.matchedRowCount} matching allocation
              {preview.matchedRowCount === 1 ? "" : "s"} across {preview.affectedBookingCount}{" "}
              booking{preview.affectedBookingCount === 1 ? "" : "s"}
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>Auto draft: {preview.categories.AUTO_DRAFT}</li>
              <li>Manual draft: {preview.categories.MANUAL_DRAFT}</li>
              <li>Approved: {preview.categories.APPROVED}</li>
              <li>
                Nights: {preview.affectedNights.length > 0 ? preview.affectedNights.join(", ") : "none"}
              </li>
              <li>
                Shared-double promotions: {preview.promotions.length}
              </li>
            </ul>
            {preview.promotions.length > 0 ? (
              <Alert variant="info" title="Shared double-bed occupants promoted">
                <ul className="list-disc pl-5">
                  {preview.promotions.map((promotion) => (
                    <li key={promotion.allocationId}>
                      {promotion.guestName} · {promotion.roomName} / {promotion.bedName} · {promotion.stayDate}
                    </li>
                  ))}
                </ul>
              </Alert>
            ) : null}
            {preview.reopenedBookings.length > 0 ? (
              <Alert variant="warning" title="Requested-room editing will re-open">
                The final approved allocation will be removed for:{" "}
                {preview.reopenedBookings
                  .map((booking) => `${booking.memberName} (${booking.bookingId})`)
                  .join(", ")}.
              </Alert>
            ) : null}
            <p className="text-muted-foreground">
              No replacement or automatic allocation will run after removal.
            </p>
          </div>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={applying}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => void loadPreview()}
            disabled={!canPreview}
          >
            {loading ? "Loading preview…" : "Preview removal"}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => void applyRemoval()}
            disabled={
              !canEdit ||
              applying ||
              !preview ||
              preview.matchedRowCount === 0
            }
            title={canEdit === false ? ADMIN_VIEW_ONLY_ACTION_REASON : undefined}
          >
            {applying ? "Removing…" : "Remove reviewed allocations"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
