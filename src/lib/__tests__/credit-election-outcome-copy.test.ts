import { describe, expect, it } from "vitest";
import { creditElectionOutcomeCopy, parseCreditElectionOutcome } from "@/lib/credit-election-outcome-copy";

const format = { currencyCode: "NZD", locale: "en-NZ" };
const outcome = {
  requestedCents: 10000, appliedCents: 4000, shortfallCents: 6000,
  availableBalanceCents: 10000, shortfallReason: "price" as const, fullyCovered: false,
};

describe("saved credit outcome copy", () => {
  it.each([
    ["balance", "you no longer hold that much credit"],
    ["price", "the booking no longer costs that much"],
    ["balance_and_price", "you no longer hold that much credit and the booking no longer costs that much"],
  ])("explains the %s bound using the requested and applied figures", (shortfallReason, reason) => {
    const parsed = parseCreditElectionOutcome({ ...outcome, shortfallReason });
    expect(creditElectionOutcomeCopy(parsed, format, 26000)).toBe(
      `You asked to use $100.00 credit. $40.00 was applied because ${reason}. Any unused credit stays on your account. Your card will be charged $260.00 today.`,
    );
  });

  it("names full application and a fully covered booking without claiming a card charge", () => {
    const parsed = parseCreditElectionOutcome({ ...outcome, appliedCents: 10000,
      shortfallCents: 0, shortfallReason: "none", fullyCovered: true });
    expect(creditElectionOutcomeCopy(parsed, format, 0)).toBe(
      "Your credit of $100.00 was applied. Your credit covered it all. No card payment is needed.",
    );
  });

  it("explains zero application and preserves the club's currency", () => {
    const parsed = parseCreditElectionOutcome({ ...outcome, appliedCents: 0,
      shortfallCents: 10000, shortfallReason: "balance", availableBalanceCents: 0 });
    const message = creditElectionOutcomeCopy(parsed, { currencyCode: "EUR", locale: "en-IE" });
    expect(message).toContain("€100.00 credit. €0.00 was applied");
    expect(message).not.toContain("Your card will be charged");
  });

  it("explains zero application when the member's ledger balance is negative", () => {
    const parsed = parseCreditElectionOutcome({ ...outcome, appliedCents: 0,
      shortfallCents: 10000, shortfallReason: "balance", availableBalanceCents: -2500 });
    expect(creditElectionOutcomeCopy(parsed, format)).toBe(
      "You asked to use $100.00 credit. $0.00 was applied because you no longer hold that much credit. Any unused credit stays on your account.",
    );
  });

  it.each([null, undefined, "credit", {}, { ...outcome, appliedCents: -1 },
    { ...outcome, requestedCents: 10000.5 }, { ...outcome, appliedCents: NaN },
    { ...outcome, shortfallCents: Number.MAX_SAFE_INTEGER + 1 }, { ...outcome, appliedCents: 10001 },
    { ...outcome, shortfallCents: 5000 }, { ...outcome, shortfallReason: "other" },
    { ...outcome, shortfallReason: "none" }, { ...outcome, fullyCovered: "true" },
  ])("ignores invalid payload %j", (value) => {
    expect(parseCreditElectionOutcome(value)).toBeNull();
    expect(creditElectionOutcomeCopy(parseCreditElectionOutcome(value), format)).toBeNull();
  });
});
