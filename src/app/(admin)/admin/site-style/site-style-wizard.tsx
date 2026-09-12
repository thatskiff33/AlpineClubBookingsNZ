"use client";

import type { CSSProperties } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  Code,
  ImageIcon,
  Palette,
  RotateCcw,
  Trash2,
  Type,
  Upload,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OccupancyMeter } from "@/components/ui/occupancy-meter";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CLUB_THEME_COLOUR_FIELDS,
  CLUB_THEME_FONT_OPTIONS,
  DEFAULT_CLUB_THEME_VALUES,
  buildClubThemeCss,
  deriveAppMutedForeground,
  deriveBrandShims,
  fontCssVariable,
  fontLabel,
  getContrastWarnings,
  sanitiseRawCss,
  themeSeedsFromValues,
  type ClubThemeColourKey,
  type ClubThemeFontKey,
  type ClubThemeValues,
  type ContrastWarning,
} from "@/lib/club-theme-schema";
import { buildThemeSubstrate } from "@/lib/theme/theme-substrate";
import { buildAppThemeTokens } from "@/lib/theme/app-tokens";
import { must } from "@/lib/indexed-access";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  AdminForbiddenSaveNotice,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";

// Type-only reference to the lazy-loaded zod schema. `typeof import(...)` in a
// type position emits no runtime import, so naming the schema's type here never
// pulls zod into the admin/site-style client bundle (#1278).
type ClubThemeUpdateSchema =
  (typeof import("@/lib/club-theme-update-schema"))["clubThemeUpdateSchema"];

type SiteStyleThemeResponse = ClubThemeValues & {
  completedAt: string | null;
  contrastWarnings: ContrastWarning[];
};

type SiteStyleWizardProps = {
  initialTheme: SiteStyleThemeResponse;
};

/**
 * Client-side guard mirroring MAX_MEDIA_IMAGE_BYTES on the upload route (#2322).
 * Duplicated as a literal rather than imported so the server-only media helpers
 * stay out of this client bundle; the server enforces the real cap regardless.
 */
const MAX_LOGO_UPLOAD_BYTES = 2 * 1024 * 1024;

const steps = [
  { id: "colours", label: "Colours", icon: Palette },
  { id: "fonts", label: "Fonts", icon: Type },
  { id: "raw-css", label: "Raw CSS", icon: Code },
  { id: "logo", label: "Logo", icon: ImageIcon },
  { id: "review", label: "Review", icon: CheckCircle2 },
] as const;

type StepId = (typeof steps)[number]["id"];

function responseErrorMessage(body: unknown, fallback: string) {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "string"
  ) {
    return body.error;
  }
  return fallback;
}

function themePayload(values: ClubThemeValues, completeSetup: boolean) {
  return {
    ...values,
    completeSetup,
  };
}

/**
 * The inline variables the live preview overlays on `app-theme-scope`.
 *
 * `--app-muted-foreground*` are here because they are DERIVED, not picked
 * (#2145): `globals.css` resolves `--muted-foreground` from them, so emitting
 * only the `--brand-*` values would leave the preview painting the STATIC
 * fallback — the default palette's tone — no matter which palette is being
 * edited. That made the one screen where an admin evaluates this feature the one
 * screen that showed the wrong colour, and for an endpoint-crossing palette it
 * could show a sub-AA sample of a tone that ships perfectly readable.
 */
function previewStyle(values: ClubThemeValues): CSSProperties {
  const muted = deriveAppMutedForeground(values);
  const brand = deriveBrandShims(values);
  // #2187 (c) — the preview emits the FULL generated substrate set via the same
  // shipping emitter as `buildClubThemeAppCss` (`--gen-*` / `--gen-*-dark`), not
  // just the `--brand-*` shims, so the sample paints exactly the palette that
  // ships for the seeds being edited.
  const generated = buildAppThemeTokens(themeSeedsFromValues(values))
    .tokens as Record<string, string>;
  return {
    ...generated,
    "--app-muted-foreground": muted.light,
    "--app-muted-foreground-dark": muted.dark,
    "--brand-gold": brand.gold,
    "--brand-charcoal": brand.charcoal,
    "--brand-deep": brand.deep,
    "--brand-ridge": brand.ridge,
    "--brand-mist": brand.mist,
    "--brand-snow": brand.snow,
    "--brand-safety": brand.safety,
    "--font-website-heading": `var(${fontCssVariable(values.headingFontKey)})`,
    "--font-website-body": `var(${fontCssVariable(values.bodyFontKey)})`,
  } as CSSProperties;
}

