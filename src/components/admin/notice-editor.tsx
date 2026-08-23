"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Save, Send, Archive } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  WysiwygEditor,
  type WysiwygEditorHandle,
} from "@/components/admin/page-content-panel";
import {
  AdminForbiddenSaveNotice,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { useClubTime } from "@/components/club-time-provider";
import { parseCalendarDate } from "@/lib/club-time";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  NOTICE_BODY_MAX_LENGTH,
  NOTICE_TITLE_MAX_LENGTH,
} from "@/lib/notices-shared";
import {
  NoticeAudiencePicker,
  type Audience,
  type InitialAudience,
} from "@/components/admin/notice-audience-picker";

// Notice status literals (mirror the Prisma enum without importing server code).
export type NoticeStatusValue = "DRAFT" | "PUBLISHED" | "ARCHIVED";

// The audience/notice shapes the admin API returns; redeclared locally so this
// client component pulls in no server-only code (the source types live in the
// server-only `@/lib/notices-admin` module).
export type AdminNoticeAudience = InitialAudience & { id: string };

export type AdminNoticeData = {
  id: string;
  title: string;
  status: NoticeStatusValue;
  /** Full sanitised stored body. Present from the GET-by-id detail endpoint;
   *  absent from the grouped list payload. */
  bodyHtml?: string;
  publishedAt: string | null;
  expiresAt: string | null;
  pinned: boolean;
  requiresAcknowledgement: boolean;
  financialMembersOnly: boolean;
  emailedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdByName: string | null;
  audiences: AdminNoticeAudience[];
  audienceCount: number;
  readCount: number;
  acknowledgedCount: number;
};

