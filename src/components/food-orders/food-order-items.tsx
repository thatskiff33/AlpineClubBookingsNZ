"use client";

import { Check } from "lucide-react";

import { useClubTime } from "@/components/club-time-provider";
import { Checkbox } from "@/components/ui/checkbox";
import { requireInstant } from "@/lib/club-time";
import { formatFoodOrderItemLine, type FoodOrderUnitValue } from "@/lib/food-order-rules";

/**
 * A food order's item lines (fork #121; owner change, 13 Nov 2026: food can
 * arrive in parts, so receipt is ticked item by item).
 *
 * With `selectable` (the server said `canManage` and the order is still Open)
 * every unreceived item is a labelled checkbox; a received item shows ticked
 * and disabled, with when and by whom. Otherwise it is a read-only list with the
 * same received markers. Received is final, so a received item can never be
 * unticked here.
 */

export type FoodOrderItemView = {
  id: string;
  description: string;
  quantity: string;
  unit: FoodOrderUnitValue;
  receivedAt: string | null;
  receivedBy: string | null;
};

function ReceivedNote({ item }: { item: FoodOrderItemView }) {
  const club = useClubTime();
  if (!item.receivedAt) return null;
  return (
    <span className="block text-xs text-muted-foreground">
      Received {club.instantDate(requireInstant(item.receivedAt))}
      {item.receivedBy ? ` by ${item.receivedBy}` : ""}
    </span>
  );
}

export function FoodOrderItems({
  orderKey,
  items,
  selectable,
  selected,
  disabled,
  onToggle,
}: {
  /** Distinguishes element ids when the same order is shown twice. */
  orderKey: string;
  items: readonly FoodOrderItemView[];
  selectable: boolean;
  selected: ReadonlySet<string>;
  disabled: boolean;
  onToggle: (itemId: string, checked: boolean) => void;
}) {
  if (!selectable) {
    return (
      <ul className="space-y-1 text-sm">
        {items.map((item) => (
          <li key={item.id} className="flex items-start gap-2">
            {item.receivedAt ? (
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-label="Received" />
            ) : (
              <span className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            )}
            <span>
              {formatFoodOrderItemLine(item)}
              <ReceivedNote item={item} />
            </span>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <fieldset className="space-y-2">
      <legend className="sr-only">Items received</legend>
      {items.map((item) => {
        const inputId = `food-item-received-${orderKey}-${item.id}`;
        const received = item.receivedAt !== null;
        return (
          <div key={item.id} className="flex items-start gap-2 text-sm">
            <span className="mt-0.5 inline-flex">
              <Checkbox
                id={inputId}
                checked={received || selected.has(item.id)}
                disabled={received || disabled}
                onCheckedChange={(checked) => onToggle(item.id, checked)}
              />
            </span>
            <label htmlFor={inputId} className="leading-snug">
              {formatFoodOrderItemLine(item)}
              <ReceivedNote item={item} />
            </label>
          </div>
        );
      })}
    </fieldset>
  );
}
