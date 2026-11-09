/**
 * The ref the file-size ratchet judges a change against unless told otherwise,
 * and the one the epic-sync census passes explicitly (#4831).
 *
 * It is `origin/main` because that is where an allowance is SPENT: a fragment
 * in `size-allowances.d/` has effect only while it is part of the diff against
 * this ref, and stops mattering once `main` carries it. `ci.yml`'s `BUDGET_BASE`
 * names the same ref for pull requests. One module, so the script's default and
 * the sync's explicit choice cannot drift apart (INV-SSOT).
 */
export const DEFAULT_BASE_REF = "origin/main";
