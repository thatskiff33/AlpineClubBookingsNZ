// The Vitest config a Stryker mutation run uses (#4459). It is the ordinary
// config, so the frozen clock and the shared setup files hold, with the suite
// narrowed to the unit tests of the mutated modules: Stryker runs the whole
// configured suite once before mutating and again per mutant, and the
// repository's full suite is far too large for that. The lists live in
// `scripts/lib/money-modules.mjs`, beside the modules they belong to.
import { defineConfig, mergeConfig } from "vitest/config";

import { MUTATION_TEST_FILES } from "./scripts/lib/money-modules.mjs";
import base from "./vitest.config.mts";

export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: [...MUTATION_TEST_FILES],
      // `mergeConfig` concatenates arrays, so the base `exclude` stays.
      coverage: { enabled: false },
    },
  }),
);
