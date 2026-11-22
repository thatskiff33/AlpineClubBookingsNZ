"use client";

import { useId } from "react";
import { Radio } from "@/components/ui/radio";
import { EDIT_REFUND_CREDIT_CHOICE_LABEL, editRefundChoiceLabel } from "@/lib/edit-refund-route";
import type { HostingCoverageLinkedMovePromptData } from "@/lib/hosting-coverage-linked-move-client";

/**
 * The linked move's ONE card-or-credit question (#3232), asked when moving the
 * other bookings too brings money back on them. Moved out of
 * `edit-booking-panel.tsx` (#5303) as pure presentation.
 *
 * #5303: the refund option is labelled by the route each booking's refund
 * really takes (`refundRoute`, the settlement's own answer), so a bank-transfer
 * refund is never offered as the card.
 */
export function LinkedMoveSettlementMethod({
  prompt,
  method,
  disabled,
  onChange,
}: {
  prompt: Pick<HostingCoverageLinkedMovePromptData, "combinedOrganiserRefundCents" | "refundRoute"> | null;
  method: "card" | "credit" | null;
  disabled: boolean;
  onChange: (method: "card" | "credit") => void;
}) {
  const id = useId();
  return (
    <div
      className="space-y-2 rounded-md border p-3 text-sm"
      role="status"
      data-testid="linked-move-settlement-method"
    >
      <p className="font-medium">Return method</p>
      <p className="text-xs text-muted-foreground">
        Moving both bookings brings money back on the other booking.{(prompt?.combinedOrganiserRefundCents ?? 0) > 0 ? " Choose where yours goes; the same choice covers every booking you paid for. A group organiser's refund goes back to them." : " Choose where it goes; the same choice covers both."}
      </p>
      <label htmlFor={`${id}-card`} className="flex cursor-pointer items-start gap-2">
        <Radio
          id={`${id}-card`}
          name="linkedMoveSettlementMethod"
          value="card"
          className="mt-1"
          checked={method === "card"}
          disabled={disabled}
          onChange={() => onChange("card")}
        />
        <span>{editRefundChoiceLabel(prompt?.refundRoute ?? "CARD")}</span>
      </label>
      <label htmlFor={`${id}-credit`} className="flex cursor-pointer items-start gap-2">
        <Radio
          id={`${id}-credit`}
          name="linkedMoveSettlementMethod"
          value="credit"
          className="mt-1"
          checked={method === "credit"}
          disabled={disabled}
          onChange={() => onChange("credit")}
        />
        <span>{EDIT_REFUND_CREDIT_CHOICE_LABEL}</span>
      </label>
    </div>
  );
}
