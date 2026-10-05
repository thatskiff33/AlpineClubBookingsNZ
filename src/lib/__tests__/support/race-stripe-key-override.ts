/**
 * The real-PostgreSQL harness's one seam over the operational Stripe key.
 *
 * `concurrency-lock-races.realdb.test.ts` imports every race suite into ONE
 * module graph, so a `vi.mock("@/lib/stripe-config")` in two of them registers
 * two factories and only one wins: the loser's override is silently gone and
 * its suite runs against the real (unconfigured) key. Each suite instead
 * registers its override here and mocks the module with `stripeConfigWithRaceOverrides`,
 * so whichever factory wins consults every suite's override. The registry
 * lives on `globalThis`, so it is one list even if this module is loaded twice.
 */
type RaceStripeKeyOverride = () => { key: string | undefined } | null;

const registry = globalThis as typeof globalThis & { __raceStripeKeyOverrides?: RaceStripeKeyOverride[] };

function overrides(): RaceStripeKeyOverride[] {
  registry.__raceStripeKeyOverrides ??= [];
  return registry.__raceStripeKeyOverrides;
}

/** Answer the key while `override` returns a value; return null to pass through. */
export function registerRaceStripeKeyOverride(override: RaceStripeKeyOverride): void {
  overrides().push(override);
}

/** The `vi.mock("@/lib/stripe-config")` body every race suite shares. */
export function stripeConfigWithRaceOverrides<T extends { getOperationalStripeSecretKey: () => Promise<string | undefined> }>(
  actual: T,
): T {
  return {
    ...actual,
    getOperationalStripeSecretKey: () => {
      for (const override of overrides()) {
        const answer = override();
        if (answer) return Promise.resolve(answer.key);
      }
      return actual.getOperationalStripeSecretKey();
    },
  };
}
