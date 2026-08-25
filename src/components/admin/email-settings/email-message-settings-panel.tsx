"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { Eye, GitCompareArrows, RotateCcw, Save } from "lucide-react";
import { EmailBodyRichEditor } from "@/components/admin/email-settings/email-body-rich-editor";
import { plainTextToEmailBodyHtml } from "@/lib/email-body-html";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TokenChips } from "@/components/admin/token-help-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  diffLines,
  isSameText,
  markInvisibleCharacters,
} from "@/lib/text-diff";
import { useConfirm } from "@/components/confirm-dialog";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  AdminForbiddenSaveNotice,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";

// Lodge identity (lodge name, travel note, door code) is no longer edited here;
// it comes from each lodge's own settings (Admin → Lodges).
interface EmailSettings {
  clubName: string;
  bookingsName: string;
  emailFromName: string;
  supportEmail: string;
  contactEmail: string;
  publicUrl: string;
}

interface TemplateOverride {
  subject: string | null;
  bodyText: string | null;
  // Fork #38: the rich-editor body; null on rows saved before the feature.
  bodyHtml?: string | null;
  updatedAt: string | null;
  updatedByMemberId: string | null;
}

// #2269 (F3): how the saved override stands against the CURRENT built-in
// wording. `differsFromDefault` is a plain fact, not a warning — differing is
// what an override is for — and drives the diff affordance. `reasons` is the
// short list of things that are objectively wrong, each one a rule the save
// path already enforces, so an admin is never told "you have drifted" for
// wording they chose on purpose.
interface TemplateStaleContent {
  differsFromDefault: boolean;
  subjectDiffersFromDefault: boolean;
  bodyDiffersFromDefault: boolean;
  reasons: string[];
  missingRequiredTokens: string[];
  retiredTokens: string[];
  bracketAnnotations: string[];
  // Lines of the saved copy that render as a bare label when a token the
  // sender can legitimately supply empty comes back empty (#2269).
  danglingLines?: string[];
  // #2269 (second review): the built-in authoring notes the upgrade removed
  // from THIS saved copy, and the lines they were marking as conditional.
  // Read off the upgrade's own audit record, because the note was the marker
  // and removing it is what left the line with no signal at all. Optional
  // because older fixtures/responses omit them.
  strippedAnnotations?: string[];
  unconditionalLines?: string[];
}

interface TemplateDefinition {
  key: string;
  label: string;
  audience: string;
  defaultSubject: string;
  defaultBody: string;
  allowedTokens: string[];
  requiredTokens: string[];
  // Per required token, the other tokens that satisfy the same requirement
  // (#2267). Optional here because the older fixtures/responses omit it.
  requiredTokenAlternatives?: Record<string, string[]>;
  triggerSummary: string;
  frequency: string;
  override: TemplateOverride | null;
  // Optional because older fixtures/responses omit it, and null whenever the
  // template has no saved override at all.
  staleContent?: TemplateStaleContent | null;
}

const settingFields: Array<{
  key: keyof EmailSettings;
  label: string;
  multiline?: boolean;
}> = [
  { key: "clubName", label: "Club name" },
  { key: "bookingsName", label: "Bookings name" },
  { key: "emailFromName", label: "Sender display name" },
  { key: "supportEmail", label: "Support email" },
  { key: "contactEmail", label: "Contact email" },
  { key: "publicUrl", label: "Public URL" },
];

// The template write/preview routes reject an invalid body with a generic
// "Invalid email template" plus a list of specific issues. Showing only the
// generic line left an admin guessing what to change (#2267), so join the
// explanations onto it — every rule the server enforces already carries a
// plain-English message.
function templateErrorMessage(responseBody: unknown, fallback: string): string {
  const body = responseBody as
    | { error?: string; issues?: Array<{ message?: string }> }
    | null
    | undefined;
  const headline = body?.error ?? fallback;
  const details = Array.isArray(body?.issues)
    ? Array.from(
        new Set(
          body.issues
            .map((issue) => issue?.message)
            .filter((message): message is string => Boolean(message)),
        ),
      )
    : [];
  return details.length > 0 ? `${headline}: ${details.join("; ")}` : headline;
}

