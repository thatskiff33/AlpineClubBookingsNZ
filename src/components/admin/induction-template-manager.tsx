"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
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
import { FieldHint, useFieldHint } from "@/components/ui/field-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  type InductionKind,
  type InductionSectionPriority,
  INDUCTION_KIND_LABELS,
} from "@/lib/induction-display";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";

interface TemplateSummary {
  id: string;
  name: string;
  version: string;
  kind: InductionKind;
  isActive: boolean;
  createdAt: string;
  sectionCount: number;
  inductionCount: number;
  used: boolean;
}

interface ActiveTemplateItem {
  id: string;
  label: string;
  competencyPrompt: string | null;
  isMandatory: boolean;
  requiresDemonstration: boolean;
}

interface ActiveTemplateSection {
  id: string;
  title: string;
  description: string | null;
  items: ActiveTemplateItem[];
}

interface ActiveTemplate {
  id: string;
  name: string;
  version: string;
  kind: InductionKind;
  sections: ActiveTemplateSection[];
}

interface ItemDraft {
  label: string;
  competencyPrompt: string;
  notesPrompt: string;
  isMandatory: boolean;
  requiresDemonstration: boolean;
}

interface SectionDraft {
  title: string;
  description: string;
  priority: InductionSectionPriority;
  items: ItemDraft[];
}

interface TemplateDraft {
  id: string;
  name: string;
  version: string;
  kind: InductionKind;
  sections: SectionDraft[];
}

const KINDS: InductionKind[] = [
  "NEW_MEMBER",
  "HUT_LEADER",
  "YOUTH_TO_FULL",
  "RE_INDUCTION",
];

const PRIORITIES: InductionSectionPriority[] = [
  "EMERGENCY",
  "SECURITY",
  "STARTUP",
  "SHUTDOWN",
  "GENERAL",
];