/**
 * The adjusted-colour disclosure (#2187 D, replaces the blocking contrast gate).
 *
 * A seed is never rejected: the vendored generator adjusts a pathological pick
 * so the shipped scale clears the guarantee sweep. This computes, per seed, the
 * colour that actually SHIPS (the generator's step-9 accent for the primary/
 * support seeds; the derived neutral character for the neutral seed) so the
 * wizard can show a before → after swatch pair whenever the two differ.
 */
type SeedAdjustment = {
  key: ClubThemeColourKey;
  label: string;
  before: string;
  after: string;
};

function seedAdjustments(values: ClubThemeValues): SeedAdjustment[] {
  const light = buildThemeSubstrate(themeSeedsFromValues(values), "light");
  // The generator always builds these two hue scales and a 12-step neutral
  // ramp, and `ThemeSubstrate` types them as an open record and plain arrays,
  // so the guarantee lives in the builder rather than the type. `must` names
  // the assumption at the point it is made, the way `theme/app-tokens.ts`
  // reads the same three values (#2800, `INV-SSOT`) — a substrate short of a
  // scale would otherwise put the string "undefined" in a swatch.
  const accentScale = must(
    light.scales.accent,
    "seedAdjustments: the light substrate has no accent scale",
  );
  const supportScale = must(
    light.scales.support,
    "seedAdjustments: the light substrate has no support scale",
  );
  const shipped: Record<ClubThemeColourKey, string> = {
    brandGold: must(
      accentScale.hex[8],
      "seedAdjustments: the light accent scale has no step 9",
    ),
    brandSafety: must(
      supportScale.hex[8],
      "seedAdjustments: the light support scale has no step 9",
    ),
    brandDeep: must(
      light.neutralHex[11],
      "seedAdjustments: the light neutral ramp has no step 12",
    ),
  };
  const differs = (a: string, b: string) => a.toLowerCase() !== b.toLowerCase();
  return CLUB_THEME_COLOUR_FIELDS.filter((field) =>
    differs(values[field.key], shipped[field.key]),
  ).map((field) => ({
    key: field.key,
    label: field.label,
    before: values[field.key],
    after: shipped[field.key],
  }));
}