// A filled chip is the only hint that a token is required, and it says nothing
// about the tokens that satisfy the same requirement instead (#2267). Spell the
// rule out under the chips so an admin learns it while editing, not from a
// rejected save.
export function requiredTokenSentence(
  template: {
    requiredTokens: string[];
    requiredTokenAlternatives?: Record<string, string[]>;
  } | null,
): string | null {
  const required = template?.requiredTokens ?? [];
  if (required.length === 0) return null;
  const parts = required.map((token) => {
    const alternatives = template?.requiredTokenAlternatives?.[token] ?? [];
    if (alternatives.length === 0) return `{{${token}}}`;
    const alternativeText = alternatives
      .map((alternative) => `{{${alternative}}}`)
      .join(" or ");
    return `{{${token}}} (or ${alternativeText})`;
  });
  return `Keep these in the body: ${parts.join(", ")}.`;
}

// #2269 review: the banners named templates by their registry key
// ("booking-confirmed") when the human label an admin actually sees in the
// picker ("Booking Confirmed") is already in the same payload. Falls back to
// the key for a STALE override — a row whose template no longer exists has no
// label, and the key is the only thing an operator can act on.
// Fork #38: what the rich editor should hold for a template — the saved rich
// body verbatim, or the lossless paragraph upgrade of the saved plain text /
// built-in default. Pure, so the dirty check and the load paths agree.
function editorHtmlFor(template: TemplateDefinition): string {
  if (template.override?.bodyHtml) return template.override.bodyHtml;
  return plainTextToEmailBodyHtml(
    template.override?.bodyText ?? template.defaultBody,
  );
}

function templateLabel(
  templates: TemplateDefinition[],
  templateName: string,
): string {
  return (
    templates.find((template) => template.key === templateName)?.label ??
    templateName
  );
}

// #2269 (F3): the reasons, in plain English, for the admin looking at the
// template they have open. Each one is a rule the save path enforces, so the
// wording here and the wording of a rejected save describe the same thing.
function staleContentSentences(
  staleContent: TemplateStaleContent | null | undefined,
): string[] {
  if (!staleContent) return [];
  const sentences: string[] = [];
  if (staleContent.missingRequiredTokens.length > 0) {
    sentences.push(
      `Your saved copy no longer shows something this email is required to tell the recipient. Add back ${staleContent.missingRequiredTokens
        .map((token) => `{{${token}}}`)
        .join(", ")} — or wording of your own that says the same thing — or restore the default below.`,
    );
  }
  if (staleContent.retiredTokens.length > 0) {
    sentences.push(
      `Your saved copy uses ${staleContent.retiredTokens
        .map((token) => `{{${token}}}`)
        .join(", ")}, which this template no longer supplies. An unsupplied token renders as nothing at all, so the line it sits on can go out empty.`,
    );
  }
  if (staleContent.bracketAnnotations.length > 0) {
    sentences.push(
      `Your saved copy still contains square-bracketed notes (${staleContent.bracketAnnotations.join(
        ", ",
      )}). Emails render tokens and nothing else, so these are sent to the recipient word for word.`,
    );
  }
  if ((staleContent.strippedAnnotations ?? []).length > 0) {
    const lines = staleContent.unconditionalLines ?? [];
    sentences.push(
      `An upgrade removed ${(staleContent.strippedAnnotations ?? [])
        .map((annotation) => `“${annotation}”`)
        .join(
          ", ",
        )} from your saved copy. Those were our own notes, never understood by anything, and they were being emailed to recipients word for word.${
        lines.length > 0
          ? ` They were also the only thing marking these lines as conditional, so please check each one still reads correctly on every send — they now go out every time: ${lines
              .map((line) => `“${line}”`)
              .join(", ")}.`
          : ""
      } Press Save Template when you are happy with the wording — that clears this note, whether or not you change anything.`,
    );
  }
  if ((staleContent.danglingLines ?? []).length > 0) {
    sentences.push(
      `Some lines of your saved copy go out with nothing after the label when the value behind them is empty — for example a booking with no promo code, or one where payment is still owing. With those values empty they read: ${(
        staleContent.danglingLines ?? []
      )
        .map((line) => `“${line}”`)
        .join(
          ", ",
        )}. A “Discount” line on a booking whose price a promo code RAISED is the same fault that caused issue #2267. Either delete these lines or replace them with the pre-composed token for this message, which renders the whole line or nothing at all. This check is deliberately cautious: it empties every such value at once, so a line combining two values that are never both empty on a real send — an amount paid and an amount still owing, say — can be listed here when it is in fact fine. Read each line before you change it.`,
    );
  }
  if (staleContent.reasons.includes("invalid_content")) {
    sentences.push(
      "Your saved copy breaks one of the rules the editor enforces when you press Save, so this template can no longer be saved as it stands. Press Preview to see it, or open the token help for what is allowed — and if you cannot see what is wrong, press Save and the editor will name it.",
    );
  }
  return sentences;
}

