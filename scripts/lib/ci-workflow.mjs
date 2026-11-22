/**
 * The workflow whose `main` push runs carry the push-only gates and publish the
 * GHCR images a release tag deploys (INV-OPS-021). One name for every script
 * that asks GitHub about those runs: `release:cut` and
 * `scripts/ci/resolve-main-push-base.mjs`.
 *
 * Node built-ins only (none at all), so a script run with a bare `node` before
 * the install can import it.
 */
export const CI_WORKFLOW_FILE = "ci.yml";
