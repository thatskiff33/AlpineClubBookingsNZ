"use client";

import { Radio } from "@/components/ui/radio";
import {
  BULK_EMAIL_CATEGORIES,
  BULK_EMAIL_CATEGORY_LABELS,
  type BulkEmailCategory,
} from "@/lib/email/bulk-audience";
import {
  excludedSuffix,
  peopleCount,
  type RecipientPreview,
} from "../_hooks/use-recipient-counts";

function previewText(
  category: BulkEmailCategory | null,
  preview: RecipientPreview,
) {
  if (!category) return "Choose the kind of message to see who will receive it.";
  if (preview.status === "failed") {
    return "Could not count recipients. The send still applies each member's preferences.";
  }
  if (preview.status !== "ready") return "Counting recipients...";
  const { counts } = preview;
  return `Will be sent to ${counts.eligibleRecipients} of ${peopleCount(counts.totalRecipients)}${excludedSuffix(counts)}.`;
}

/**
 * #4987: the sender chooses club notice or newsletter for every message, with
 * nothing preselected, because the two reach different members. The live count
 * below the choice comes from the same query the send uses.
 */
export function MessageKindFieldset({
  category,
  onChange,
  preview,
}: {
  category: BulkEmailCategory | null;
  onChange: (category: BulkEmailCategory) => void;
  preview: RecipientPreview;
}) {
  return (
    <>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Kind of message</legend>
        {BULK_EMAIL_CATEGORIES.map((option) => (
          <label
            key={option}
            htmlFor={`category-${option}`}
            className="flex items-start gap-2 text-sm"
          >
            <Radio
              id={`category-${option}`}
              name="category"
              className="mt-0.5"
              value={option}
              checked={category === option}
              onChange={() => onChange(option)}
            />
            <span>
              <span className="font-medium">
                {BULK_EMAIL_CATEGORY_LABELS[option].label}
              </span>
              <span className="block text-xs text-muted-foreground">
                {BULK_EMAIL_CATEGORY_LABELS[option].description}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      <p
        className="text-sm text-muted-foreground"
        data-testid="communications-recipient-preview"
        aria-live="polite"
      >
        {previewText(category, preview)}
      </p>
    </>
  );
}