interface NoticeEditorProps {
  mode: "create" | "edit";
  /** Existing notice data — required in edit mode. */
  notice?: AdminNoticeData;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * The notice-expiry field, read and written in CLUB WALL TIME (CT-4, #2870;
 * epic #2988 rule 4; INV-CONFIG-002).
 *
 * WHAT THIS REPLACES USED THE BROWSER'S CLOCK IN BOTH DIRECTIONS.
 * `d.getHours()` filled the `datetime-local` control from the ADMIN's zone and
 * `new Date(value).toISOString()` parsed it back the same way, so an officer in
 * London who typed 5pm stored 5pm London - 4am the next day at a New Zealand
 * club - and an officer who then opened the same notice at the lodge saw a
 * different time from the one their colleague had typed. A club expiry means
 * five o'clock at the CLUB.
 *
 * The round trip is exact: `wallTimeOf` reads the instant's club-local clock
 * face, and `atWallTime` turns a club-local clock face back into the instant.
 *
 * `nextExistingInstant` FOR A SKIPPED TIME, deliberately. On the morning a zone
 * springs forward some wall times do not exist (`INV-DATE-025`), and the
 * kernel's default is to throw - right for a job definition, wrong for a form,
 * where it would blank the page instead of saving. The transition instant is the
 * honest answer for "as soon as that time would have arrived".
 */
function useNoticeExpiryField() {
  const clubTime = useClubTime();
  return {
    /**
     * The club's zone, NAMED ON SCREEN beside the field.
     *
     * A `datetime-local` control is the one input in this tree that presents
     * itself as the reader's own clock: the browser labels it that way, there is
     * no zone in the widget, and every other date field here is a calendar day
     * with no time at all. So an officer in London types 5pm meaning 5pm, and
     * what is stored is 5pm at the club. That is the correct behaviour — a club
     * expiry means five o'clock at the club — but silence about it is how a
     * correct behaviour reads as a bug.
     */
    zone: clubTime.zone,
    toInput(iso: string | null): string {
      if (!iso) return "";
      const instant = new Date(iso);
      if (Number.isNaN(instant.getTime())) return "";
      const wall = clubTime.wallTimeOf(instant);
      return `${wall.date}T${pad2(wall.hour)}:${pad2(wall.minute)}`;
    },
    toIso(value: string): string | null {
      const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(value);
      if (!match) return null;
      const day = parseCalendarDate(match[1]);
      if (day === null) return null;
      return clubTime
        .atWallTime(
          day,
          { hour: Number(match[2]), minute: Number(match[3]) },
          { skipped: "nextExistingInstant" },
        )
        .toISOString();
    },
  };
}

export function NoticeEditor({ mode, notice }: NoticeEditorProps) {
  const expiryField = useNoticeExpiryField();
  const router = useRouter();
  const canEdit = useAdminAreaEditAccess("membership");

  const [title, setTitle] = useState(notice?.title ?? "");
  // The GET-by-id detail endpoint supplies the full stored body, so edit mode
  // prefills the editor and round-trips it; every save sends the current body.
  const [bodyHtml, setBodyHtml] = useState(notice?.bodyHtml ?? "");
  const [pinned, setPinned] = useState(notice?.pinned ?? false);
  const [requiresAcknowledgement, setRequiresAcknowledgement] = useState(
    notice?.requiresAcknowledgement ?? false,
  );
  const [financialMembersOnly, setFinancialMembersOnly] = useState(
    notice?.financialMembersOnly ?? false,
  );
  const [expiresInput, setExpiresInput] = useState(
    expiryField.toInput(notice?.expiresAt ?? null),
  );
  const [audiences, setAudiences] = useState<Audience[]>(
    notice?.audiences?.some((a) => a.kind === "ALL_MEMBERS") ||
      !notice ||
      notice.audiences.length === 0
      ? [{ kind: "ALL_MEMBERS" }]
      : [],
  );

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [showValidation, setShowValidation] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [emailOnPublish, setEmailOnPublish] = useState(false);

  const editorRef = useRef<WysiwygEditorHandle | null>(null);

  const status = notice?.status ?? "DRAFT";
  const trimmedTitle = title.trim();
  const titleTooLong = title.length > NOTICE_TITLE_MAX_LENGTH;

  function validate(): string | null {
    setShowValidation(true);
    if (!trimmedTitle) return "A title is required.";
    if (titleTooLong) {
      return `Title must be ${NOTICE_TITLE_MAX_LENGTH} characters or fewer.`;
    }
    if (audiences.length === 0) {
      return "Choose an audience: select at least one group or member, or choose Everyone.";
    }
    const html = editorRef.current?.getHtml() ?? bodyHtml;
    if (html.length > NOTICE_BODY_MAX_LENGTH) {
      return `The notice body is too long (limit ${NOTICE_BODY_MAX_LENGTH.toLocaleString()} characters).`;
    }
    // Emptiness check only — never a sanitiser (the server sanitises on save
    // and render). DOMParser avoids the regex tag-stripping pattern CodeQL
    // flags and handles entities correctly.
    const textContent =
      new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";
    if (textContent.trim().length === 0) {
      return "A notice body is required.";
    }
    return null;
  }

  async function submit(
    statusOverride: NoticeStatusValue | undefined,
    sendEmail: boolean,
  ) {
    if (canEdit !== true) return;
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setForbidden(false);
    setSaving(true);

    const html = editorRef.current?.getHtml() ?? bodyHtml;
    const payload: Record<string, unknown> = {
      title: trimmedTitle,
      pinned,
      requiresAcknowledgement,
      financialMembersOnly,
      expiresAt: expiryField.toIso(expiresInput),
      audiences,
    };
    payload.bodyHtml = html;
    if (statusOverride) {
      payload.status = statusOverride;
    }
    if (sendEmail) {
      payload.sendEmail = true;
    }

    try {
      const url =
        mode === "create"
          ? "/api/admin/notices"
          : `/api/admin/notices/${notice?.id}`;
      const res = await fetch(url, {
        method: mode === "create" ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        if (res.status === 403) {
          setForbidden(true);
        }
        const data = await res.json().catch(() => null);
        setError(data?.error ?? "Failed to save the notice. Please try again.");
        return;
      }
      router.push("/admin/notices");
      router.refresh();
    } catch {
      setError("Failed to save the notice. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  function confirmPublish() {
    setPublishOpen(false);
    void submit("PUBLISHED", emailOnPublish);
  }

  const saveLabel =
    mode === "create" || status === "DRAFT" ? "Save draft" : "Save changes";
  // "Save draft" writes DRAFT; "Save changes" preserves the current status.
  const saveStatus: NoticeStatusValue | undefined =
    mode === "create" || status === "DRAFT" ? "DRAFT" : undefined;
  const canPublish = mode === "create" || status !== "PUBLISHED";
  const canArchive = mode === "edit" && status === "PUBLISHED";

  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view member notices but cannot create or change them.
    </AdminViewOnlySectionBanner>
  );

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-6">
        {forbidden ? <AdminForbiddenSaveNotice /> : null}

        <Card>
          <CardHeader>
            <CardTitle>
              {mode === "create" ? "New notice" : "Edit notice"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div>
              <Label htmlFor="notice-title">Title</Label>
              <Input
                id="notice-title"
                value={title}
                disabled={canEdit !== true}
                maxLength={NOTICE_TITLE_MAX_LENGTH}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Notice title"
                required
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {title.length}/{NOTICE_TITLE_MAX_LENGTH} characters
              </p>
              {showValidation && !trimmedTitle ? (
                <p className="mt-1 text-sm text-danger-11">
                  A title is required.
                </p>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label>Body</Label>
              <WysiwygEditor
                ref={editorRef}
                value={bodyHtml}
                onChange={(html) => setBodyHtml(html)}
                placeholder="Write the notice..."
                readOnly={canEdit !== true}
                resolvingAccess={canEdit === undefined}
              />
            </div>

            <NoticeAudiencePicker
              initialAudiences={notice?.audiences}
              onChange={setAudiences}
              canEdit={canEdit}
              showValidation={showValidation}
            />

            <fieldset className="space-y-3">
              <legend className="text-sm font-medium">Options</legend>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={pinned}
                  disabled={canEdit !== true}
                  onCheckedChange={(v) => setPinned(v)}
                />
                <span>Pin to the top of the notices list</span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={requiresAcknowledgement}
                  disabled={canEdit !== true}
                  onCheckedChange={(v) => setRequiresAcknowledgement(v)}
                />
                <span>Require members to acknowledge this notice</span>
              </label>
              <div className="space-y-1">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={financialMembersOnly}
                    disabled={canEdit !== true}
                    onCheckedChange={(v) => setFinancialMembersOnly(v)}
                  />
                  <span>Financial members only</span>
                </label>
                <p className="pl-6 text-xs text-muted-foreground">
                  Only paid-up or exempt members will see this when matched by a
                  group audience. Members targeted individually always see it.
                </p>
              </div>
            </fieldset>

            <div>
              <Label htmlFor="notice-expiry">Expiry (optional)</Label>
              <Input
                id="notice-expiry"
                type="datetime-local"
                value={expiresInput}
                disabled={canEdit !== true}
                onChange={(e) => setExpiresInput(e.target.value)}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Times here are the club&apos;s ({expiryField.zone}), not your
                own. After this time the notice is hidden from members. Leave
                blank for no expiry.
              </p>
            </div>

            {error ? (
              <div className="rounded-md border border-danger-6 bg-danger-3 p-3 text-sm text-danger-11">
                {error}
              </div>
            ) : null}

            <div className="flex flex-wrap items-center justify-end gap-3">
              <Button
                type="button"
                variant="ghost"
                onClick={() => router.push("/admin/notices")}
                disabled={saving}
              >
                Cancel
              </Button>
              {canArchive ? (
                <ViewOnlyActionButton
                  canEdit={canEdit}
                  describeReason={false}
                  type="button"
                  variant="outline"
                  disabled={saving}
                  onClick={() => submit("ARCHIVED", false)}
                >
                  <Archive className="mr-2 h-4 w-4" />
                  Archive
                </ViewOnlyActionButton>
              ) : null}
              <ViewOnlyActionButton
                canEdit={canEdit}
                describeReason={false}
                type="button"
                variant="outline"
                disabled={saving}
                onClick={() => submit(saveStatus, false)}
              >
                <Save className="mr-2 h-4 w-4" />
                {saving ? "Saving..." : saveLabel}
              </ViewOnlyActionButton>
              {canPublish ? (
                <ViewOnlyActionButton
                  canEdit={canEdit}
                  describeReason={false}
                  type="button"
                  disabled={saving}
                  onClick={() => {
                    setEmailOnPublish(false);
                    setPublishOpen(true);
                  }}
                >
                  <Send className="mr-2 h-4 w-4" />
                  Publish
                </ViewOnlyActionButton>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </div>

      <Dialog open={publishOpen} onOpenChange={setPublishOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Publish this notice?</DialogTitle>
            <DialogDescription>
              Published notices become visible to their audience immediately.
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={emailOnPublish}
              onCheckedChange={(v) => setEmailOnPublish(v)}
            />
            <span>
              Also email this notice to the audience. Leave off to publish
              without sending email.
            </span>
          </label>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPublishOpen(false)}
            >
              Cancel
            </Button>
            <Button type="button" onClick={confirmPublish} disabled={saving}>
              <Send className="mr-2 h-4 w-4" />
              Publish
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
