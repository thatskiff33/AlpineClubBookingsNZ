// #2693: the TypeScript surface of `eslint.config.mjs`, which stays JavaScript
// because ESLint loads it with plain Node and `allowJs` is off in every
// TypeScript project here. Four guard suites under `src/lib/__tests__/` import
// the exported constants to prove the lint arms are wired; this file is what
// lets them typecheck. Keep it in step with the `export` statements in the
// `.mjs`: a name declared here that the module stops exporting arrives as
// `undefined` in those suites and fails them, and a name the module gains is
// unreachable from TypeScript until it is declared here.
import type { Linter, Rule } from "eslint";

/** One `no-restricted-syntax` entry: an ESQuery selector and its message. */
export type Restriction = {
  readonly selector: string;
  readonly message: string;
};

/** A file an arm is lifted from, with the reason the lift is legitimate. */
export type FileExemption = {
  readonly file: string;
  readonly reason: string;
};

export declare const MONEY_GUARD_ARMS: {
  readonly standard: readonly string[];
  readonly moneyModule: readonly string[];
};
export declare const MONEY_GUARD_EXEMPTIONS: readonly FileExemption[];

export declare const DATE_FNS_ADAPTERS: ReadonlyArray<
  FileExemption & { readonly uses: string }
>;
export declare const ENVIRONMENT_ZONE_ADAPTERS: readonly FileExemption[];

export declare const CLUB_TIME_GUARD_ARMS: {
  readonly hostClock: readonly string[];
  readonly environmentZone: readonly string[];
  readonly dateFns: readonly string[];
};
export declare const DATE_GUARD_ARMS: {
  readonly encoding: readonly string[];
  readonly zonedFormatter: readonly string[];
  readonly rendering: readonly string[];
};

export declare const AMBIENT_AUTHORITY_RESOLVERS: {
  readonly banned: readonly string[];
  readonly pending: ReadonlyArray<{
    readonly name: string;
    readonly liveDefaults: number;
    readonly [detail: string]: unknown;
  }>;
};
export declare const SSOT_GUARD_ARMS: {
  readonly authorityDefault: readonly string[];
};

export declare const COMMENT_STRIPPER_ALLOWLIST: readonly FileExemption[];
export declare const UNCONVERGED_COMMENT_SCANNERS: readonly FileExemption[];
export declare const SSOT_LOCAL_RULES: {
  readonly rules: { readonly "no-local-comment-stripper": Rule.RuleModule };
};

export declare const SRC_RESTRICTION_EXEMPTIONS: ReadonlyArray<{
  readonly files: readonly string[];
  readonly omits: readonly Restriction[];
  readonly reason: string;
}>;
export declare const MANDATORY_SRC_RESTRICTIONS: readonly Restriction[];

declare const eslintConfig: Linter.Config[];
export default eslintConfig;
