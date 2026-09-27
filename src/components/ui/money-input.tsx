"use client";

import * as React from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

import {
  parseDecimalDollarsToCents,
  parseSignedDecimalDollarsToCents,
} from "@/lib/money-input";
import { cn } from "@/lib/utils";

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
  /** Inclusive cents bounds used by the whole-dollar controls. */
  minCents?: number;
  maxCents?: number;
}

function hasThirdFractionalDigit(value: string): boolean {
  // Preserve malformed text for the caller's visible validation. Only reject the
  // one edit this control owns: a plain decimal amount gaining a third digit.
  return /^[+-]?\d*\.\d{3,}$/.test(value);
}

function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const magnitude = Math.abs(cents);
  return `${sign}${Math.floor(magnitude / 100)}.${String(magnitude % 100).padStart(2, "0")}`;
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
  const errorId = `${inputId}-error`;
  const describedBy = [ariaDescribedBy, error ? errorId : undefined]
    .filter(Boolean)
    .join(" ") || undefined;
  const parser = allowNegative
    ? parseSignedDecimalDollarsToCents
    : parseDecimalDollarsToCents;
  const controlsDisabled = disabled || readOnly;

  const changeValue = (next: string) => {
    if (!hasThirdFractionalDigit(next)) onValueChange(next);
  };

  const step = (direction: 1 | -1) => {
    if (controlsDisabled) return;
    const parsed = parser(value);
    if (parsed === null) return;
    const next = parsed + direction * 100;
    if (!Number.isSafeInteger(next)) return;
    if (!allowNegative && next < 0) return;
    if (validBound(minCents) && next < minCents) return;
    if (validBound(maxCents) && next > maxCents) return;
    onValueChange(formatCents(next));
  };

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
        <div className="flex flex-col" aria-label="Adjust amount by one dollar">
          <button
            type="button"
            aria-label="Increase amount by one dollar"
            className={cn(
              "flex h-[18px] w-7 items-center justify-center rounded-t-md border border-input text-muted-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50",
            )}
            disabled={controlsDisabled}
            onClick={() => step(1)}
          >
            <ChevronUp aria-hidden="true" className="size-3" />
          </button>
          <button
            type="button"
            aria-label="Decrease amount by one dollar"
            className={cn(
              "flex h-[18px] w-7 items-center justify-center rounded-b-md border-x border-b border-input text-muted-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50",
            )}
            disabled={controlsDisabled}
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
