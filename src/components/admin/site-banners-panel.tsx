"use client";

import { useCallback, useEffect, useState } from "react";
import { Info, Pencil, Plus, Trash2, TriangleAlert, X } from "lucide-react";
import { toast } from "sonner";
import { useConfirm } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldHint, useFieldHint } from "@/components/ui/field-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  SITE_BANNER_MESSAGE_MAX_LENGTH,
  SITE_BANNER_PRIORITIES,
  SITE_BANNER_PRIORITY_CLASSES,
  SITE_BANNER_PRIORITY_LABELS,
  type SiteBannerPriorityValue,
} from "@/lib/site-banner-shared";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  AdminForbiddenSaveNotice,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { formatClubDate, parseCalendarDate } from "@/lib/club-time";

type ApiBanner = {
  id: string;
  message: string;
  priority: SiteBannerPriorityValue;
  startDate: string;
  endDate: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

type ApiGroups = {
  current: ApiBanner[];
  upcoming: ApiBanner[];
  past: ApiBanner[];
};

type FormState = {
  message: string;
  priority: SiteBannerPriorityValue;
  startDate: string;
  endDate: string;
  active: boolean;
};

const EMPTY_FORM: FormState = {
  message: "",
  priority: "NOTIFY",
  startDate: "",
  endDate: "",
  active: true,
};

const GROUPS = [
  {
    key: "current",
    title: "Current",
    description: "Displaying on the site now (while active).",
    emptyLabel: "No current banners.",
  },
  {
    key: "upcoming",
    title: "Upcoming",
    description: "Scheduled to display in the future.",
    emptyLabel: "No upcoming banners.",
  },
  {
    key: "past",
    title: "Past",
    description: "Display window has ended (most recent 50).",
    emptyLabel: "No past banners.",
  },
] as const;

/**
 * A banner's display window is a CALENDAR DAY, e.g. "5 Jul 2026", and takes no
 * timezone at all (CT-4, #2870; INV-DATE-010).
 *
 * THE COMMENT THIS REPLACES SAID THE QUIET PART: "the value is pinned to UTC
 * midnight, and NZ is UTC+12/+13, so reading it back in club time lands on the
 * same calendar day". That reasoning holds only while the club is east of
 * Greenwich. The kernel's calendar-date formatter pins UTC over the same
 * encoding, which is the identity for EVERY club, so the rendered string is
 * unchanged here and correct for a club the old argument did not cover.
 */
function formatDateOnly(value: string): string {
  const day = parseCalendarDate(value);
  if (day === null) {
    return value;
  }
  return formatClubDate(day);
}

function excerpt(message: string, maxLength = 160): string {
  const singleLine = message.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxLength - 3).trimEnd()}...`;
}

// Mirrors the public SiteBanners bar styling so admins preview exactly what
// visitors will see (without the functional dismiss behaviour).
function BannerPreview({
  message,
  priority,
}: {
  message: string;
  priority: SiteBannerPriorityValue;
}) {
  const PriorityIcon = priority === "NOTIFY" ? Info : TriangleAlert;
  return (
    <div
      className={`w-full rounded-md border ${SITE_BANNER_PRIORITY_CLASSES[priority]}`}
    >
      <div className="flex w-full items-start gap-3 px-4 py-3">
        <PriorityIcon aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0" />
        <p className="flex-1 self-center whitespace-pre-line text-sm font-medium">
          {message.trim() === "" ? "Your message will appear here." : message}
        </p>
        <span
          aria-hidden="true"
          className="-my-2 -mr-2 flex h-11 w-11 shrink-0 items-center justify-center"
        >
          <X className="h-5 w-5" />
        </span>
      </div>
    </div>
  );
}

export function SiteBannersPanel() {
  const canEdit = useAdminAreaEditAccess("content");
  const [groups, setGroups] = useState<ApiGroups | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  // #2257 — the example lives UNDER the field, not inside it as grey pseudo-content.
  const messageHint = useFieldHint();
  const [saving, setSaving] = useState(false);
  const [busyBannerId, setBusyBannerId] = useState<string | null>(null);
  const { confirm, confirmDialog } = useConfirm();

  const loadBanners = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/admin/site-banners", {
        credentials: "same-origin",
      });
      if (!res.ok) {
        throw new Error("load-failed");
      }
      setGroups((await res.json()) as ApiGroups);
    } catch {
      setLoadError("Failed to load site banners. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadBanners();
  }, [loadBanners]);

  function openCreateDialog() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  }

  function openEditDialog(banner: ApiBanner) {
    setEditingId(banner.id);
    setForm({
      message: banner.message,
      priority: banner.priority,
      startDate: banner.startDate,
      endDate: banner.endDate,
      active: banner.active,
    });
    setDialogOpen(true);
  }

  async function saveBanner() {
    if (form.message.trim() === "") {
      toast.error("Message is required");
      return;
    }
    if (!form.startDate || !form.endDate) {
      toast.error("Both display dates are required");
      return;
    }
    if (form.endDate < form.startDate) {
      toast.error("End date must be on or after the start date");
      return;
    }

    setSaving(true);
    setForbidden(false);
    try {
      const url = editingId
        ? `/api/admin/site-banners/${editingId}`
        : "/api/admin/site-banners";
      const res = await fetch(url, {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          message: form.message.trim(),
          priority: form.priority,
          startDate: form.startDate,
          endDate: form.endDate,
          active: form.active,
        }),
      });
      if (!res.ok) {
        if (res.status === 403) setForbidden(true);
        const body = await res.json().catch(() => null);
        toast.error(body?.error ?? "Failed to save banner");
        return;
      }
      toast.success(editingId ? "Banner updated" : "Banner created");
      setDialogOpen(false);
      await loadBanners();
    } catch {
      toast.error("Failed to save banner");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(banner: ApiBanner) {
    setBusyBannerId(banner.id);
    setForbidden(false);
    try {
      const res = await fetch(`/api/admin/site-banners/${banner.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ active: !banner.active }),
      });
      if (!res.ok) {
        if (res.status === 403) setForbidden(true);
        const body = await res.json().catch(() => null);
        toast.error(body?.error ?? "Failed to update banner");
        return;
      }
      toast.success(!banner.active ? "Banner activated" : "Banner deactivated");
      await loadBanners();
    } catch {
      toast.error("Failed to update banner");
    } finally {
      setBusyBannerId(null);
    }
  }

  async function deleteBanner(banner: ApiBanner) {
    if (
      !(await confirm({
        title: "Delete this banner?",
        description: "This cannot be undone.",
        confirmLabel: "Delete",
        destructive: true,
      }))
    ) {
      return;
    }
    setBusyBannerId(banner.id);
    setForbidden(false);
    try {
      const res = await fetch(`/api/admin/site-banners/${banner.id}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!res.ok) {
        if (res.status === 403) setForbidden(true);
        const body = await res.json().catch(() => null);
        toast.error(body?.error ?? "Failed to delete banner");
        return;
      }
      toast.success("Banner deleted");
      await loadBanners();
    } catch {
      toast.error("Failed to delete banner");
    } finally {
      setBusyBannerId(null);
    }
  }

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It is rendered in EVERY return branch,
    including the loading one, and sits OUTSIDE the `space-y-*` stack so the
    empty wrapper an edit-capable admin gets costs no layout. The Save button
    inside the add/edit Dialog keeps its own per-button reason: a dialog is a
    separate accessibility container this banner does not cover.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view site banners but cannot change them.
    </AdminViewOnlySectionBanner>
  );

  if (loading) {
    return (
      <div>
        {viewOnlyBanner}
        <p className="text-sm text-muted-foreground">Loading site banners...</p>
      </div>
    );
  }

  if (loadError || !groups) {
    return (
      <div>
        {viewOnlyBanner}
        <div className="space-y-3">
          <p className="text-sm text-danger-11">
            {loadError ?? "Failed to load site banners. Please try again."}
          </p>
          <Button type="button" variant="outline" onClick={loadBanners}>
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
      {confirmDialog}
      {forbidden ? <AdminForbiddenSaveNotice /> : null}
      <div className="flex justify-end">
        <ViewOnlyActionButton
          canEdit={canEdit}
          describeReason={false}
          type="button"
          onClick={openCreateDialog}
        >
          <Plus className="mr-2 h-4 w-4" />
          Add banner
        </ViewOnlyActionButton>
      </div>

      {GROUPS.map((group) => {
        const banners = groups[group.key];
        return (
          <Card key={group.key}>
            <CardHeader>
              <CardTitle>{group.title}</CardTitle>
              <CardDescription>{group.description}</CardDescription>
            </CardHeader>
            <CardContent>
              {banners.length === 0 ? (
                <p className="text-sm text-muted-foreground">{group.emptyLabel}</p>
              ) : (
                <ul className="space-y-3">
                  {banners.map((banner) => (
                    <li
                      key={banner.id}
                      className="flex flex-col gap-3 rounded-md border border-border p-3 sm:flex-row sm:items-center"
                    >
                      <div className="flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge
                            variant="outline"
                            className={
                              SITE_BANNER_PRIORITY_CLASSES[banner.priority]
                            }
                          >
                            {SITE_BANNER_PRIORITY_LABELS[banner.priority]}
                          </Badge>
                          {!banner.active && (
                            <Badge variant="outline" className="text-muted-foreground">
                              Inactive
                            </Badge>
                          )}
                          <span className="text-xs text-muted-foreground">
                            {formatDateOnly(banner.startDate)} -{" "}
                            {formatDateOnly(banner.endDate)}
                          </span>
                        </div>
                        <p className="text-sm text-foreground">
                          {excerpt(banner.message)}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <ViewOnlyActionButton
                          canEdit={canEdit}
                          describeReason={false}
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busyBannerId !== null}
                          onClick={() => toggleActive(banner)}
                        >
                          {banner.active ? "Deactivate" : "Activate"}
                        </ViewOnlyActionButton>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busyBannerId !== null}
                          onClick={() => openEditDialog(banner)}
                        >
                          <Pencil className="mr-1 h-4 w-4" />
                          {canEdit ? "Edit" : "View"}
                        </Button>
                        <ViewOnlyActionButton
                          canEdit={canEdit}
                          describeReason={false}
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busyBannerId !== null}
                          onClick={() => deleteBanner(banner)}
                        >
                          <Trash2 className="mr-1 h-4 w-4" />
                          Delete
                        </ViewOnlyActionButton>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        );
      })}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit banner" : "Add banner"}</DialogTitle>
            <DialogDescription>
              The banner displays above the site header for every visitor while
              today falls inside the display window.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="site-banner-message">Message</Label>
              <Textarea
                id="site-banner-message"
                value={form.message}
                maxLength={SITE_BANNER_MESSAGE_MAX_LENGTH}
                rows={3}
                readOnly={!canEdit}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, message: event.target.value }))
                }
                {...messageHint.fieldProps}
              />
              <FieldHint {...messageHint.hintProps}>
                Example: The mountain is closed due to volcanic activity.
              </FieldHint>
              <p className="text-right text-xs text-muted-foreground">
                {form.message.length}/{SITE_BANNER_MESSAGE_MAX_LENGTH}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="site-banner-priority">Priority</Label>
              <Select
                value={form.priority}
                disabled={!canEdit}
                onValueChange={(value) =>
                  setForm((prev) => ({
                    ...prev,
                    priority: value as SiteBannerPriorityValue,
                  }))
                }
              >
                <SelectTrigger id="site-banner-priority">
                  <SelectValue placeholder="Select a priority" />
                </SelectTrigger>
                <SelectContent>
                  {SITE_BANNER_PRIORITIES.map((priority) => (
                    <SelectItem key={priority} value={priority}>
                      {SITE_BANNER_PRIORITY_LABELS[priority]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="site-banner-start-date">Display from</Label>
                <Input
                  id="site-banner-start-date"
                  type="date"
                  value={form.startDate}
                  readOnly={!canEdit}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      startDate: event.target.value,
                    }))
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="site-banner-end-date">Display to</Label>
                <Input
                  id="site-banner-end-date"
                  type="date"
                  value={form.endDate}
                  readOnly={!canEdit}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      endDate: event.target.value,
                    }))
                  }
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Checkbox
                id="site-banner-active"
                checked={form.active}
                disabled={!canEdit}
                onCheckedChange={(checked) =>
                  setForm((prev) => ({ ...prev, active: checked === true }))
                }
              />
              <Label htmlFor="site-banner-active">Active</Label>
            </div>

            <div className="space-y-1.5">
              <Label>Preview</Label>
              <BannerPreview message={form.message} priority={form.priority} />
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => setDialogOpen(false)}
            >
              Cancel
            </Button>
            <ViewOnlyActionButton
              canEdit={canEdit}
              type="button"
              disabled={saving}
              onClick={saveBanner}
            >
              {saving
                ? "Saving..."
                : editingId
                  ? "Save changes"
                  : "Create banner"}
            </ViewOnlyActionButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </div>
    </div>
  );
}
