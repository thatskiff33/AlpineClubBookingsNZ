"use client";

import { useState } from "react";
import { Loader2, Plus, X } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { compareCalendarDates, parseCalendarDate } from "@/lib/club-time";
import {
  FOOD_ORDER_ITEM_DESCRIPTION_MAX_LENGTH,
  DEFAULT_FOOD_ORDER_UNIT,
  FOOD_ORDER_UNITS,
  FOOD_ORDER_MAX_ITEMS,
  FOOD_ORDER_NOTES_MAX_LENGTH,
  foodOrderItemsProblem,
  foodOrderUnitLabel,
  isFoodOrderUnit,
  parseFoodOrderQuantity,
  type FoodOrderUnitValue,
} from "@/lib/food-order-rules";

/**
 * The Order food form (fork #121). One line per item — a description, a
 * decimal quantity and its Type (owner change, 13 Nov 2026), whose labels are
 * singular when the quantity is exactly 1 — with Add item and Remove; at least
 * one line.
 *
 * The limits and the item rule are imported from `food-order-rules`, the same
 * module the create route validates with, so the form cannot accept something
 * the server refuses. The server is still the authority: its message is shown
 * as it is.
 */

export type FoodOrderFormSubmission = {
  lodgeId: string;
  neededBy: string;
  notes: string;
  /** Quantity as normalised decimal text ("0.5"), never a float. */
  items: Array<{ description: string; quantity: string; unit: FoodOrderUnitValue }>;
};

type Line = { key: number; description: string; quantity: string; unit: FoodOrderUnitValue };

function blankLine(key: number): Line {
  return { key, description: "", quantity: "1", unit: DEFAULT_FOOD_ORDER_UNIT };
}

