"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { LodgeInvoiceDetailField } from "@/lib/lodges";
import {
  joinNzBankAccountParts,
  NZ_BANK_ACCOUNT_PARTS,
  splitNzBankAccountNumber,
  type NzBankAccountParts,
} from "@/lib/nz-bank-account";

export type LodgeInvoiceDetailValues = Record<LodgeInvoiceDetailField, string | null | undefined>;

type FieldProps = {
  /** Prefix for the inputs' ids, unique on the page. */
  idPrefix: string;
  values: LodgeInvoiceDetailValues;
  onChange: (field: LodgeInvoiceDetailField, value: string) => void;
  disabled?: boolean;
  /** The view-only explanation's id, when the inputs are disabled for it. */
  describedBy?: string;
};

/*
  The lodge's invoice details (fork #115): postal address, the bank details
  printed in the invoice's payment box, and the GST number. One module for both
  editing surfaces — the single-lodge Lodge details panel on Club Identity and
  the Admin → Lodges edit form (fork #123) — so their wording and layout cannot drift
  (INV-SSOT-001). The postal address is its own piece because both forms place
  it beside the lodge's Address. All four are optional and save through
  `PATCH /api/admin/lodges/[id]`.
*/

/** Postal address, placed to the right of the lodge's Address. */
export function LodgePostalAddressField({
  idPrefix,
  values,
  onChange,
  disabled = false,
  describedBy,
}: FieldProps) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={`${idPrefix}-postal`}>Postal address</Label>
      <Textarea
        id={`${idPrefix}-postal`}
        value={values.postalAddress ?? ""}
        rows={2}
        maxLength={300}
        placeholder="Optional — used on invoices instead of the address"
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={(event) => onChange("postalAddress", event.target.value)}
      />
    </div>
  );
}

/**
 * A New Zealand bank account number as its four parts, BB-bbbb-AAAAAAA-SSS.
 * Reports the parts joined by hyphens (empty when all are empty), so a partly
 * typed number round-trips; the form checks it on save with
 * `nzBankAccountNumberForSave`. Digits only; a part that fills moves to the
 * next, and pasting a whole number into any part fills all four.
 */
function NzBankAccountNumberInput({
  idPrefix,
  value,
  onChange,
  disabled,
  describedBy,
}: {
  idPrefix: string;
  value: string | null | undefined;
  onChange: (value: string) => void;
  disabled: boolean;
  describedBy?: string;
}) {
  const parsed = splitNzBankAccountNumber(value);
  const parts: NzBankAccountParts = parsed ?? ["", "", "", ""];
  const hintId = `${idPrefix}-hint`;
  const partId = (key: string) => `${idPrefix}-${key}`;

  function setPart(index: number, raw: string) {
    const spec = NZ_BANK_ACCOUNT_PARTS[index];
    if (!spec) return;
    const digits = raw.replace(/\D/g, "").slice(0, spec.maxLength);
    const next = [...parts] as NzBankAccountParts;
    next[index] = digits;
    onChange(joinNzBankAccountParts(next));
    const following = NZ_BANK_ACCOUNT_PARTS[index + 1];
    if (digits.length === spec.maxLength && following) {
      document.getElementById(partId(following.key))?.focus();
    }
  }

  return (
    <div className="space-y-1.5">
      <Label id={`${idPrefix}-label`}>Account number</Label>
      <div
        role="group"
        aria-labelledby={`${idPrefix}-label`}
        aria-describedby={[hintId, describedBy].filter(Boolean).join(" ")}
        className="flex flex-wrap items-center gap-1.5"
      >
        {NZ_BANK_ACCOUNT_PARTS.map((part, index) => (
          <span key={part.key} className="flex items-center gap-1.5">
            {index > 0 ? (
              <span aria-hidden="true" className="text-muted-foreground">
                -
              </span>
            ) : null}
            <Input
              id={partId(part.key)}
              aria-label={part.label}
              inputMode="numeric"
              autoComplete="off"
              value={parts[index]}
              maxLength={part.maxLength}
              placeholder={"0".repeat(part.maxLength)}
              disabled={disabled}
              style={{ width: `${part.maxLength + 2.5}ch` }}
              className="px-2 text-center font-mono"
              onChange={(event) => setPart(index, event.target.value)}
              onPaste={(event) => {
                const pasted = splitNzBankAccountNumber(event.clipboardData.getData("text"));
                if (pasted && pasted.join("").length >= 15) {
                  event.preventDefault();
                  onChange(joinNzBankAccountParts(pasted));
                }
              }}
            />
          </span>
        ))}
      </div>
      <p id={hintId} className="text-sm text-muted-foreground">
        {parsed
          ? "Bank, branch, account and suffix (the suffix is 2 or 3 digits)."
          : `The saved value "${value}" is not a New Zealand account number. Enter the number again.`}
      </p>
    </div>
  );
}

/** Bank details for bookings and the GST number. */
export function LodgeBankAndGstFields({
  idPrefix,
  values,
  onChange,
  disabled = false,
  describedBy,
}: FieldProps) {
  const common = { disabled, "aria-describedby": describedBy };
  return (
    <div className="space-y-4">
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Bank details for bookings</legend>
        <p className="text-sm text-muted-foreground">
          Optional. Shown in the payment box of the booking invoice.
        </p>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-bank-name`}>Account name</Label>
          <Input
            id={`${idPrefix}-bank-name`}
            value={values.bankAccountName ?? ""}
            maxLength={200}
            {...common}
            onChange={(event) => onChange("bankAccountName", event.target.value)}
          />
        </div>
        <NzBankAccountNumberInput
          idPrefix={`${idPrefix}-bank-number`}
          value={values.bankAccountDetails}
          onChange={(value) => onChange("bankAccountDetails", value)}
          disabled={disabled}
          describedBy={describedBy}
        />
      </fieldset>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-gst`}>GST number</Label>
        <Input
          id={`${idPrefix}-gst`}
          value={values.gstNumber ?? ""}
          maxLength={40}
          placeholder="Optional — printed on invoices when set"
          {...common}
          onChange={(event) => onChange("gstNumber", event.target.value)}
        />
      </div>
    </div>
  );
}
