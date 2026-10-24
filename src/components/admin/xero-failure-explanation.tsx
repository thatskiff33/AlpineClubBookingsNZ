import { explainXeroFailure } from "@/lib/xero-failure-explanation";

interface XeroFailureExplanationProps {
  code: string | null;
  message: string | null;
  entityType?: string | null;
  /** The tone class for the headline; the two Xero panels colour errors differently. */
  headlineClassName?: string;
}

/**
 * #4278: the failure line of a Xero operation, in plain English, with the raw
 * stored text one click away. Rendered by the operations panel and the Xero
 * activity panel so both say the same thing about one row; the booking page's
 * invoice warning calls `explainXeroFailure` directly.
 */
export function XeroFailureExplanation({
  code,
  message,
  entityType,
  headlineClassName = "text-danger",
}: XeroFailureExplanationProps) {
  const explanation = explainXeroFailure({ code, message, entityType });
  return (
    <div className="space-y-1" data-xero-failure-kind={explanation.kind}>
      <p className={`text-sm font-medium ${headlineClassName}`}>{explanation.headline}</p>
      <p className="text-sm text-muted-foreground">{explanation.whatItMeans}</p>
      <p className="text-sm">
        <span className="font-medium">What to do: </span>
        {explanation.nextStep}
      </p>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">Show technical details</summary>
        <p className="mt-1 break-words font-mono">{explanation.technicalDetail}</p>
      </details>
    </div>
  );
}