export function FoodOrderForm({
  lodges,
  today,
  officerLabel,
  onSubmit,
}: {
  lodges: Array<{ id: string; name: string }>;
  /** The club's today, YYYY-MM-DD: the earliest needed-by date. */
  today: string;
  officerLabel: string;
  onSubmit: (submission: FoodOrderFormSubmission) => Promise<void>;
}) {
  const [lodgeId, setLodgeId] = useState(lodges.length === 1 ? (lodges[0]?.id ?? "") : "");
  const [neededBy, setNeededBy] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([blankLine(0)]);
  const [nextKey, setNextKey] = useState(1);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function updateLine(key: number, patch: Partial<Line>) {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
  }

  function addLine() {
    if (lines.length >= FOOD_ORDER_MAX_ITEMS) return;
    setLines((current) => [...current, blankLine(nextKey)]);
    setNextKey((key) => key + 1);
  }

  function removeLine(key: number) {
    setLines((current) => current.filter((line) => line.key !== key));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    // The shared rule decides (`foodOrderItemsProblem` and its
    // `parseFoodOrderQuantity`); the quantity stays text throughout.
    const lineInputs = lines.map((line) => ({
      description: line.description.trim(),
      quantity: line.quantity,
      unit: line.unit,
    }));
    if (!lodgeId) {
      setError("Choose the lodge the food is for.");
      return;
    }
    // Compared as club calendar dates (INV-DATE), never as strings or instants.
    const neededDay = parseCalendarDate(neededBy);
    const todayDay = parseCalendarDate(today);
    if (!neededDay || (todayDay && compareCalendarDates(neededDay, todayDay) < 0)) {
      setError("Choose the date the food is needed by: today or later.");
      return;
    }
    const problem = foodOrderItemsProblem(lineInputs);
    if (problem) {
      setError(problem);
      return;
    }
    const items = lineInputs.map((line) => ({
      ...line,
      quantity: parseFoodOrderQuantity(line.quantity) ?? line.quantity,
    }));
    setSubmitting(true);
    try {
      await onSubmit({ lodgeId, neededBy, notes: notes.trim(), items });
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Something went wrong placing that order. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="space-y-6" onSubmit={(event) => void handleSubmit(event)} noValidate>
      {error ? <Alert variant="error">{error}</Alert> : null}

      <div className="space-y-2">
        <Label htmlFor="food-order-lodge">Lodge</Label>
        <Select value={lodgeId} onValueChange={setLodgeId}>
          <SelectTrigger id="food-order-lodge" className="h-11">
            <SelectValue placeholder="Choose a lodge" />
          </SelectTrigger>
          <SelectContent>
            {lodges.map((lodge) => (
              <SelectItem key={lodge.id} value={lodge.id}>
                {lodge.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="food-order-needed-by">Needed by</Label>
        <Input
          id="food-order-needed-by"
          type="date"
          className="h-11 max-w-[12rem]"
          min={today}
          value={neededBy}
          onChange={(event) => setNeededBy(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Your order goes to the club&apos;s {officerLabel}, who matches it to
          your stay by the lodge and this date.
        </p>
      </div>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Items</legend>
        <p className="text-xs text-muted-foreground">
          One line per item: what it is, how many or how much (more than 0, up to
          two decimal places, for example 0.5 or 250), and its type.
        </p>
        {lines.map((line, index) => {
          const typeId = `food-item-type-${line.key}`;
          return (
            <div
              key={line.key}
              className="grid grid-cols-[5.5rem_minmax(0,1fr)_auto] items-end gap-2 sm:grid-cols-[minmax(0,1fr)_5.5rem_9rem_auto]"
            >
              <div className="col-span-3 space-y-1 sm:col-span-1">
                <Label htmlFor={`food-item-description-${line.key}`}>
                  Item {index + 1}
                </Label>
                <Input
                  id={`food-item-description-${line.key}`}
                  className="h-11"
                  maxLength={FOOD_ORDER_ITEM_DESCRIPTION_MAX_LENGTH}
                  value={line.description}
                  onChange={(event) =>
                    updateLine(line.key, { description: event.target.value })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`food-item-quantity-${line.key}`}>Quantity</Label>
                {/* Text with a decimal keypad, not type="number": the browser
                    would blank a value it cannot parse before validation sees it
                    (see src/lib/money-input.ts). */}
                <Input
                  id={`food-item-quantity-${line.key}`}
                  className="h-11"
                  inputMode="decimal"
                  data-testid="food-item-quantity-input"
                  autoComplete="off"
                  value={line.quantity}
                  onChange={(event) =>
                    updateLine(line.key, { quantity: event.target.value })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={typeId}>Type</Label>
                <Select
                  value={line.unit}
                  onValueChange={(unit) => {
                    if (isFoodOrderUnit(unit)) updateLine(line.key, { unit });
                  }}
                >
                  <SelectTrigger id={typeId} className="h-11">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FOOD_ORDER_UNITS.map((unit) => (
                      <SelectItem key={unit} value={unit}>
                        {foodOrderUnitLabel(line.quantity, unit)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="button"
                variant="outline"
                className="h-11"
                onClick={() => removeLine(line.key)}
                disabled={lines.length <= 1}
                aria-label={`Remove item ${index + 1}`}
              >
                <X className="h-4 w-4" aria-hidden="true" />
                <span className="sr-only sm:not-sr-only sm:ml-1">Remove</span>
              </Button>
            </div>
          );
        })}
        <Button
          type="button"
          variant="outline"
          onClick={addLine}
          disabled={lines.length >= FOOD_ORDER_MAX_ITEMS}
        >
          <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
          Add item
        </Button>
      </fieldset>

      <div className="space-y-2">
        <Label htmlFor="food-order-notes">Note (optional)</Label>
        <Textarea
          id="food-order-notes"
          rows={3}
          maxLength={FOOD_ORDER_NOTES_MAX_LENGTH}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </div>

      <Button type="submit" className="h-11 w-full" disabled={submitting}>
        {submitting ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
        ) : null}
        Send this order
      </Button>
    </form>
  );
}
