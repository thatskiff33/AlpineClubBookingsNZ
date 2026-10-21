"use client";

import { useId } from "react";

import {
  BANK_REFUND_VOID_ANSWER_COPY,
  BANK_REFUND_VOID_ANSWERS,
  HAND_MADE_CREDIT_NOTE_NUMBER_MAX,
  type BankRefundVoidAnswer,
} from "@/lib/bank-refund-void-follow-up-copy";

/**
 * #4162 (owner decision 17 Oct 2026, `INV-ADDPAY-042`): the two "yes" answers
 * to a bank refund back on the list because Xero voided its credit note. "Not
 * yet" is leaving the dialog, and "the club keeps it" is the row's Dismiss, so
 * neither is offered here. No answer is pre-chosen: the confirm stays disarmed
 * until one is, and the "already in Xero" answer until a number is typed.
 */
export function BankRefundVoidAnswerChoice({
  answer,
  creditNoteNumber,
  disabled,
  onAnswer,
  onCreditNoteNumber,
}: {
  answer: BankRefundVoidAnswer | null;
  creditNoteNumber: string;
  disabled: boolean;
  onAnswer: (answer: BankRefundVoidAnswer) => void;
  onCreditNoteNumber: (value: string) => void;
}) {
  const numberId = useId();
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Your answer</legend>
      {BANK_REFUND_VOID_ANSWERS.map((value) => {
        const id = `bank-refund-void-answer-${value}`;
        return (
          <label key={value} htmlFor={id} className="flex gap-2 rounded-md border border-border p-2 text-sm">
            <input
              type="radio"
              id={id}
              name="bank-refund-void-answer"
              className="mt-1"
              checked={answer === value}
              disabled={disabled}
              onChange={() => onAnswer(value)}
            />
            <span>
              <span className="block font-medium">{BANK_REFUND_VOID_ANSWER_COPY[value].label}</span>
              <span className="block text-xs text-muted-foreground">{BANK_REFUND_VOID_ANSWER_COPY[value].help}</span>
            </span>
          </label>
        );
      })}
      {answer === "recorded-in-xero" ? (
        <div className="space-y-1">
          <label htmlFor={numberId} className="text-sm font-medium">
            Credit note number in Xero
          </label>
          <input
            id={numberId}
            type="text"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={creditNoteNumber}
            maxLength={HAND_MADE_CREDIT_NOTE_NUMBER_MAX}
            disabled={disabled}
            placeholder="e.g. CN-0123"
            onChange={(event) => onCreditNoteNumber(event.target.value)}
          />
        </div>
      ) : null}
    </fieldset>
  );
}