export function InductionTemplateManager() {
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<TemplateDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [newName, setNewName] = useState("Lodge Induction Checklist");
  const [newVersion, setNewVersion] = useState("");
  // #2257 — the example lives UNDER the field, not inside it as grey pseudo-content.
  const versionHint = useFieldHint();
  const [newKind, setNewKind] = useState<InductionKind>("NEW_MEMBER");
  const [activeTemplate, setActiveTemplate] = useState<ActiveTemplate | null>(null);
  const [showActiveTemplate, setShowActiveTemplate] = useState(false);
  // Induction templates are membership-area config (the write routes enforce
  // membership:edit), so gate every write control on that area (#1940).
  const canEdit = useAdminAreaEditAccess("membership");

  const loadTemplates = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/induction-templates", {
        credentials: "same-origin",
      });
      const body = await res.json();
      const list: TemplateSummary[] = body.templates ?? [];
      setTemplates(list);
      // Pre-load the active template for the selected workflow type.
      const active = list.find((t) => t.isActive && t.kind === newKind);
      if (active) {
        const detail = await fetch(`/api/admin/induction-templates/${active.id}`, {
          credentials: "same-origin",
        });
        const detailBody = await detail.json();
        if (detailBody.template) setActiveTemplate(detailBody.template as ActiveTemplate);
      } else {
        setActiveTemplate(null);
      }
    } catch {
      toast.error("Failed to load templates");
    } finally {
      setLoading(false);
    }
  }, [newKind]);

  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  async function activate(id: string) {
    const res = await fetch(`/api/admin/induction-templates/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ isActive: true }),
    });
    if (!res.ok) {
      toast.error("Failed to activate template");
      return;
    }
    toast.success("Template activated");
    void loadTemplates();
  }

  async function remove(id: string) {
    const res = await fetch(`/api/admin/induction-templates/${id}`, {
      method: "DELETE",
      credentials: "same-origin",
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(body.error ?? "Failed to delete template");
      return;
    }
    toast.success("Template deleted");
    void loadTemplates();
  }

  async function duplicate(cloneFromId?: string) {
    if (!newVersion.trim()) {
      toast.error("Enter a version label for the new template");
      return;
    }
    const res = await fetch("/api/admin/induction-templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        name: newName.trim(),
        version: newVersion.trim(),
        kind: newKind,
        cloneFromId,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(body.error ?? "Failed to create template");
      return;
    }
    toast.success("Template created");
    setNewVersion("");
    void loadTemplates();
    void openEditor(body.template.id);
  }

  const openEditor = useCallback(async (id: string) => {
    const res = await fetch(`/api/admin/induction-templates/${id}`, {
      credentials: "same-origin",
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(body.error ?? "Failed to open template");
      return;
    }
    if (body.used) {
      toast.error("This template has been used and cannot be edited.");
      return;
    }
    const template = body.template;
    setDraft({
      id: template.id,
      name: template.name,
      version: template.version,
      kind: template.kind,
      sections: template.sections.map((section: SectionDraft & { items: ItemDraft[] }) => ({
        title: section.title,
        description: section.description ?? "",
        priority: section.priority,
        items: section.items.map((item) => ({
          label: item.label,
          competencyPrompt: item.competencyPrompt ?? "",
          notesPrompt: item.notesPrompt ?? "",
          isMandatory: item.isMandatory,
          requiresDemonstration: item.requiresDemonstration,
        })),
      })),
    });
  }, []);

  function patchSection(index: number, patch: Partial<SectionDraft>) {
    setDraft((prev) => {
      if (!prev) return prev;
      const sections = [...prev.sections];
      const target = sections[index];
      // `index` is always the position the caller just rendered this section
      // at, but a section can be removed between render and a stale click
      // reaching a now-shifted index — a no-op edit rather than a crash.
      if (!target) return prev;
      sections[index] = { ...target, ...patch };
      return { ...prev, sections };
    });
  }

  function patchItem(sIdx: number, iIdx: number, patch: Partial<ItemDraft>) {
    setDraft((prev) => {
      if (!prev) return prev;
      const sections = [...prev.sections];
      const section = sections[sIdx];
      if (!section) return prev; // see patchSection's note above
      const items = [...section.items];
      const item = items[iIdx];
      if (!item) return prev; // same reasoning, one level deeper
      items[iIdx] = { ...item, ...patch };
      sections[sIdx] = { ...section, items };
      return { ...prev, sections };
    });
  }

  function addItem(sIdx: number) {
    patchSection(sIdx, {
      items: [
        ...(draft?.sections[sIdx]?.items ?? []),
        {
          label: "",
          competencyPrompt: "",
          notesPrompt: "",
          isMandatory: false,
          requiresDemonstration: false,
        },
      ],
    });
  }

  function removeItem(sIdx: number, iIdx: number) {
    if (!draft) return;
    const section = draft.sections[sIdx];
    if (!section) return; // see patchSection's note above
    patchSection(sIdx, {
      items: section.items.filter((_, i) => i !== iIdx),
    });
  }

  function addSection() {
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            sections: [
              ...prev.sections,
              { title: "New section", description: "", priority: "GENERAL", items: [] },
            ],
          }
        : prev
    );
  }

  function removeSection(index: number) {
    setDraft((prev) =>
      prev
        ? { ...prev, sections: prev.sections.filter((_, i) => i !== index) }
        : prev
    );
  }

  async function saveDraft() {
    if (!draft) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/induction-templates/${draft.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          name: draft.name,
          version: draft.version,
          kind: draft.kind,
          sections: draft.sections.map((section) => ({
            title: section.title,
            description: section.description || null,
            priority: section.priority,
            items: section.items
              .filter((item) => item.label.trim())
              .map((item) => ({
                label: item.label,
                competencyPrompt: item.competencyPrompt || null,
                notesPrompt: item.notesPrompt || null,
                isMandatory: item.isMandatory,
                requiresDemonstration: item.requiresDemonstration,
              })),
          })),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? "Failed to save template");
        return;
      }
      toast.success("Template saved");
      setDraft(null);
      void loadTemplates();
    } catch {
      toast.error("Failed to save template");
    } finally {
      setSaving(false);
    }
  }

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It sits OUTSIDE the card's `space-y-*`
    stack so the empty wrapper an edit-capable admin gets costs no layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view induction templates but cannot change them.
      Membership edit access is required.
    </AdminViewOnlySectionBanner>
  );

  return (
    <div>
      {viewOnlyBanner}
    <Card>
      <CardHeader>
        <CardTitle>Induction checklist templates</CardTitle>
        <CardDescription>
          The active template is used for new inductions. Templates already used
          for an induction are locked — duplicate them to make a new version.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <ul className="space-y-2">
            {templates.map((template) => (
              <li
                key={template.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
              >
                <div>
                  <p className="text-sm font-medium">
                    {template.name}{" "}
                    <span className="text-muted-foreground">
                      v{template.version}
                    </span>
                    <Badge className="ml-2" variant="outline">
                      {INDUCTION_KIND_LABELS[template.kind]}
                    </Badge>
                    {template.isActive && (
                      <Badge className="ml-2" variant="default">
                        Active
                      </Badge>
                    )}
                    {template.used && (
                      <Badge className="ml-2" variant="secondary">
                        In use
                      </Badge>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {template.sectionCount} sections · {template.inductionCount}{" "}
                    inductions
                  </p>
                </div>
                <div className="flex gap-2">
                  {!template.isActive && (
                    <ViewOnlyActionButton
                      canEdit={canEdit}
                      describeReason={false}
                      size="sm"
                      variant="outline"
                      onClick={() => activate(template.id)}
                    >
                      Activate
                    </ViewOnlyActionButton>
                  )}
                  {!template.used && (
                    <ViewOnlyActionButton
                      canEdit={canEdit}
                      describeReason={false}
                      size="sm"
                      variant="outline"
                      onClick={() => openEditor(template.id)}
                    >
                      Edit
                    </ViewOnlyActionButton>
                  )}
                  {!template.used && !template.isActive && (
                    <ViewOnlyActionButton
                      canEdit={canEdit}
                      describeReason={false}
                      size="sm"
                      variant="ghost"
                      aria-label="Delete template"
                      onClick={() => remove(template.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </ViewOnlyActionButton>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {activeTemplate && (
          <div className="rounded-md border">
            <button
              type="button"
              onClick={() => setShowActiveTemplate((v) => !v)}
              className="flex w-full items-center justify-between p-3 text-left text-sm font-medium hover:bg-muted"
            >
              <span>
                View active checklist —{" "}
                <span className="font-normal text-muted-foreground">
                  {activeTemplate.name} v{activeTemplate.version}
                  {" · "}
                  {INDUCTION_KIND_LABELS[activeTemplate.kind]}
                </span>
              </span>
              {showActiveTemplate ? (
                <ChevronDown className="h-4 w-4 shrink-0" />
              ) : (
                <ChevronRight className="h-4 w-4 shrink-0" />
              )}
            </button>
            {showActiveTemplate && (
              <div className="border-t px-3 pb-3 pt-2 space-y-4">
                {activeTemplate.sections.map((section) => (
                  <div key={section.id}>
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                      {section.title}
                    </p>
                    {section.description && (
                      <p className="text-xs text-muted-foreground mb-2">{section.description}</p>
                    )}
                    <ul className="space-y-1">
                      {section.items.map((item) => (
                        <li key={item.id} className="rounded-sm border px-2 py-1.5">
                          <p className="text-sm">
                            {item.label}
                            {item.isMandatory && (
                              <span className="ml-2 text-xs text-destructive">Mandatory</span>
                            )}
                            {item.requiresDemonstration && (
                              <span className="ml-2 text-xs text-muted-foreground">Demonstration required</span>
                            )}
                          </p>
                          {item.competencyPrompt && (
                            <p className="text-xs text-muted-foreground mt-0.5">{item.competencyPrompt}</p>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="space-y-2 rounded-md border bg-muted p-3">
          <p className="text-sm font-medium">Create a new version</p>
          {/* #2257 — `items-end` bottom-aligns every cell, so a hint rendered
              INSIDE the Version cell would become that cell's bottom edge and
              lift its input clear of the select, the name input and the
              buttons. `basis-full` puts the hint on its own wrapped flex line:
              cross-axis alignment is per line, so the control line keeps its
              baseline and the hint hangs below the row. */}
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="new-kind" className="text-xs">
                Type
              </Label>
              <select
                id="new-kind"
                value={newKind}
                disabled={!canEdit}
                onChange={(e) => setNewKind(e.target.value as InductionKind)}
                className="h-9 rounded-md border bg-background px-2 text-sm"
              >
                {KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {INDUCTION_KIND_LABELS[kind]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="new-name" className="text-xs">
                Name
              </Label>
              <Input
                id="new-name"
                value={newName}
                disabled={!canEdit}
                onChange={(e) => setNewName(e.target.value)}
                className="w-56"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="new-version" className="text-xs">
                Version
              </Label>
              <Input
                id="new-version"
                value={newVersion}
                disabled={!canEdit}
                onChange={(e) => setNewVersion(e.target.value)}
                className="w-32"
                {...versionHint.fieldProps}
              />
            </div>
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              size="sm"
              variant="outline"
              onClick={() =>
                duplicate(
                  templates.find((t) => t.isActive && t.kind === newKind)?.id
                )
              }
            >
              Duplicate active
            </ViewOnlyActionButton>
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              size="sm"
              variant="outline"
              onClick={() => duplicate()}
            >
              Create blank
            </ViewOnlyActionButton>
            <FieldHint {...versionHint.hintProps} className="basis-full">
              Version example: 2026.1
            </FieldHint>
          </div>
        </div>

        {draft && (
          <div className="space-y-4 rounded-md border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold">
                Editing {draft.name} v{draft.version}
              </p>
              <Button size="sm" variant="outline" onClick={addSection}>
                <Plus className="mr-1 h-4 w-4" /> Add section
              </Button>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Type</Label>
              <select
                value={draft.kind}
                onChange={(e) =>
                  setDraft((prev) =>
                    prev
                      ? { ...prev, kind: e.target.value as InductionKind }
                      : prev
                  )
                }
                className="h-9 rounded-md border bg-background px-2 text-sm"
              >
                {KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {INDUCTION_KIND_LABELS[kind]}
                  </option>
                ))}
              </select>
            </div>

            {draft.sections.map((section, sIdx) => (
              <div key={sIdx} className="space-y-3 rounded-md border p-3">
                <div className="flex flex-wrap items-end gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs">Section title</Label>
                    <Input
                      value={section.title}
                      onChange={(e) => patchSection(sIdx, { title: e.target.value })}
                      className="w-64"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Priority</Label>
                    <select
                      value={section.priority}
                      onChange={(e) =>
                        patchSection(sIdx, {
                          priority: e.target.value as InductionSectionPriority,
                        })
                      }
                      className="h-9 rounded-md border bg-background px-2 text-sm"
                    >
                      {PRIORITIES.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => removeSection(sIdx)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>

                <ul className="space-y-2">
                  {section.items.map((item, iIdx) => (
                    <li key={iIdx} className="space-y-2 rounded-md border p-2">
                      <div className="flex items-center gap-2">
                        <Input
                          value={item.label}
                          placeholder="Item label"
                          onChange={(e) =>
                            patchItem(sIdx, iIdx, { label: e.target.value })
                          }
                        />
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => removeItem(sIdx, iIdx)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                      <Input
                        value={item.competencyPrompt}
                        placeholder="Competency prompt (optional)"
                        onChange={(e) =>
                          patchItem(sIdx, iIdx, {
                            competencyPrompt: e.target.value,
                          })
                        }
                        className="text-sm"
                      />
                      <div className="flex flex-wrap gap-4">
                        <label className="flex items-center gap-2 text-xs">
                          <Checkbox
                            checked={item.isMandatory}
                            onCheckedChange={(c) =>
                              patchItem(sIdx, iIdx, { isMandatory: c === true })
                            }
                          />
                          Mandatory
                        </label>
                        <label className="flex items-center gap-2 text-xs">
                          <Checkbox
                            checked={item.requiresDemonstration}
                            onCheckedChange={(c) =>
                              patchItem(sIdx, iIdx, {
                                requiresDemonstration: c === true,
                              })
                            }
                          />
                          Requires demonstration
                        </label>
                      </div>
                    </li>
                  ))}
                </ul>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => addItem(sIdx)}
                >
                  <Plus className="mr-1 h-4 w-4" /> Add item
                </Button>
              </div>
            ))}

            <div className="flex gap-2">
              <Button onClick={saveDraft} disabled={saving}>
                {saving ? "Saving…" : "Save template"}
              </Button>
              <Button variant="outline" onClick={() => setDraft(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
    </div>
  );
}