export function SiteStyleWizard({ initialTheme }: SiteStyleWizardProps) {
  const router = useRouter();
  const canEdit = useAdminAreaEditAccess("content");
  const [forbidden, setForbidden] = useState(false);
  const [values, setValues] = useState<ClubThemeValues>({
    brandGold: initialTheme.brandGold,
    brandDeep: initialTheme.brandDeep,
    brandSafety: initialTheme.brandSafety,
    headingFontKey: initialTheme.headingFontKey,
    bodyFontKey: initialTheme.bodyFontKey,
    logoUrl: initialTheme.logoUrl ?? null,
    logoDataUrl: initialTheme.logoDataUrl,
    // Held for type completeness and merged into the save payload from the
    // separate `rawCss` buffer below. Live edits never write it, so a keystroke
    // in the Raw CSS tab does not change `values`' identity and therefore does
    // not re-run the (expensive) colour-scale memos keyed on `[values]`.
    rawCss: initialTheme.rawCss ?? "",
  });
  // Raw CSS lives in its own state so typing it stays cheap: it feeds none of
  // the Radix colour-scale generation (contrast warnings, seed adjustments, the
  // live preview, the generated-CSS core) — it is only appended, as a string,
  // to the generated stylesheet. Keeping it out of `values` means those memos
  // and the preview do not recompute on every character (perf fix).
  const [rawCss, setRawCss] = useState<string>(initialTheme.rawCss ?? "");
  const [completedAt, setCompletedAt] = useState(initialTheme.completedAt);
  const [step, setStep] = useState<StepId>("colours");
  const [saving, setSaving] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [error, setError] = useState("");
  const [savedMessage, setSavedMessage] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const stepIndex = steps.findIndex((item) => item.id === step);
  // Live inline field validation uses the zod update schema, which is code-split
  // out of this route's initial bundle and lazy-loaded on mount (#1278,
  // follow-up from #1197). Until it resolves, inline field errors stay empty;
  // the synchronous contrast gate below and the server-side validation on save
  // still guard the payload, so degrading gracefully here is safe.
  const [updateSchema, setUpdateSchema] =
    useState<ClubThemeUpdateSchema | null>(null);
  const [fieldErrors, setFieldErrors] = useState<
    Record<string, string[] | undefined>
  >({});
  const [logoBudget, setLogoBudget] = useState<{
    isWithinBudget: (value: string) => boolean;
    message: string;
  } | null>(null);
  /**
   * The inlined logo as the SERVER last reported it (#2322). The 64KB budget
   * applies only to a value the admin actually changed, so a deployment already
   * storing a large data URI keeps saving normally; comparing against this ref
   * (rather than current state) means editing and reverting does not trip it.
   */
  const serverLogoDataUrlRef = useRef<string | null>(
    initialTheme.logoDataUrl ?? null,
  );
  /**
   * Bumped on every upload start AND on Remove, so a response that lands after
   * the admin moved on is discarded — a Remove clicked mid-upload must win.
   */
  const logoGenerationRef = useRef(0);

  useEffect(() => {
    let active = true;
    void import("@/lib/club-theme-update-schema").then((module) => {
      if (active) {
        setUpdateSchema(module.clubThemeUpdateSchema);
        setLogoBudget(() => ({
          isWithinBudget: module.isLogoDataUrlWithinWriteBudget,
          message: module.LOGO_DATA_URL_WRITE_BUDGET_MESSAGE,
        }));
      }
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!updateSchema) {
      setFieldErrors({});
      return;
    }
    const parsed = updateSchema.safeParse(
      themePayload({ ...values, rawCss }, false),
    );
    const errors: Record<string, string[] | undefined> = parsed.success
      ? {}
      : parsed.error.flatten().fieldErrors;

    // The zod layer is stateless and cannot know what is already stored, so the
    // 64KB budget is checked here against the server's value — and on the server
    // itself, which is authoritative.
    const logo = values.logoDataUrl;
    if (
      logoBudget &&
      logo &&
      logo !== serverLogoDataUrlRef.current &&
      !logoBudget.isWithinBudget(logo)
    ) {
      errors.logoDataUrl = [logoBudget.message];
    }

    setFieldErrors(errors);
  }, [updateSchema, values, rawCss, logoBudget]);
  const contrastWarnings = useMemo(() => getContrastWarnings(values), [values]);
  // #2187: a seed is never rejected for contrast — the generator adjusts a
  // pathological pick and the substrate clears the guarantee sweep by
  // construction. Instead of blocking the save, disclose which seeds the
  // generator adjusted (before → after) so the choice is transparent.
  const adjustments = useMemo(() => seedAdjustments(values), [values]);
  const advisoryContrastWarnings = useMemo(
    () => contrastWarnings.filter((warning) => warning.ratio === null),
    [contrastWarnings],
  );
  // Memoised once and shared by both preview panes below. `previewStyle` runs
  // the full app-token generation (two substrate builds); calling it inline in
  // JSX ran it twice per render, so this both dedupes it and keeps it off the
  // Raw CSS keystroke path (it does not depend on rawCss).
  const previewStyleValue = useMemo(() => previewStyle(values), [values]);
  // The generated-CSS preview is split so a Raw CSS keystroke never re-runs the
  // colour pipeline. `coreThemeCss` (keyed on `values`) is the heavy part; the
  // live rawCss is only appended — sanitised the same way buildClubThemeCss does
  // it internally — so the result stays byte-identical to what ships.
  const coreThemeCss = useMemo(
    () => buildClubThemeCss({ ...values, rawCss: "" }),
    [values],
  );
  const cssPreview = useMemo(() => {
    const safe = sanitiseRawCss(rawCss);
    return safe ? `${coreThemeCss}\n${safe}` : coreThemeCss;
  }, [coreThemeCss, rawCss]);

  function updateColour(key: ClubThemeColourKey, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
    setSavedMessage("");
  }

  function updateFont(
    key: "headingFontKey" | "bodyFontKey",
    value: ClubThemeFontKey,
  ) {
    setValues((current) => ({ ...current, [key]: value }));
    setSavedMessage("");
  }

  function updateRawCss(value: string) {
    setRawCss(value);
    setSavedMessage("");
  }

  async function save(completeSetup: boolean) {
    setSaving(true);
    setError("");
    setSavedMessage("");
    setForbidden(false);

    try {
      const response = await fetch("/api/admin/site-style", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          themePayload({ ...values, rawCss }, completeSetup),
        ),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.theme) {
        if (response.status === 403) setForbidden(true);
        throw new Error(
          responseErrorMessage(body, "Failed to save site style"),
        );
      }

      const theme = body.theme as SiteStyleThemeResponse;
      setValues({
        brandGold: theme.brandGold,
        brandDeep: theme.brandDeep,
        brandSafety: theme.brandSafety,
        headingFontKey: theme.headingFontKey,
        bodyFontKey: theme.bodyFontKey,
        logoUrl: theme.logoUrl ?? null,
        logoDataUrl: theme.logoDataUrl,
        rawCss: theme.rawCss ?? "",
      });
      // Keep the live Raw CSS buffer in step with what the server persisted.
      setRawCss(theme.rawCss ?? "");
      // The server is now the authority on what is stored, so the "unchanged"
      // baseline for the 64KB budget moves with it (#2322).
      serverLogoDataUrlRef.current = theme.logoDataUrl ?? null;
      setCompletedAt(theme.completedAt);
      setSavedMessage(
        completeSetup ? "Site style is complete." : "Site style saved.",
      );
      router.refresh();
      return true;
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to save site style",
      );
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function goNext() {
    const saved = await save(false);
    // The next step IS the "there is a step after this one" check the length
    // arithmetic was expressing — read once (#2801).
    const nextStep = steps[stepIndex + 1];
    if (saved && nextStep) {
      setStep(nextStep.id);
    }
  }

  async function finish() {
    const saved = await save(true);
    if (saved) {
      setStep("review");
    }
  }

  function resetNeutral() {
    // Resetting clears the logo along with everything else, so it must invalidate
    // an in-flight upload the same way Remove does — otherwise a response landing
    // afterwards would re-populate a logo the admin just reset away (#2322).
    logoGenerationRef.current += 1;
    setUploadingLogo(false);
    setValues(DEFAULT_CLUB_THEME_VALUES);
    setRawCss(DEFAULT_CLUB_THEME_VALUES.rawCss);
    setCompletedAt(null);
    setSavedMessage("");
    setError("");
  }

  /**
   * #2322: the logo is uploaded to the server, resized and stored as an image,
   * and only its URL is kept on the theme. The old FileReader flow inlined the
   * whole file as base64 and shipped it on every public page render.
   */
  async function uploadLogo(file: File) {
    setError("");
    if (file.size > MAX_LOGO_UPLOAD_BYTES) {
      setError("Logo must be 2MB or smaller.");
      return;
    }

    const generation = ++logoGenerationRef.current;
    setUploadingLogo(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const response = await fetch("/api/admin/site-style/logo", {
        method: "POST",
        body,
      });
      const payload = await response.json().catch(() => null);

      // The admin removed the logo (or started another upload) while this one
      // was in flight — that action wins; discard this result entirely.
      if (generation !== logoGenerationRef.current) {
        return;
      }

      if (!response.ok) {
        setError(
          (payload as { error?: string } | null)?.error ??
            "Logo could not be uploaded.",
        );
        return;
      }

      const logoUrl = (payload as { logoUrl?: string } | null)?.logoUrl;
      if (!logoUrl) {
        setError("Logo could not be uploaded.");
        return;
      }

      // Clear any legacy inlined logo so the two can never disagree; the server
      // enforces the same rule on save.
      setValues((current) => ({ ...current, logoUrl, logoDataUrl: null }));
      setSavedMessage("Logo uploaded. Save to apply it to the site.");
    } catch {
      if (generation === logoGenerationRef.current) {
        setError("Logo could not be uploaded.");
      }
    } finally {
      if (generation === logoGenerationRef.current) {
        setUploadingLogo(false);
      }
    }
  }

  // `StepId` is derived FROM `steps`, so the wizard's current step always has a
  // definition; `must` says that at the point it is assumed rather than letting
  // an impossible `undefined` reach a heading (#2801).
  const activeStep = must(
    steps.find((item) => item.id === step),
    `site-style wizard: no step definition for "${step}"`,
  );
  const previousStep = stepIndex > 0 ? steps[stepIndex - 1] : undefined;
  const ActiveStepIcon = activeStep.icon;
  const hasFieldErrors = Object.values(fieldErrors).some(
    (messages) => messages && messages.length > 0,
  );
  // Only a malformed field (non-hex value) blocks the save now; contrast is
  // guaranteed by construction, so a low-contrast pick is adjusted, not blocked.
  const saveBlocked = hasFieldErrors;

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
      Your admin role can view the site style but cannot change it. The controls
      below are read-only.
    </AdminViewOnlySectionBanner>
  );

  return (
    <div>
      {viewOnlyBanner}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Style Setup Wizard</CardTitle>
              <CardDescription>
                {completedAt
                  ? "The public website, member area, and admin area are using this style."
                  : "The member and admin areas use this style immediately; the public website stays on the setup holding page until setup is finished."}
              </CardDescription>
            </div>
            <Badge variant={completedAt ? "success" : "warning"}>
              {completedAt ? "Complete" : "Setup required"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {forbidden ? <AdminForbiddenSaveNotice /> : null}
          <div className="grid gap-2 sm:grid-cols-5">
            {steps.map((item) => {
              const Icon = item.icon;
              const active = item.id === step;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setStep(item.id)}
                  className={`flex min-h-11 items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                    active
                      ? "border-brand-gold bg-brand-gold text-brand-charcoal"
                      : "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </button>
              );
            })}
          </div>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
            <section className="space-y-5">
              <div className="flex items-center gap-2">
                <ActiveStepIcon className="h-5 w-5 text-foreground" />
                <h2 className="text-lg font-semibold text-foreground">
                  {activeStep.label}
                </h2>
              </div>

              {step === "colours" && (
                <div className="space-y-5">
                  <div className="rounded-md border bg-muted p-4 text-sm text-muted-foreground">
                    <p className="font-medium text-foreground">
                      Editable brand layer
                    </p>
                    <p className="mt-1">
                      These colours set the identity, neutral warmth, primary
                      actions, navigation, and occupancy meter across the public
                      website, member area, and admin area. The primary accent
                      is glacial teal by default and may be club gold or another
                      accessible brand colour.
                    </p>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    {CLUB_THEME_COLOUR_FIELDS.map((field) => (
                      <div key={field.key} className="space-y-2">
                        <Label htmlFor={field.key}>
                          {field.label}{" "}
                          <span className="text-xs font-normal text-muted-foreground">
                            {field.required ? "(required)" : "(optional)"}
                          </span>
                        </Label>
                        <p className="text-xs text-muted-foreground">
                          {field.role}
                        </p>
                        <div className="flex gap-2">
                          <Input
                            id={field.key}
                            type="color"
                            value={
                              values[field.key].startsWith("#")
                                ? values[field.key]
                                : DEFAULT_CLUB_THEME_VALUES[field.key]
                            }
                            onChange={(event) =>
                              updateColour(field.key, event.target.value)
                            }
                            className="h-10 w-14 shrink-0 p-1"
                            aria-label={`${field.label} swatch`}
                            disabled={!canEdit}
                          />
                          <Input
                            value={values[field.key]}
                            onChange={(event) =>
                              updateColour(field.key, event.target.value)
                            }
                            aria-label={`${field.label} value`}
                            readOnly={!canEdit}
                          />
                        </div>
                        {fieldErrors[field.key]?.[0] && (
                          <p className="text-sm text-danger-11">
                            {fieldErrors[field.key]?.[0]}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="rounded-md border p-4 text-sm text-muted-foreground">
                    <p className="font-medium text-foreground">
                      Fixed semantic layer
                    </p>
                    <p className="mt-1">
                      Success, warning, information, danger/error, and waitlist
                      states use curated light/dark colour pairs. They are not
                      brand pickers, so operational meaning and contrast stay
                      consistent.
                    </p>
                  </div>
                </div>
              )}

              {step === "fonts" && (
                <div className="grid gap-5 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Heading font</Label>
                    <Select
                      value={values.headingFontKey}
                      disabled={!canEdit}
                      onValueChange={(value) =>
                        updateFont("headingFontKey", value as ClubThemeFontKey)
                      }
                    >
                      <SelectTrigger aria-label="Heading font">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {CLUB_THEME_FONT_OPTIONS.map((font) => (
                          <SelectItem key={font.key} value={font.key}>
                            {font.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Body font</Label>
                    <Select
                      value={values.bodyFontKey}
                      disabled={!canEdit}
                      onValueChange={(value) =>
                        updateFont("bodyFontKey", value as ClubThemeFontKey)
                      }
                    >
                      <SelectTrigger aria-label="Body font">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {CLUB_THEME_FONT_OPTIONS.map((font) => (
                          <SelectItem key={font.key} value={font.key}>
                            {font.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}

              {step === "raw-css" && (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    Add custom CSS rules that will be appended to the generated
                    theme stylesheet on the public website only. Member and
                    admin areas receive the validated brand variables above,
                    never raw CSS. Use sparingly — prefer colour and font
                    settings where possible.
                  </p>
                  {/* Tall default so it uses the space under the editor, and stays
                    manually resizable (resize-y restores the drag handle). */}
                  <textarea
                    value={rawCss}
                    onChange={(e) => updateRawCss(e.target.value)}
                    rows={40}
                    spellCheck={false}
                    readOnly={!canEdit}
                    placeholder={`/* Example */\n.dynamic-header {\n  background: linear-gradient(135deg, #1a1a2e, #16213e);\n}`}
                    className="w-full resize-y rounded-md border border-slate-300 bg-white p-3 font-mono text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-400"
                  />
                  <p
                    className={`text-sm ${
                      rawCss.length > 45_000
                        ? "text-warning-11"
                        : "text-muted-foreground"
                    }`}
                  >
                    {rawCss.length.toLocaleString()} / 50,000 characters used.
                  </p>
                </div>
              )}

              {step === "logo" && (
                <div className="space-y-4">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) {
                        void uploadLogo(file);
                      }
                      event.target.value = "";
                    }}
                  />
                  <div className="flex flex-wrap gap-3">
                    <ViewOnlyActionButton
                      canEdit={canEdit}
                      describeReason={false}
                      type="button"
                      variant="outline"
                      disabled={uploadingLogo}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Upload className="mr-2 h-4 w-4" />
                      {uploadingLogo ? "Uploading…" : "Choose logo"}
                    </ViewOnlyActionButton>
                    {(values.logoUrl || values.logoDataUrl) && (
                      <ViewOnlyActionButton
                        canEdit={canEdit}
                        describeReason={false}
                        type="button"
                        variant="outline"
                        disabled={uploadingLogo}
                        onClick={() => {
                          // Bumping the generation makes any in-flight upload
                          // discard its result, so Remove cannot be undone by a
                          // response that lands afterwards.
                          logoGenerationRef.current += 1;
                          setUploadingLogo(false);
                          setError("");
                          setValues((current) => ({
                            ...current,
                            logoUrl: null,
                            logoDataUrl: null,
                          }));
                          setSavedMessage("");
                        }}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Remove logo
                      </ViewOnlyActionButton>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    PNG, JPEG, WebP, or GIF, up to 2MB. Larger images are shrunk
                    to at most 160px tall and 640px wide — never enlarged — so a
                    high-resolution original is fine. SVG is not accepted.
                  </p>
                  {(fieldErrors.logoUrl?.[0] ??
                    fieldErrors.logoDataUrl?.[0]) && (
                    <p className="text-sm text-danger-11">
                      {fieldErrors.logoUrl?.[0] ?? fieldErrors.logoDataUrl?.[0]}
                    </p>
                  )}
                </div>
              )}

              {step === "review" && (
                <div className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-md border p-4">
                      <p className="text-sm font-medium text-foreground">
                        Fonts
                      </p>
                      <p className="mt-2 text-sm text-muted-foreground">
                        Heading: {fontLabel(values.headingFontKey)}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Body: {fontLabel(values.bodyFontKey)}
                      </p>
                    </div>
                    <div className="rounded-md border p-4">
                      <p className="text-sm font-medium text-foreground">
                        Logo
                      </p>
                      <p className="mt-2 text-sm text-muted-foreground">
                        {values.logoUrl || values.logoDataUrl
                          ? "Custom logo stored"
                          : "Club name fallback"}
                      </p>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-foreground">
                      Generated CSS
                    </p>
                    <pre className="max-h-40 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100">
                      {cssPreview}
                    </pre>
                  </div>
                  {rawCss && (
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-foreground">
                        Raw CSS
                      </p>
                      <pre className="max-h-40 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100">
                        {rawCss}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </section>

            <aside className="space-y-4">
              <div
                className="website-theme overflow-hidden rounded-md border border-brand-ridge/25 bg-brand-snow text-brand-deep"
                style={previewStyleValue}
              >
                <div className="bg-brand-charcoal px-5 py-4 text-brand-snow">
                  <div className="flex items-center gap-3">
                    {values.logoUrl || values.logoDataUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={values.logoUrl || values.logoDataUrl || ""}
                        alt="Logo preview"
                        className="h-10 max-w-36 object-contain"
                      />
                    ) : (
                      <span className="font-heading text-lg font-bold">
                        Club Name
                      </span>
                    )}
                  </div>
                </div>
                <div className="space-y-4 p-5">
                  <p className="website-eyebrow">Preview</p>
                  <h3 className="font-heading text-2xl font-bold text-brand-charcoal">
                    Public website heading
                  </h3>
                  <p className="text-sm leading-6 text-brand-deep/85">
                    This sample uses the selected colours and font variables.
                  </p>
                  <button
                    type="button"
                    className="rounded-md bg-brand-gold px-4 py-2 text-sm font-semibold text-brand-charcoal"
                  >
                    Primary action
                  </button>
                </div>
              </div>

              <div
                className="app-theme-scope space-y-4 overflow-hidden rounded-md border bg-background p-5 text-foreground"
                style={previewStyleValue}
              >
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Member + admin app preview
                  </p>
                  <h3 className="mt-1 text-2xl font-bold">
                    Upcoming lodge stay
                  </h3>
                </div>
                <OccupancyMeter filled={18} capacity={30} label="Occupancy" />
                <button
                  type="button"
                  className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
                >
                  Primary action
                </button>
                <div className="flex flex-wrap gap-2 text-xs font-medium">
                  <span className="rounded-md bg-success-muted px-2 py-1 text-success">
                    Success
                  </span>
                  <span className="rounded-md bg-warning-muted px-2 py-1 text-warning">
                    Warning
                  </span>
                  <span className="rounded-md bg-info-muted px-2 py-1 text-info">
                    Information
                  </span>
                  <span className="rounded-md bg-danger-muted px-2 py-1 text-danger">
                    Danger
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Brand colours and fonts update this app preview. Status
                  colours stay fixed.
                </p>
              </div>

              {adjustments.length > 0 && (
                <div className="rounded-md border border-info-6 bg-info-3 p-4 text-sm text-info-11">
                  <div className="mb-2 flex items-center gap-2 font-medium">
                    <CheckCircle2 className="h-4 w-4" />
                    Colours adjusted for accessibility
                  </div>
                  <p className="mb-3">
                    Your palette always saves. To keep text and controls
                    readable, the generator nudged the colours below. This is
                    what ships:
                  </p>
                  <ul className="space-y-2">
                    {adjustments.map((adjustment) => (
                      <li
                        key={adjustment.key}
                        className="flex items-center gap-2"
                      >
                        <span className="min-w-32 font-medium">
                          {adjustment.label}
                        </span>
                        <span
                          className="inline-block h-4 w-4 shrink-0 rounded-sm border border-black/10"
                          style={{ backgroundColor: adjustment.before }}
                          aria-hidden
                        />
                        <span className="font-mono text-xs">
                          {adjustment.before}
                        </span>
                        <span aria-hidden>→</span>
                        <span
                          className="inline-block h-4 w-4 shrink-0 rounded-sm border border-black/10"
                          style={{ backgroundColor: adjustment.after }}
                          aria-hidden
                        />
                        <span className="font-mono text-xs">
                          {adjustment.after}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {advisoryContrastWarnings.length > 0 && (
                <div className="rounded-md border border-warning-6 bg-warning-3 p-4 text-sm text-warning-11">
                  <div className="mb-2 flex items-center gap-2 font-medium">
                    <AlertTriangle className="h-4 w-4" />
                    Contrast warnings
                  </div>
                  <ul className="space-y-1">
                    {advisoryContrastWarnings.map((warning) => (
                      <li key={warning.id}>{warning.message}</li>
                    ))}
                  </ul>
                </div>
              )}

              {error && (
                <div className="rounded-md border border-danger-6 bg-danger-3 p-4 text-sm text-danger-11">
                  {error}
                </div>
              )}
              {savedMessage && (
                <div className="rounded-md border border-success-6 bg-success-3 p-4 text-sm text-success-11">
                  {savedMessage}
                </div>
              )}
            </aside>
          </div>

          <div className="flex flex-wrap justify-between gap-3 border-t pt-5">
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              type="button"
              variant="outline"
              disabled={uploadingLogo}
              onClick={resetNeutral}
            >
              <RotateCcw className="mr-2 h-4 w-4" />
              Reset neutral
            </ViewOnlyActionButton>
            <div className="flex flex-wrap gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  if (previousStep) setStep(previousStep.id);
                }}
                disabled={!previousStep || saving}
              >
                Back
              </Button>
              {stepIndex < steps.length - 1 ? (
                <ViewOnlyActionButton
                  canEdit={canEdit}
                  describeReason={false}
                  type="button"
                  onClick={goNext}
                  disabled={saving || saveBlocked || uploadingLogo}
                >
                  {saving ? "Saving..." : "Save and next"}
                </ViewOnlyActionButton>
              ) : (
                <ViewOnlyActionButton
                  canEdit={canEdit}
                  describeReason={false}
                  type="button"
                  onClick={finish}
                  disabled={saving || saveBlocked || uploadingLogo}
                >
                  {saving ? "Saving..." : "Finish setup"}
                </ViewOnlyActionButton>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
