"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { BackLink } from "@/components/admin/back-link";
import { MODULE_DEFINITIONS } from "@/config/modules";
import {
  listDisplayConditions,
  type DisplayConditionDefinition,
  type DisplayConditionFamily,
} from "@/lib/lodge-display/conditions";
import { listDisplayModules } from "@/lib/lodge-display/module-registry";
import {
  listDisplayCssTokens,
  type DisplayCssToken,
} from "@/lib/lodge-display/css-tokens";
import {
  BUILT_IN_DISPLAY_LAYOUTS,
  BUILT_IN_DISPLAY_TEMPLATES,
} from "@/lib/lodge-display/built-in-seeds";
import { DISPLAY_GLOSSARY } from "@/lib/lodge-display/display-terminology";
import { getAdminPage } from "@/lib/admin-hubs";

// LTV-034 (#80) — read-only Modules / Conditions / CSS-tokens reference (ADR-003
// §3, "Navigation & terminology"). Everything on this page is presentation over
// three CLIENT-SAFE registries: `listDisplayModules()`, `listDisplayConditions()`,
// and `listDisplayCssTokens()`. The only server call is the conditions status
// endpoint, which computes the "true right now for this lodge" indicator from a
// freshly built DisplayState; it is refreshed by a button, never polled, so the
// indicator is explicitly point-in-time.

// The display palette values are the constants `display.css` cascades from
// `.display-shell`. That stylesheet is scoped to the /display route and is NOT
// loaded in the admin bundle, so the swatches read the values from this lookup
// rather than resolving `var(--display-*)` (which would be undefined here). Brand
// tokens are per-club and resolve only against the live club theme, so they are
// shown without a swatch (see the CSS-tokens card note) — the pragmatic split the
// task allows.
const DISPLAY_PALETTE_SWATCHES: Record<string, string> = {
  "--display-ink": "#eef8fa",
  "--display-accent": "#43c2d4",
  "--display-muted": "#8fb2ba",
  "--display-panel": "rgba(255, 255, 255, 0.05)",
  "--display-line": "rgba(255, 255, 255, 0.12)",
  "--display-arriving": "#4bc48d",
  "--display-departing": "#e6a84f",
  "--display-group": "#b79bff",
};

const CONDITION_FAMILY_ORDER: DisplayConditionFamily[] = [
  "core",
  "occupancy",
  "content",
  "capability",
];

const CONDITION_FAMILY_LABEL: Record<DisplayConditionFamily, string> = {
  core: "Core",
  occupancy: "Occupancy",
  content: "Content",
  capability: "Capability",
};

interface LodgeOption {
  id: string;
  name: string;
}

interface ConditionStatus {
  lodgeId: string;
  lodgeName: string;
  values: Record<string, boolean>;
}

function InlineCode({ children }: { children: string }) {
  return (
    <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs break-all">
      {children}
    </code>
  );
}