function TemplateDiffBlock({
  label,
  saved,
  current,
}: {
  label: string;
  saved: string;
  current: string;
}) {
  const lines = diffLines(saved, current);
  const headingId = useId();
  return (
    <div className="space-y-1">
      <p id={headingId} className="text-xs font-medium text-foreground">
        {label}
      </p>
      {/*
        A scrollable region must be reachable from the keyboard (WCAG 2.1.1),
        and horizontal scrolling is the NORMAL case here — these lines run to
        150-400 characters. `whitespace-pre-wrap` wraps them so most readers
        never have to scroll at all, and the region is focusable and named for
        anyone who does.
      */}
      <div
        role="group"
        aria-labelledby={headingId}
        tabIndex={0}
        className="overflow-x-auto rounded-md border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <pre className="min-w-fit whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
          {lines.map((line, index) => (
            <div
              key={`${index}-${line.type}`}
              className={
                line.type === "removed"
                  ? "bg-danger-3 px-2 text-danger-11"
                  : line.type === "added"
                    ? "bg-success-3 px-2 text-success-11"
                    : "px-2 text-muted-foreground"
              }
            >
              {line.type === "removed" ? "- " : line.type === "added" ? "+ " : "  "}
              {line.value === "" ? " " : markInvisibleCharacters(line.value)}
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}

export function EmailMessageSettingsPanel() {
  const [settings, setSettings] = useState<EmailSettings | null>(null);
  const [templates, setTemplates] = useState<TemplateDefinition[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [subject, setSubject] = useState("");
  // Fork #38: the body EDITING state is the rich editor's HTML. A legacy
  // plain-text override (or the built-in default) is upgraded losslessly for
  // editing via plainTextToEmailBodyHtml; nothing is stored until save.
  const [bodyHtml, setBodyHtml] = useState("");
  const [previewHtml, setPreviewHtml] = useState("");
  const [previewSubject, setPreviewSubject] = useState("");
  const [staleOverrideCount, setStaleOverrideCount] = useState(0);
  // #2268 review (MED-1): template names whose SAVED override still carries a
  // pre-sweep "[only when …]" authoring note — literal text every send of that
  // override delivers to its recipient. Save now refuses the junk, but only
  // this banner tells an admin which existing rows still need re-authoring.
  const [bracketAnnotationTemplates, setBracketAnnotationTemplates] = useState<
    string[]
  >([]);
  // #2307 review (M2): saved overrides that still reference a token their
  // template no longer supplies. A missing token renders as NOTHING, so such an
  // override keeps sending with a hole in it — the check-in reminder's old
  // {{guestFirstName}}/{{guestLastName}} pair would have listed no guests at
  // all. Save-time validation refuses them; only this banner tells an admin
  // which stored rows are already affected.
  const [retiredTokenTemplates, setRetiredTokenTemplates] = useState<
    { templateName: string; tokens: string[] }[]
  >([]);
  // #2269 (F3): saved overrides that no longer show something the email is
  // required to tell the recipient — the drift #2267 created when the promo
  // explanation and the door-code line moved to pre-composed tokens, and the
  // one form of staleness that had no signal anywhere until now.
  const [missingRequiredTokenTemplates, setMissingRequiredTokenTemplates] =
    useState<{ templateName: string; tokens: string[] }[]>([]);
  // #2269 (second review): saved overrides the upgrade itself rewrote, and that
  // nobody has saved since. These rows used to raise the bracket banner above;
  // removing the bracket is what silenced it, and a conditional line with no
  // token in it ("Payment has been processed successfully.") is invisible to
  // every other check here. Naming them in the same place keeps the signal on a
  // row we changed without asking, instead of quietly reducing it.
  const [strippedAnnotationTemplates, setStrippedAnnotationTemplates] =
    useState<string[]>([]);
  const [showDiff, setShowDiff] = useState(false);
  const { confirm, confirmDialog } = useConfirm();
  const diffRegionId = useId();
  const [loading, setLoading] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [forbiddenSave, setForbiddenSave] = useState(false);
  // Email settings and templates are edited under the Support & System area (the
  // write routes enforce support:edit), so gate the editors on that area (#1940).
  const canEdit = useAdminAreaEditAccess("support");

  const currentTemplate = useMemo(
    () => templates.find((template) => template.key === selectedTemplate) ?? null,
    [selectedTemplate, templates],
  );
  const requirementSentence = useMemo(
    () => requiredTokenSentence(currentTemplate),
    [currentTemplate],
  );
  // #2269 review: the staleness notes and the diff both describe the SAVED
  // row. Whether the boxes still hold that row is a separate fact, and the
  // admin has to be told which one they are looking at. isSameText, not ===,
  // so a textarea CRLF round trip is not mistaken for an edit.
  const hasUnsavedEdits = useMemo(() => {
    if (!currentTemplate) return false;
    const savedSubject =
      currentTemplate.override?.subject ?? currentTemplate.defaultSubject;
    const savedEditorHtml = editorHtmlFor(currentTemplate);
    return (
      !isSameText(subject, savedSubject) || !isSameText(bodyHtml, savedEditorHtml)
    );
  }, [bodyHtml, currentTemplate, subject]);

  async function load() {
    setLoading(true);
    try {
      const [settingsResponse, templatesResponse] = await Promise.all([
        fetch("/api/admin/email-settings", { credentials: "same-origin" }),
        fetch("/api/admin/email-templates", { credentials: "same-origin" }),
      ]);
      const settingsBody = await settingsResponse.json();
      const templatesBody = await templatesResponse.json();
      if (!settingsResponse.ok) {
        throw new Error(settingsBody?.error ?? "Failed to load email settings");
      }
      if (!templatesResponse.ok) {
        throw new Error(templatesBody?.error ?? "Failed to load email templates");
      }
      const nextTemplates = templatesBody.templates as TemplateDefinition[];
      setSettings(settingsBody.settings);
      setTemplates(nextTemplates);
      setStaleOverrideCount(templatesBody.staleOverrideCount ?? 0);
      setBracketAnnotationTemplates(
        Array.isArray(templatesBody.bracketAnnotationOverrides)
          ? (
              templatesBody.bracketAnnotationOverrides as Array<{
                templateName?: string;
              }>
            )
              .map((entry) => entry?.templateName)
              .filter((name): name is string => Boolean(name))
          : [],
      );
      setRetiredTokenTemplates(
        Array.isArray(templatesBody.retiredTokenOverrides)
          ? (
              templatesBody.retiredTokenOverrides as Array<{
                templateName?: string;
                tokens?: string[];
              }>
            )
              .filter((entry) => Boolean(entry?.templateName))
              .map((entry) => ({
                templateName: entry.templateName as string,
                tokens: Array.isArray(entry.tokens) ? entry.tokens : [],
              }))
          : [],
      );
      setStrippedAnnotationTemplates(
        Array.isArray(templatesBody.strippedAnnotationOverrides)
          ? (
              templatesBody.strippedAnnotationOverrides as Array<{
                templateName?: string;
              }>
            )
              .map((entry) => entry?.templateName)
              .filter((name): name is string => Boolean(name))
          : [],
      );
      setMissingRequiredTokenTemplates(
        Array.isArray(templatesBody.missingRequiredTokenOverrides)
          ? (
              templatesBody.missingRequiredTokenOverrides as Array<{
                templateName?: string;
                tokens?: string[];
              }>
            )
              .filter((entry) => Boolean(entry?.templateName))
              .map((entry) => ({
                templateName: entry.templateName as string,
                tokens: Array.isArray(entry.tokens) ? entry.tokens : [],
              }))
          : [],
      );
      const firstTemplate = selectedTemplate || nextTemplates[0]?.key || "";
      setSelectedTemplate(firstTemplate);
      const selected = nextTemplates.find((template) => template.key === firstTemplate);
      if (selected) {
        setSubject(selected.override?.subject ?? selected.defaultSubject);
        setBodyHtml(editorHtmlFor(selected));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load email settings");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function selectTemplate(key: string) {
    const template = templates.find((entry) => entry.key === key);
    setSelectedTemplate(key);
    setSubject(template?.override?.subject ?? template?.defaultSubject ?? "");
    setBodyHtml(template ? editorHtmlFor(template) : "");
    setPreviewHtml("");
    setPreviewSubject("");
    setShowDiff(false);
  }

  async function saveSettings() {
    if (!settings) return;
    setSavingSettings(true);
    setForbiddenSave(false);
    try {
      // Only the editable club-level fields are persisted; the strict API schema
      // rejects the lodge-identity keys the response may still carry.
      const payload = Object.fromEntries(
        settingFields.map((field) => [field.key, settings[field.key]]),
      );
      const response = await fetch("/api/admin/email-settings", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 403) setForbiddenSave(true);
        throw new Error(body?.error ?? "Failed to save email settings");
      }
      setSettings(body.settings);
      toast.success("Email settings saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save email settings");
    } finally {
      setSavingSettings(false);
    }
  }

  async function saveTemplate() {
    if (!currentTemplate) return;
    setSavingTemplate(true);
    setForbiddenSave(false);
    try {
      const response = await fetch("/api/admin/email-templates", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateName: currentTemplate.key,
          subject,
          // Fork #38: the rich body. The server sanitises it and derives the
          // stored plain text from it; rows saved before the feature keep
          // plain rendering until re-saved here.
          bodyHtml,
        }),
      });
      const responseBody = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 403) setForbiddenSave(true);
        throw new Error(
          templateErrorMessage(responseBody, "Failed to save email template"),
        );
      }
      toast.success("Email template saved");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save email template");
    } finally {
      setSavingTemplate(false);
    }
  }

  async function resetTemplate() {
    if (!currentTemplate) return;
    // #2269 review: this deletes the club's own wording outright and there is
    // no undo in the product — the only copy afterwards is the audit row the
    // reset route now records, IN FULL (the route asks the audit layer for
    // archive mode so a long body is not clipped at 1000 characters, which is
    // what makes the promise below true). One click was not enough of a gate,
    // especially now that three separate places in this editor point at it as
    // the remedy.
    const confirmed = await confirm({
      title: `Replace your wording for “${currentTemplate.label}”?`,
      description:
        "This deletes your saved subject and body for this message and goes back to the built-in wording. Your subject and body are written to the audit log in full first — apart from any line that reads like it carries a password, token or card number, which is masked there — but it cannot be undone from here, and reading that copy back needs someone with database access. If you only want to compare, close this and use Show differences instead.",
      confirmLabel: "Replace with the built-in wording",
      destructive: true,
    });
    if (!confirmed) return;
    setSavingTemplate(true);
    setForbiddenSave(false);
    try {
      const response = await fetch("/api/admin/email-templates/reset", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateName: currentTemplate.key }),
      });
      const responseBody = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 403) setForbiddenSave(true);
        throw new Error(responseBody?.error ?? "Failed to reset email template");
      }
      setSubject(currentTemplate.defaultSubject);
      setBodyHtml(plainTextToEmailBodyHtml(currentTemplate.defaultBody));
      toast.success("Email template reset");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to reset email template");
    } finally {
      setSavingTemplate(false);
    }
  }

  async function previewTemplate() {
    if (!currentTemplate) return;
    try {
      const response = await fetch("/api/admin/email-templates/preview", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateName: currentTemplate.key,
          subject,
          // Preview through the same sanitise-and-render path a save uses.
          bodyHtml,
        }),
      });
      const responseBody = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          templateErrorMessage(responseBody, "Failed to preview email template"),
        );
      }
      setPreviewSubject(responseBody.subject);
      setPreviewHtml(responseBody.html);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to preview email template");
    }
  }

  /*
    #2160: the view-only explanation lives here, once, at the top of the panel —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before
    its content appears; a region injected already-populated is silently dropped
    by some screen-reader/browser pairings. That is why it is hoisted above the
    loading early-return and rendered in both branches. It sits OUTSIDE the
    `space-y-8` stack so the empty wrapper an edit-capable admin gets costs no
    layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view email settings and templates but cannot change
      them. Support &amp; System edit access is required.
    </AdminViewOnlySectionBanner>
  );

  if (loading || !settings) {
    return (
      <div>
        {viewOnlyBanner}
        <p className="text-sm text-muted-foreground">Loading email settings</p>
      </div>
    );
  }

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-8">
      {forbiddenSave ? <AdminForbiddenSaveNotice /> : null}
      {staleOverrideCount > 0 ? (
        <div className="rounded-md border border-warning-6 bg-warning-3 p-3 text-sm text-warning-11">
          {staleOverrideCount} stale template override
          {staleOverrideCount === 1 ? "" : "s"} need database cleanup.
        </div>
      ) : null}
      {bracketAnnotationTemplates.length > 0 ? (
        <div className="rounded-md border border-warning-6 bg-warning-3 p-3 text-sm text-warning-11">
          {bracketAnnotationTemplates.length === 1
            ? "A saved template override still contains"
            : `${bracketAnnotationTemplates.length} saved template overrides still contain`}{" "}
          square-bracketed authoring notes (like &ldquo;[only when a door code
          is set]&rdquo;) from the old built-in wording. Emails render tokens
          and nothing else, so these notes are sent to recipients word for
          word. Open each template, remove the bracketed text, and save (or
          reset it to the corrected default):{" "}
          <span className="font-medium">
            {bracketAnnotationTemplates
              .map((templateName) => templateLabel(templates, templateName))
              .join(", ")}
          </span>
          .
        </div>
      ) : null}
      {strippedAnnotationTemplates.length > 0 ? (
        <div className="rounded-md border border-warning-6 bg-warning-3 p-3 text-sm text-warning-11">
          An upgrade removed our own square-bracketed notes (like &ldquo;[only
          when the booking is already paid]&rdquo;) from{" "}
          {strippedAnnotationTemplates.length === 1
            ? "a saved template override, "
            : `${strippedAnnotationTemplates.length} saved template overrides, `}
          because they were being emailed to recipients word for word. Your
          own wording was left exactly as you wrote it, and the whole previous
          copy is in the audit log. Those notes were also the only thing marking
          some lines as conditional, so please open each message, check the
          lines still read correctly on every send, and press Save Template —
          saving clears this notice:{" "}
          <span className="font-medium">
            {strippedAnnotationTemplates
              .map((templateName) => templateLabel(templates, templateName))
              .join(", ")}
          </span>
          .
        </div>
      ) : null}
      {retiredTokenTemplates.length > 0 ? (
        <div className="rounded-md border border-warning-6 bg-warning-3 p-3 text-sm text-warning-11">
          {retiredTokenTemplates.length === 1
            ? "A saved template override still uses"
            : `${retiredTokenTemplates.length} saved template overrides still use`}{" "}
          a token that template no longer offers. A token that is not supplied
          renders as nothing at all, so the line it sits on can go out empty.
          Open each one, swap the old token for the chips now shown, and save
          (or reset it to the current default):{" "}
          <span className="font-medium">
            {retiredTokenTemplates
              .map(
                (entry) =>
                  `${templateLabel(templates, entry.templateName)} (${entry.tokens
                    .map((token) => `{{${token}}}`)
                    .join(", ")})`,
              )
              .join("; ")}
          </span>
          .
        </div>
      ) : null}
      {missingRequiredTokenTemplates.length > 0 ? (
        <div className="rounded-md border border-warning-6 bg-warning-3 p-3 text-sm text-warning-11">
          {missingRequiredTokenTemplates.length === 1
            ? "A saved template override no longer shows"
            : `${missingRequiredTokenTemplates.length} saved template overrides no longer show`}{" "}
          something the email is required to tell the recipient — usually
          because the built-in wording moved that information into a new token
          after the copy was saved. Open each one and add the token back (or
          write your own wording that says the same thing), or restore the
          default:{" "}
          <span className="font-medium">
            {missingRequiredTokenTemplates
              .map(
                (entry) =>
                  `${templateLabel(templates, entry.templateName)} (${entry.tokens
                    .map((token) => `{{${token}}}`)
                    .join(", ")})`,
              )
              .join("; ")}
          </span>
          .
        </div>
      ) : null}
      <section className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          {settingFields.map((field) => (
            <div key={field.key} className={field.multiline ? "md:col-span-2" : ""}>
              <Label htmlFor={`email-setting-${field.key}`}>{field.label}</Label>
              {field.multiline ? (
                <Textarea
                  id={`email-setting-${field.key}`}
                  className="mt-1 min-h-24"
                  disabled={!canEdit}
                  value={settings[field.key] ?? ""}
                  onChange={(event) =>
                    setSettings((current) =>
                      current
                        ? { ...current, [field.key]: event.target.value }
                        : current,
                    )
                  }
                />
              ) : (
                <Input
                  id={`email-setting-${field.key}`}
                  className="mt-1"
                  disabled={!canEdit}
                  value={settings[field.key] ?? ""}
                  onChange={(event) =>
                    setSettings((current) =>
                      current
                        ? { ...current, [field.key]: event.target.value }
                        : current,
                    )
                  }
                />
              )}
            </div>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">
          Lodge name, travel note, and door code now come from each lodge&apos;s
          own settings (Admin → Lodges).
        </p>
        <ViewOnlyActionButton
          canEdit={canEdit}
          describeReason={false}
          onClick={saveSettings}
          disabled={savingSettings}
        >
          <Save className="h-4 w-4" />
          {savingSettings ? "Saving" : "Save Email Settings"}
        </ViewOnlyActionButton>
      </section>

      <section className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
          <div>
            <Label htmlFor="email-template-select">Template</Label>
            <Select value={selectedTemplate} onValueChange={selectTemplate}>
              <SelectTrigger id="email-template-select" className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {templates.map((template) => (
                  <SelectItem key={template.key} value={template.key}>
                    {template.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {currentTemplate ? (
            <div className="space-y-2 text-sm text-muted-foreground">
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">{currentTemplate.audience}</Badge>
                <Badge variant="outline">{currentTemplate.key}</Badge>
              </div>
              <p>{currentTemplate.triggerSummary}</p>
              <p>{currentTemplate.frequency}</p>
            </div>
          ) : null}
        </div>

        {currentTemplate ? (
          <div className="space-y-2">
            <Label>Tokens</Label>
            {/* Shared chip renderer; token names stay sourced from the
                email message registry, not the HTML token catalogue. */}
            <TokenChips
              tokens={currentTemplate.allowedTokens.map((token) => ({
                token,
                required: currentTemplate.requiredTokens.includes(token),
              }))}
            />
            {/* #2268: the guidance that used to live inside the default bodies
                as "[only when ...]" notes — which the engine could not act on,
                so it printed them to members. Stated once, here, where an
                operator actually sees it. */}
            <p className="text-muted-foreground text-xs">
              Tokens are substituted as-is — there is no &quot;only if&quot;.
              A value that does not apply to a particular send renders as
              nothing, so writing your own label in front of it (for example
              <code className="mx-1">Door code: {"{{doorCode}}"}</code>) leaves
              a bare label on every email where it is missing. Tokens ending in
              <code className="mx-1">Note</code> or
              <code className="mx-1">Line</code> already contain the whole line,
              label included: put one on a line of its own and it disappears
              cleanly when there is nothing to say. Never write notes to
              yourself into the body — they are sent to the recipient verbatim.
            </p>
            {requirementSentence ? (
              <p className="text-xs text-muted-foreground">
                {requirementSentence}
              </p>
            ) : null}
          </div>
        ) : null}

        {/* #2269 (F3): the saved-copy indicator. The fact that a saved copy
            differs is stated flatly and paired with the diff, because that is
            what an override IS; only the objectively-wrong reasons are dressed
            as a warning. */}
        {currentTemplate?.override &&
        currentTemplate.staleContent &&
        (currentTemplate.staleContent.differsFromDefault ||
          currentTemplate.staleContent.reasons.length > 0) ? (
          <div className="space-y-3 rounded-md border border-border bg-muted p-3 text-sm">
            {/* A reason always implies a difference today (the built-in wording
                cannot itself carry a bracket note or a retired token), but the
                two are rendered independently so a future rule that does not
                imply one still shows its reason instead of nothing. */}
            {currentTemplate.staleContent.differsFromDefault ? (
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-muted-foreground">
                  Your saved copy of this message differs from the built-in
                  wording.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  aria-expanded={showDiff}
                  aria-controls={diffRegionId}
                  onClick={() => setShowDiff((current) => !current)}
                >
                  <GitCompareArrows className="h-4 w-4" />
                  {showDiff ? "Hide differences" : "Show differences"}
                </Button>
              </div>
            ) : null}
            {staleContentSentences(currentTemplate.staleContent).map(
              (sentence) => (
                <p
                  key={sentence}
                  className="rounded-md border border-warning-6 bg-warning-3 p-2 text-warning-11"
                >
                  {sentence}
                </p>
              ),
            )}
            {showDiff ? (
              <div
                id={diffRegionId}
                role="region"
                aria-label="Differences between your saved copy and the built-in wording"
                className="space-y-3"
              >
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium text-danger-11">- red</span> is
                  your saved copy,{" "}
                  <span className="font-medium text-success-11">+ green</span>{" "}
                  is the current built-in wording. Restore Default replaces your
                  copy with the green side; saving keeps yours.
                </p>
                {/* #2269 review: the diff and the warnings above both describe
                    the SAVED row, not what is in the boxes right now. An admin
                    who edits to fix a flagged problem and then opens this would
                    otherwise read their pre-edit text under a legend saying
                    "yours", with no hint anything was stale. */}
                {hasUnsavedEdits ? (
                  <p className="rounded-md border border-warning-6 bg-warning-3 p-2 text-xs text-warning-11">
                    You have unsaved edits. This comparison — and the notes
                    above it — describe the copy that is currently saved, not
                    what is in the boxes below. Save to refresh them.
                  </p>
                ) : null}
                {currentTemplate.staleContent.subjectDiffersFromDefault ? (
                  <TemplateDiffBlock
                    label="Subject differences"
                    saved={currentTemplate.override.subject ?? ""}
                    current={currentTemplate.defaultSubject}
                  />
                ) : null}
                {currentTemplate.staleContent.bodyDiffersFromDefault ? (
                  isSameText(
                    currentTemplate.override.bodyText ?? "",
                    currentTemplate.defaultBody,
                  ) ? (
                    // Fork #38 (drift lens 7): the wording matches the
                    // built-in text and only the FORMATTING differs — a text
                    // diff would show nothing, so say what the difference is.
                    <p className="text-sm text-muted-foreground">
                      The difference is formatting only — the wording matches
                      the built-in text. Use Preview to see how it renders.
                    </p>
                  ) : (
                    <TemplateDiffBlock
                      label="Body differences"
                      saved={currentTemplate.override.bodyText ?? ""}
                      current={currentTemplate.defaultBody}
                    />
                  )
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        <div>
          <Label htmlFor="email-template-subject">Subject</Label>
          <Input
            id="email-template-subject"
            className="mt-1"
            disabled={!canEdit}
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="email-template-body">Body</Label>
          {/* Fork #38 (owner decision): rich in-place editing, like the
              message-board composer. The server's sanitise policy is the
              control; this surface is convenience. */}
          <EmailBodyRichEditor
            id="email-template-body"
            ariaLabel="Body"
            value={bodyHtml}
            onChange={setBodyHtml}
            disabled={!canEdit}
          />
        </div>

        <div className="flex flex-wrap gap-2">
          <ViewOnlyActionButton
            canEdit={canEdit}
            describeReason={false}
            onClick={saveTemplate}
            disabled={savingTemplate || !currentTemplate}
          >
            <Save className="h-4 w-4" />
            {savingTemplate ? "Saving" : "Save Template"}
          </ViewOnlyActionButton>
          <Button
            variant="outline"
            onClick={previewTemplate}
            disabled={!currentTemplate}
          >
            <Eye className="h-4 w-4" />
            Preview
          </Button>
          <ViewOnlyActionButton
            canEdit={canEdit}
            describeReason={false}
            variant="outline"
            onClick={resetTemplate}
            disabled={savingTemplate || !currentTemplate}
          >
            <RotateCcw className="h-4 w-4" />
            Restore Default
          </ViewOnlyActionButton>
        </div>

        {previewHtml ? (
          <div className="space-y-3 rounded-md border border-border bg-card p-4">
            <p className="text-sm font-medium text-foreground">
              Subject: {previewSubject}
            </p>
            <iframe
              title="Email preview"
              className="h-[520px] w-full rounded-md border border-border bg-card"
              sandbox=""
              srcDoc={previewHtml}
            />
          </div>
        ) : null}
      </section>
      </div>
      {confirmDialog}
    </div>
  );
}
