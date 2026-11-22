/**
 * The AI Diagnostics provider disclosure (#5243), rendered from its one source
 * (`ai-diagnostics-disclosure.ts`).
 *
 * Hook-free so the server-rendered AI Diagnostics page can show it as well as the
 * Modules page. `acknowledgement` adds the tick the Modules page requires before
 * Diagnostics can be switched on; without it the statement is read-only.
 */
import { Checkbox } from "@/components/ui/checkbox";
import { AI_DIAGNOSTICS_DISCLOSURE } from "@/lib/ai-diagnostics-disclosure";

interface AiDiagnosticsDisclosureProps {
  acknowledgement?: {
    checked: boolean;
    onChange: (checked: boolean) => void;
    disabled?: boolean;
  };
  /** Set where the surrounding section already shows the heading. */
  hideHeading?: boolean;
}

const ACKNOWLEDGEMENT_ID = "ai-diagnostics-disclosure-acknowledgement";

export function AiDiagnosticsDisclosure({
  acknowledgement,
  hideHeading = false,
}: AiDiagnosticsDisclosureProps) {
  const copy = AI_DIAGNOSTICS_DISCLOSURE;
  return (
    <div
      data-testid="ai-diagnostics-disclosure"
      className="space-y-2 rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground"
    >
      {hideHeading ? null : (
        <p className="font-medium text-foreground">{copy.heading}</p>
      )}
      <p>{copy.summary}</p>
      <div>
        <p>{copy.dataSentIntro}</p>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          {copy.dataSent.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
      <p>{copy.retention}</p>
      <p>
        <a
          href={copy.providerPrivacyUrl}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-foreground underline underline-offset-4"
        >
          {copy.providerName}&apos;s privacy notice
        </a>
      </p>
      {acknowledgement ? (
        <div className="flex items-start gap-2 pt-1 text-foreground">
          <Checkbox
            id={ACKNOWLEDGEMENT_ID}
            checked={acknowledgement.checked}
            onCheckedChange={(checked) =>
              acknowledgement.onChange(checked === true)
            }
            disabled={acknowledgement.disabled}
            className="mt-0.5"
          />
          <label htmlFor={ACKNOWLEDGEMENT_ID}>{copy.acknowledgementLabel}</label>
        </div>
      ) : null}
    </div>
  );
}