function CopyToken({ token }: { token: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="Copy to clipboard"
      onClick={() => {
        void navigator.clipboard.writeText(token).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="bg-muted hover:bg-accent inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-xs break-all"
    >
      {token}
      <span className="text-muted-foreground">{copied ? "✓" : "⧉"}</span>
    </button>
  );
}

// "needs Chores — hides without it" / "uses Bed allocation — degrades without
// it", derived from the module labels in MODULE_DEFINITIONS so the phrasing
// tracks the club-module names automatically.
function dependencyPhrase(
  dependencies: readonly string[],
  mode: "degrades" | "hides"
): string | null {
  if (dependencies.length === 0) return null;
  const labels = dependencies.map(
    (key) => MODULE_DEFINITIONS[key as keyof typeof MODULE_DEFINITIONS]?.label ?? key
  );
  const list = labels.join(", ");
  return mode === "hides"
    ? `needs ${list} — hides without it`
    : `uses ${list} — degrades without it`;
}

// --- Template gallery (issue #2047) ----------------------------------------
// The pre-built boards, so an admin can see at a glance what each shows before
// assigning it to a device. Built-in entries are derived from the seeded
// Layout/Template pairs (built-in-seeds.ts) — module lists come straight from
// each template's slot content, so a new built-in appears here automatically.
// The two situational boards ship in the importable extras bundle
// (docs/lobby-display/seeds/) rather than as seeds, so they are listed
// statically with a note. Thumbnails are intentionally lightweight placeholders
// (a monogram tile) rather than screenshots — the real board is one click away
// via the per-template Preview on Admin → Display → Templates.

export interface GalleryEntry {
  name: string;
  delivery: "Built-in" | "Extras bundle";
  templateKey: string;
  moduleNames: string[];
  blurb: string;
}

/** The content modules a built-in template embeds, in slot order. */
function builtInModuleNames(templateKey: string): string[] {
  const template = BUILT_IN_DISPLAY_TEMPLATES.find((t) => t.key === templateKey);
  if (!template) return [];
  const names: string[] = [];
  for (const content of Object.values(template.slotContent)) {
    if ("module" in content && !names.includes(content.module)) {
      names.push(content.module);
    }
  }
  return names;
}

function builtInGalleryEntries(): GalleryEntry[] {
  return BUILT_IN_DISPLAY_TEMPLATES.map((template) => {
    const layout = BUILT_IN_DISPLAY_LAYOUTS.find((l) => l.key === template.layoutKey);
    return {
      name: template.name,
      delivery: "Built-in" as const,
      templateKey: template.key,
      moduleNames: builtInModuleNames(template.key),
      blurb: layout?.description ?? "",
    };
  });
}

// The extras bundle boards — not seeded, so described statically. Kept in step
// with docs/lobby-display/seeds/README.md and the committed bundle. Exported so a
// test can assert these keys + module lists never drift from the committed bundle
// (F5) — parse the bundle and compare, so a mismatch fails CI.
export const EXTRAS_GALLERY_ENTRIES: GalleryEntry[] = [
  {
    name: "Busy weekend (rotating)",
    delivery: "Extras bundle",
    templateKey: "busy-weekend",
    moduleNames: ["occupancy-grid", "arrivals-board", "notice-board"],
    blurb:
      "A single rotating statement for a packed weekend: the whole-lodge blockout when the lodge is booked out, a tight two-night arrivals board, and a committee notice when one is set.",
  },
  {
    name: "Minimal arrivals strip",
    delivery: "Extras bundle",
    templateKey: "arrivals-strip",
    moduleNames: ["arrivals-board", "welcome"],
    blurb:
      "A compact board for a small secondary screen: tonight's arrivals as a single-night strip (lead name + count) above a welcome panel.",
  },
];

/** A monogram thumbnail placeholder — the board's initials on a tinted tile. */
function GalleryThumb({ name }: { name: string }) {
  const initials = name
    .replace(/[^a-zA-Z ]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <div
      aria-hidden
      className="bg-muted text-muted-foreground flex h-16 w-24 shrink-0 items-center justify-center rounded-md border font-mono text-lg font-semibold"
    >
      {initials}
    </div>
  );
}

function TemplateGallery({
  moduleLabelByName,
}: {
  moduleLabelByName: Map<string, string>;
}) {
  const entries = [...builtInGalleryEntries(), ...EXTRAS_GALLERY_ENTRIES];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Template gallery</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground text-sm">
          The pre-built boards. Built-in boards are seeded into every install and
          appear on <span className="font-medium">Display → Templates</span> ready
          to assign; the extras ship in the importable bundle{" "}
          <InlineCode>display-template-pack.bundle.zip</InlineCode> (Admin → Export
          &amp; Import Setup). Every board also carries the fixed lodge header and
          the info footer. Thumbnails are placeholders — open a live{" "}
          <span className="font-medium">Preview</span> from the Templates page to
          see the real board.
        </p>
        <div className="space-y-3">
          {entries.map((entry) => (
            <div
              key={`${entry.delivery}-${entry.templateKey}`}
              className="flex gap-4 border-b pb-3 last:border-b-0 last:pb-0"
            >
              <GalleryThumb name={entry.name} />
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{entry.name}</span>
                  <Badge
                    variant={entry.delivery === "Built-in" ? "secondary" : "outline"}
                  >
                    {entry.delivery}
                  </Badge>
                </div>
                {entry.blurb && (
                  <p className="text-muted-foreground text-sm">{entry.blurb}</p>
                )}
                <div className="flex flex-wrap items-center gap-1.5 text-sm">
                  <span className="text-muted-foreground">Modules:</span>
                  {entry.moduleNames.map((name) => (
                    <InlineCode key={name}>
                      {moduleLabelByName.get(name) ?? name}
                    </InlineCode>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * "Layout vs Template" — the vocabulary card (#2247).
 *
 * The admin uses three words for two database rows and defined none of them
 * anywhere an operator would look. The definitions are ADR-003 §1 restated in
 * operator language, held once in `display-terminology.ts` and rendered here,
 * on the hub cards, and quoted in `docs/guides/display.md`, so the three
 * surfaces cannot drift apart again.
 */
function LayoutTemplateBoardExplainer() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Layout vs Template</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <dl className="space-y-3">
          {DISPLAY_GLOSSARY.map((entry) => (
            <div key={entry.term}>
              <dt className="font-medium">{entry.term}</dt>
              <dd className="text-muted-foreground text-sm">{entry.oneLiner}</dd>
            </div>
          ))}
        </dl>
        <p className="text-muted-foreground text-sm">
          Only Layouts and Templates are stored — a board is the two of them on a
          screen, which is why the Visual builder saves a Layout and a Template
          together when you compose one. A Template is bound to a screen on the{" "}
          <strong>Devices</strong> page; it renders against whichever lodge that
          screen belongs to.
        </p>
      </CardContent>
    </Card>
  );
}

export default function AdminDisplayReferencePage() {
  const modules = listDisplayModules();
  const conditions = listDisplayConditions();
  const cssTokens = listDisplayCssTokens();

  const [lodges, setLodges] = useState<LodgeOption[]>([]);
  const [lodgeId, setLodgeId] = useState<string>("");
  const [status, setStatus] = useState<ConditionStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lodgeOptionsError, setLodgeOptionsError] = useState<string | null>(null);
  const [lodgeReloadToken, setLodgeReloadToken] = useState(0);

  const refreshStatus = useCallback(async (selectedLodgeId: string) => {
    if (!selectedLodgeId) {
      setError("Choose an explicit lodge before loading live condition status.");
      setStatus(null);
      return;
    }
    setLoading(true);
    setError(null);
    const query = `?lodgeId=${encodeURIComponent(selectedLodgeId)}`;
    const response = await fetch(`/api/admin/display/reference/conditions${query}`);
    if (!response.ok) {
      setError("Could not load the live condition status.");
      setLoading(false);
      return;
    }
    const body = (await response.json()) as {
      lodgeId: string;
      lodgeName: string;
      conditions: Array<{ name: string; value: boolean }>;
    };
    const values: Record<string, boolean> = {};
    for (const entry of body.conditions) values[entry.name] = entry.value;
    setStatus({ lodgeId: body.lodgeId, lodgeName: body.lodgeName, values });
    setLoading(false);
  }, []);

  // Best-effort lodge list (multi-lodge clubs only). A single-lodge club has no
  // lodges endpoint; the status endpoint then resolves the club default.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch("/api/admin/lodges").catch(() => null);
      if (res?.ok && !cancelled) {
        const body = (await res.json()) as {
          lodges?: Array<{ id: string; name: string; active?: boolean }>;
        };
        const active = (body.lodges ?? []).filter((lodge) => lodge.active !== false);
        setLodges(active.map((lodge) => ({ id: lodge.id, name: lodge.name })));
        const firstLodgeId = active[0]?.id ?? "";
        setLodgeId(firstLodgeId);
        setLodgeOptionsError(
          firstLodgeId ? null : "No active lodge is available for live status.",
        );
        if (firstLodgeId) void refreshStatus(firstLodgeId);
      } else if (!cancelled) {
        setLodges([]);
        setLodgeId("");
        setStatus(null);
        setLodgeOptionsError(
          "The lodge list could not be loaded. Live status is stopped rather than silently using a default lodge.",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshStatus, lodgeReloadToken]);

  function onSelectLodge(next: string) {
    setLodgeId(next);
    void refreshStatus(next);
  }

  const conditionsByFamily = CONDITION_FAMILY_ORDER.map((family) => ({
    family,
    entries: conditions.filter((c) => c.family === family),
  })).filter((group) => group.entries.length > 0);

  const paletteTokens = cssTokens.filter((t) => t.family === "display");
  const brandTokens = cssTokens.filter((t) => t.family === "brand");

  const moduleLabelByName = new Map(modules.map((m) => [m.name, m.label]));

  return (
    <div className="space-y-6 p-6">
      <div>
        <BackLink href="/admin/display" label="Lobby Display" />
        <h1 className="mt-2 text-2xl font-bold">{getAdminPage("display-reference").label}</h1>
        <p className="text-muted-foreground">
          The lobby display vocabulary: the modules you can embed, the conditions
          that gate areas, and the CSS tokens you can reference in authored CSS.
          Read-only — nothing here changes any setting.
        </p>
      </div>

      {/* Layout vs Template vs board (#2247) -------------------------------- */}
      <LayoutTemplateBoardExplainer />

      {/* Template gallery (issue #2047) ------------------------------------ */}
      <TemplateGallery moduleLabelByName={moduleLabelByName} />

      {/* Modules ------------------------------------------------------------ */}
      <Card>
        <CardHeader>
          <CardTitle>Modules</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <p className="text-muted-foreground text-sm">
            Each module is embedded in a Layout or Template by its token. CSS
            hooks are the stable class names you may target from authored CSS.
          </p>
          {modules.map((module) => {
            const phrase = dependencyPhrase(module.dependencies, module.dependencyMode);
            return (
              <div
                key={module.name}
                className="space-y-2 border-b pb-4 last:border-b-0 last:pb-0"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{module.label}</span>
                  <InlineCode>{module.name}</InlineCode>
                  <CopyToken token={module.embedToken} />
                </div>
                <p className="text-muted-foreground text-sm">{module.description}</p>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-muted-foreground">Dependencies:</span>
                  {phrase ? (
                    <span>{phrase}</span>
                  ) : (
                    <span className="text-muted-foreground">none</span>
                  )}
                </div>
                {module.contributes.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-muted-foreground">Contributes:</span>
                    {module.contributes.map((name) => (
                      <InlineCode key={name}>{name}</InlineCode>
                    ))}
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-1.5 text-sm">
                  <span className="text-muted-foreground">CSS hooks:</span>
                  {module.cssHooks.map((hook) => (
                    <InlineCode key={hook}>{`.${hook}`}</InlineCode>
                  ))}
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Conditions -------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>Conditions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {lodgeOptionsError ? (
            <div role="alert" className="space-y-2 text-sm text-destructive">
              <p>{lodgeOptionsError}</p>
              <Button
                type="button"
                variant="outline"
                onClick={() => setLodgeReloadToken((value) => value + 1)}
              >
                Try again
              </Button>
            </div>
          ) : null}
          <div className="flex flex-wrap items-end gap-3">
            <p className="text-muted-foreground flex-1 text-sm">
              Conditions gate any area (show/hide) and drive rotator eligibility.
              The live indicator shows whether each holds{" "}
              <span className="font-medium">right now</span> for the selected
              lodge — a point-in-time snapshot, refreshed by the button, never
              polled.
            </p>
            {lodges.length > 1 && (
              <div className="space-y-1">
                <Label htmlFor="reference-lodge">Lodge</Label>
                <select
                  id="reference-lodge"
                  className="border-input bg-background h-9 rounded-md border px-3 text-sm"
                  value={lodgeId}
                  onChange={(event) => onSelectLodge(event.target.value)}
                >
                  <option value="">Club default</option>
                  {lodges.map((lodge) => (
                    <option key={lodge.id} value={lodge.id}>
                      {lodge.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <Button
              variant="outline"
              onClick={() => void refreshStatus(lodgeId)}
              disabled={loading || !lodgeId || lodgeOptionsError !== null}
            >
              {loading ? "Refreshing…" : "Refresh"}
            </Button>
          </div>
          <p className="text-sm">
            {error ? (
              <span className="text-destructive">{error}</span>
            ) : status ? (
              <span className="text-muted-foreground">
                Live status for <span className="font-medium">{status.lodgeName}</span>.
              </span>
            ) : (
              <span className="text-muted-foreground">Loading live status…</span>
            )}
          </p>

          {conditionsByFamily.map((group) => (
            <div key={group.family} className="space-y-2">
              <h3 className="text-sm font-semibold">
                {CONDITION_FAMILY_LABEL[group.family]}
              </h3>
              <div className="space-y-3">
                {group.entries.map((condition: DisplayConditionDefinition) => {
                  const value = status?.values[condition.name];
                  return (
                    <div
                      key={condition.name}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1"
                    >
                      <InlineCode>{condition.name}</InlineCode>
                      {value === undefined ? (
                        <Badge variant="outline">—</Badge>
                      ) : value ? (
                        <Badge variant="success">● true now</Badge>
                      ) : (
                        <Badge variant="secondary">○ false now</Badge>
                      )}
                      <span className="text-muted-foreground w-full text-sm sm:w-auto sm:flex-1">
                        {condition.description}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* CSS tokens -------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>CSS tokens</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <p className="text-muted-foreground text-sm">
            Custom properties you may reference as <InlineCode>var(--…)</InlineCode>{" "}
            in a Layout&rsquo;s or Template&rsquo;s CSS.
          </p>

          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Display palette</h3>
            <p className="text-muted-foreground text-sm">
              The board&rsquo;s own dark palette — theme-independent and always
              defined.
            </p>
            <div className="space-y-2">
              {paletteTokens.map((token: DisplayCssToken) => (
                <div key={token.name} className="flex flex-wrap items-center gap-3">
                  <span
                    aria-hidden
                    className="inline-block h-4 w-4 shrink-0 rounded border"
                    style={{ background: DISPLAY_PALETTE_SWATCHES[token.name] }}
                  />
                  <InlineCode>{token.name}</InlineCode>
                  <span className="text-muted-foreground text-sm">
                    {token.description}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Club brand</h3>
            <p className="text-muted-foreground text-sm">
              The club theme&rsquo;s colours and fonts, injected read-only from the
              live theme. Values are per-club, so no swatch is shown here.
            </p>
            <div className="space-y-2">
              {brandTokens.map((token: DisplayCssToken) => (
                <div key={token.name} className="flex flex-wrap items-center gap-3">
                  <InlineCode>{token.name}</InlineCode>
                  <span className="text-muted-foreground text-sm">
                    {token.description}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
