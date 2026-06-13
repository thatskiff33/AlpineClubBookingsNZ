"use client";

import type { CSSProperties } from "react";
import { useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
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
  MAX_LOGO_DATA_URL_BYTES,
  buildClubThemeCss,
  clubThemeUpdateSchema,
  fontCssVariable,
  fontLabel,
  getContrastWarnings,
  isValidLogoDataUrl,
  type ClubThemeColourKey,
  type ClubThemeFontKey,
  type ClubThemeValues,
  type ContrastWarning,
} from "@/lib/club-theme-schema";

type SiteStyleThemeResponse = ClubThemeValues & {
  completedAt: string | null;
  contrastWarnings: ContrastWarning[];
};

type SiteStyleWizardProps = {
  initialTheme: SiteStyleThemeResponse;
};

const steps = [
  { id: "colours", label: "Colours", icon: Palette },
  { id: "fonts", label: "Fonts", icon: Type },
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

function previewStyle(values: ClubThemeValues): CSSProperties {
  return {
    "--brand-gold": values.brandGold,
    "--brand-charcoal": values.brandCharcoal,
    "--brand-deep": values.brandDeep,
    "--brand-ridge": values.brandRidge,
    "--brand-mist": values.brandMist,
    "--brand-snow": values.brandSnow,
    "--brand-safety": values.brandSafety,
    "--font-website-heading": `var(${fontCssVariable(values.headingFontKey)})`,
    "--font-website-body": `var(${fontCssVariable(values.bodyFontKey)})`,
  } as CSSProperties;
}

export function SiteStyleWizard({ initialTheme }: SiteStyleWizardProps) {
  const [values, setValues] = useState<ClubThemeValues>({
    brandGold: initialTheme.brandGold,
    brandCharcoal: initialTheme.brandCharcoal,
    brandDeep: initialTheme.brandDeep,
    brandRidge: initialTheme.brandRidge,
    brandMist: initialTheme.brandMist,
    brandSnow: initialTheme.brandSnow,
    brandSafety: initialTheme.brandSafety,
    headingFontKey: initialTheme.headingFontKey,
    bodyFontKey: initialTheme.bodyFontKey,
    logoDataUrl: initialTheme.logoDataUrl,
  });
  const [completedAt, setCompletedAt] = useState(initialTheme.completedAt);
  const [step, setStep] = useState<StepId>("colours");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedMessage, setSavedMessage] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const stepIndex = steps.findIndex((item) => item.id === step);
  const fieldErrors = useMemo(() => {
    const parsed = clubThemeUpdateSchema.safeParse(themePayload(values, false));
    if (parsed.success) {
      return {};
    }
    return parsed.error.flatten().fieldErrors;
  }, [values]);
  const contrastWarnings = useMemo(() => getContrastWarnings(values), [values]);
  const cssPreview = useMemo(() => buildClubThemeCss(values), [values]);

  function updateColour(key: ClubThemeColourKey, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
    setSavedMessage("");
  }

  function updateFont(key: "headingFontKey" | "bodyFontKey", value: ClubThemeFontKey) {
    setValues((current) => ({ ...current, [key]: value }));
    setSavedMessage("");
  }

  async function save(completeSetup: boolean) {
    setSaving(true);
    setError("");
    setSavedMessage("");

    try {
      const response = await fetch("/api/admin/site-style", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(themePayload(values, completeSetup)),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.theme) {
        throw new Error(responseErrorMessage(body, "Failed to save site style"));
      }

      const theme = body.theme as SiteStyleThemeResponse;
      setValues({
        brandGold: theme.brandGold,
        brandCharcoal: theme.brandCharcoal,
        brandDeep: theme.brandDeep,
        brandRidge: theme.brandRidge,
        brandMist: theme.brandMist,
        brandSnow: theme.brandSnow,
        brandSafety: theme.brandSafety,
        headingFontKey: theme.headingFontKey,
        bodyFontKey: theme.bodyFontKey,
        logoDataUrl: theme.logoDataUrl,
      });
      setCompletedAt(theme.completedAt);
      setSavedMessage(completeSetup ? "Site style is complete." : "Site style saved.");
      return true;
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "Failed to save site style",
      );
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function goNext() {
    const saved = await save(false);
    if (saved && stepIndex < steps.length - 1) {
      setStep(steps[stepIndex + 1].id);
    }
  }

  async function finish() {
    const saved = await save(true);
    if (saved) {
      setStep("review");
    }
  }

  function resetNeutral() {
    setValues(DEFAULT_CLUB_THEME_VALUES);
    setCompletedAt(null);
    setSavedMessage("");
    setError("");
  }

  function readLogo(file: File) {
    setError("");
    if (file.size > MAX_LOGO_DATA_URL_BYTES) {
      setError("Logo must be 900KB or smaller.");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      if (!isValidLogoDataUrl(dataUrl)) {
        setError("Logo must be a PNG, JPEG, WebP, or GIF image data URL.");
        return;
      }
      setValues((current) => ({ ...current, logoDataUrl: dataUrl }));
      setSavedMessage("");
    };
    reader.onerror = () => setError("Logo could not be read.");
    reader.readAsDataURL(file);
  }

  const activeStep = steps[stepIndex];
  const ActiveStepIcon = activeStep.icon;
  const hasFieldErrors = Object.values(fieldErrors).some(
    (messages) => messages && messages.length > 0,
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Style Setup Wizard</CardTitle>
            <CardDescription>
              {completedAt
                ? "The public website is using this style."
                : "The public website stays on the setup holding page until this is finished."}
            </CardDescription>
          </div>
          <Badge variant={completedAt ? "success" : "warning"}>
            {completedAt ? "Complete" : "Setup required"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-2 sm:grid-cols-4">
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
                    ? "border-brand-gold bg-brand-gold/20 text-brand-charcoal"
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
              <ActiveStepIcon className="h-5 w-5 text-brand-charcoal" />
              <h2 className="text-lg font-semibold text-slate-900">
                {activeStep.label}
              </h2>
            </div>

            {step === "colours" && (
              <div className="grid gap-4 sm:grid-cols-2">
                {CLUB_THEME_COLOUR_FIELDS.map((field) => (
                  <div key={field.key} className="space-y-2">
                    <Label htmlFor={field.key}>{field.label}</Label>
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
                      />
                      <Input
                        value={values[field.key]}
                        onChange={(event) =>
                          updateColour(field.key, event.target.value)
                        }
                        aria-label={`${field.label} value`}
                      />
                    </div>
                    {fieldErrors[field.key]?.[0] && (
                      <p className="text-sm text-red-700">
                        {fieldErrors[field.key]?.[0]}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}

            {step === "fonts" && (
              <div className="grid gap-5 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Heading font</Label>
                  <Select
                    value={values.headingFontKey}
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
                      readLogo(file);
                    }
                    event.target.value = "";
                  }}
                />
                <div className="flex flex-wrap gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload className="mr-2 h-4 w-4" />
                    Choose logo
                  </Button>
                  {values.logoDataUrl && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setValues((current) => ({ ...current, logoDataUrl: null }));
                        setSavedMessage("");
                      }}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Remove logo
                    </Button>
                  )}
                </div>
                {fieldErrors.logoDataUrl?.[0] && (
                  <p className="text-sm text-red-700">
                    {fieldErrors.logoDataUrl?.[0]}
                  </p>
                )}
              </div>
            )}

            {step === "review" && (
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-md border p-4">
                    <p className="text-sm font-medium text-slate-900">Fonts</p>
                    <p className="mt-2 text-sm text-slate-600">
                      Heading: {fontLabel(values.headingFontKey)}
                    </p>
                    <p className="text-sm text-slate-600">
                      Body: {fontLabel(values.bodyFontKey)}
                    </p>
                  </div>
                  <div className="rounded-md border p-4">
                    <p className="text-sm font-medium text-slate-900">Logo</p>
                    <p className="mt-2 text-sm text-slate-600">
                      {values.logoDataUrl ? "Custom logo stored" : "Club name fallback"}
                    </p>
                  </div>
                </div>
                <pre className="max-h-40 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100">
                  {cssPreview}
                </pre>
              </div>
            )}
          </section>

          <aside className="space-y-4">
            <div
              className="website-theme overflow-hidden rounded-md border border-brand-ridge/25 bg-brand-snow text-brand-deep"
              style={previewStyle(values)}
            >
              <div className="bg-brand-charcoal px-5 py-4 text-brand-snow">
                <div className="flex items-center gap-3">
                  {values.logoDataUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={values.logoDataUrl}
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

            {contrastWarnings.length > 0 && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
                <div className="mb-2 flex items-center gap-2 font-medium">
                  <AlertTriangle className="h-4 w-4" />
                  Contrast warnings
                </div>
                <ul className="space-y-1">
                  {contrastWarnings.map((warning) => (
                    <li key={warning.id}>{warning.message}</li>
                  ))}
                </ul>
              </div>
            )}

            {error && (
              <div className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-800">
                {error}
              </div>
            )}
            {savedMessage && (
              <div className="rounded-md border border-green-300 bg-green-50 p-4 text-sm text-green-800">
                {savedMessage}
              </div>
            )}
          </aside>
        </div>

        <div className="flex flex-wrap justify-between gap-3 border-t pt-5">
          <Button type="button" variant="outline" onClick={resetNeutral}>
            <RotateCcw className="mr-2 h-4 w-4" />
            Reset neutral
          </Button>
          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => setStep(steps[Math.max(0, stepIndex - 1)].id)}
              disabled={stepIndex === 0 || saving}
            >
              Back
            </Button>
            {stepIndex < steps.length - 1 ? (
              <Button type="button" onClick={goNext} disabled={saving || hasFieldErrors}>
                {saving ? "Saving..." : "Save and next"}
              </Button>
            ) : (
              <Button type="button" onClick={finish} disabled={saving || hasFieldErrors}>
                {saving ? "Saving..." : "Finish setup"}
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
