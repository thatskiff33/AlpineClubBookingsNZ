/**
 * `import "server-only"` makes the production build REFUSE this module in a
 * browser bundle, at any depth (`INV-OPS-013`, #2850). Operator CLIs reach it
 * under plain Node, where that marker would throw at import, so every `tsx`
 * invocation that reaches it runs with `--conditions=react-server` — which
 * resolves `server-only` to an empty module. `cli-server-only-reach-census.test.ts`
 * enforces that pairing; `docs/invariants/operations.md` carries the reasoning.
 */
import "server-only";

export * from "./email/core";
export * from "./email/account";
export * from "./email/booking";
export * from "./email/member-guest";
export * from "./email/membership";
export * from "./email/family";
export * from "./email/waitlist";
export * from "./email/groups";
export * from "./email/booking-requests";
export * from "./email/chores";
export * from "./email/admin-alerts";
export * from "./email/ses-feedback";
