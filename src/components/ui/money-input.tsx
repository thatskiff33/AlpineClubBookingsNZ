"use client";

import * as React from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

import {
  parseDecimalDollarsToCents,
  parseSignedDecimalDollarsToCents,
} from "@/lib/money-input";
import { cn, formatCentsPlain } from "@/lib/utils";

import { Input, type InputProps } from "./input";
import { Label } from "./label";

type NativeMoneyInputProps = Omit<
  InputProps,
  | "defaultValue"
  | "inputMode"
  | "onChange"
  | "type"
  | "value"
>;

export interface MoneyInputProps extends NativeMoneyInputProps {
  /** The draft text, owned by the caller so invalid input remains visible. */
  value: string;
  onValueChange: (value: string) => void;
  /** Renders a programmatic label next to the text box when callers need one. */
  label?: React.ReactNode;
  /** Visible validation copy, linked to the textbox for assistive technology. */
  error?: React.ReactNode;
  /** Enables the leading sign accepted by parseSignedDecimalDollarsToCents. */
  allowNegative?: boolean;
  /** Reuses a caller's existing accepted draft syntax before exact parsing. */
  normalizeDraft?: (value: string) => string;
  /** Inclusive cents bounds used by the whole-dollar controls. */
  minCents?: number;
  maxCents?: number;
}

function hasThirdFractionalDigit(value: string): boolean {
  // Preserve malformed text for the caller's visible validation. Only reject the
  // one edit this control owns: a plain decimal amount gaining a third digit.
  return /^[+-]?\d*\.\d{3,}$/.test(value.trim());
}

function validBound(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value);
}

/**
 * Controlled dollars-and-cents text input for every person-entered money field.
 *
 * The existing parsers remain the authority for validation and cents conversion;
 * this component only protects the two-decimal editing affordance and provides
 * accessible whole-dollar controls (INV-MONEY-001, INV-MONEY-003).
 */
export function MoneyInput({
  value,
  onValueChange,
  label,
  error,
  allowNegative = false,
  normalizeDraft,
  minCents,
  maxCents,
  id,
  disabled = false,
  readOnly = false,
  className,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  onKeyDown,
  ...inputProps
}: MoneyInputProps) {
  const generatedId = React.useId();
  const inputId = id ?? `money-input-${generatedId}`;
  const [fieldName, setFieldName] = React.useState(
    typeof label === "string" ? label : inputProps["aria-label"] ?? "amount",
  );
  React.useEffect(() => {
    // Most callers already provide a native <label htmlFor>. Reuse that name
    // so each field's step controls remain distinct in a button list.
    const labelledInput = document.getElementById(inputId) as HTMLInputElement | null;
    const name = labelledInput?.labels?.[0]?.textContent?.trim();
    setFieldName(name || inputProps["aria-label"] || "amount");
  }, [inputId, label, inputProps]);
  const errorId = `${inputId}-error`;
  const describedBy = [error ? errorId : undefined, ariaDescribedBy]
    .filter(Boolean)
    .join(" ") || undefined;
  const parser = allowNegative
    ? parseSignedDecimalDollarsToCents
    : parseDecimalDollarsToCents;
  const controlsDisabled = disabled || readOnly;

  const nextStepValue = (direction: 1 | -1): string | null => {
    if (controlsDisabled) return null;
    const parsed = parser(normalizeDraft ? normalizeDraft(value) : value);
    if (parsed === null) return null;
    const next = parsed + direction * 100;
    if (!Number.isSafeInteger(next)) return null;
    if (!allowNegative && next < 0) return null;
    if (validBound(minCents) && next < minCents) return null;
    if (validBound(maxCents) && next > maxCents) return null;
    // The exact parser owns the int32-safe cents ceiling for this boundary.
    const formatted = formatCentsPlain(next);
    return parser(formatted) === null ? null : formatted;
  };

  const changeValue = (next: string) => {
    const normalized = normalizeDraft ? normalizeDraft(next) : next;
    if (!hasThirdFractionalDigit(normalized)) onValueChange(next);
  };

  const step = (direction: 1 | -1) => {
    const next = nextStepValue(direction);
    if (next !== null) onValueChange(next);
  };

  const increaseDisabled = nextStepValue(1) === null;
  const decreaseDisabled = nextStepValue(-1) === null;

  return (
    <div className="space-y-1">
      {label ? <Label htmlFor={inputId}>{label}</Label> : null}
      <div className="flex items-stretch gap-1">
        <Input
          {...inputProps}
          id={inputId}
          type="text"
          inputMode="decimal"
          value={value}
          disabled={disabled}
          readOnly={readOnly}
          aria-describedby={describedBy}
          aria-invalid={ariaInvalid ?? (error ? true : undefined)}
          className={className}
          onChange={(event) => changeValue(event.target.value)}
          onKeyDown={(event) => {
            onKeyDown?.(event);
            if (event.defaultPrevented) return;
            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              step(event.key === "ArrowUp" ? 1 : -1);
            }
          }}
        />
        <div className="flex flex-col gap-1">
          <button
            type="button"
            aria-label={`Increase ${fieldName} by one dollar`}
            className={cn(
              "flex h-6 w-8 items-center justify-center rounded-md border border-input text-muted-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50",
            )}
            disabled={increaseDisabled}
            onClick={() => step(1)}
          >
            <ChevronUp aria-hidden="true" className="size-3" />
          </button>
          <button
            type="button"
            aria-label={`Decrease ${fieldName} by one dollar`}
            className={cn(
              "flex h-6 w-8 items-center justify-center rounded-md border border-input text-muted-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50",
            )}
            disabled={decreaseDisabled}
            onClick={() => step(-1)}
          >
            <ChevronDown aria-hidden="true" className="size-3" />
          </button>
        </div>
      </div>
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
