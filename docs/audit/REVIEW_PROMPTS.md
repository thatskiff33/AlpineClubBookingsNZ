# Production Re-Review — Prompt Queue

> **Workflow.** This is a *self-popping* FIFO queue. The phase header directly below this preamble is the next to run; the agent removes its own prompt from this file when it finishes.
>
> 1. `cd /home/ubuntu/TACBookings && git pull --ff-only origin main` to refresh the queue.
> 2. Open a fresh Claude Code session in the repo root.
> 3. Run the `/model` command shown for the phase at the top of this file.
> 4. Copy the prompt block (between the triple-backticks) and paste it as the first message — exactly, no edits.
> 5. The phase agent runs to completion, then self-pops: it edits this file to delete its own section, commits to `main`, and pushes. Its last user-facing message is "phase complete" plus a one-line preview of the new top phase.
> 6. `git pull --ff-only` to pick up the deletion, verify the new top of the file is the expected next phase, and loop to step 2.
>
> **Manual fallback.** If an agent stops without self-popping (context exhaustion, error), find the `## P<N>` header for the just-completed phase and delete everything from that line down through and including the next standalone `---`.
>
> **Branch policy carve-out.** This file is workflow metadata, not application code. Direct commits to `main` are explicitly permitted for `docs/audit/REVIEW_PROMPTS.md` only — the queue must advance without PR overhead between phases.
>
> **Master plan:** `~/.claude/plans/gleaming-crafting-elephant.md`
> **Tracking epic:** GitHub issue #194
> **Prior audit baseline:** `docs/audit/00_EXECUTION_MODEL.md` … `06_GO_LIVE_AND_DEPLOY.md`

---

## P10 — Final report, remediation tracker, sign-off · issue #205

**Model:** Sonnet 4.6 (`/model claude-sonnet-4-6`) — synthesis-heavy. If Sonnet's severity calibration drifts, override at human PR review.
**Estimated effort:** 3 days (includes shipping remediation PRs)
**Pre-condition:** P0–P9 complete.

**Prompt to paste into a fresh Claude Code session:**

```
You are Claude Code working on Phase 10 of the TACBookings production re-review. Epic #194; this phase is issue #205.

Read first:
- gh issue view 205
- gh issue view 194 (full Findings Index — this is your input)
- All closed phase issues (P0–P9): gh issue view 195/.../204
- All review-finding issues: gh issue list --label "area: review-finding" --state all --limit 200
- ~/.claude/plans/gleaming-crafting-elephant.md (P10 section)
- docs/audit/06_GO_LIVE_AND_DEPLOY.md (the prior-audit final report — match its format)

Live-system safety rules: see epic #194. Remediation PRs go through normal PR review — no direct main commits.

This phase has 4 deliverables. Work them in this order.

DELIVERABLE 1 — Findings remediation PRs.

For every HIGH (and CRITICAL if any) finding:
1. Create a feature branch named: review/fix/<finding-issue-number>-<slug>
2. Implement the fix.
3. Use the regression test added in P9 to validate.
4. Run npm test, npm run build, lint — all must pass.
5. Open a PR with title: "[Review/Fix] <finding title>". Body must include:
   - "Closes #<finding>"
   - One-paragraph description
   - Test plan
6. Request review from @thatskiff33.

For every MEDIUM finding:
- Either fix as above, OR
- File a follow-up issue (label "type: task", milestone "next sprint") and add written acceptance to the finding issue: "Deferred to <issue#>; revisit if <trigger>."

For every LOW finding:
- Roll up into a single "review-cleanup" tracking issue with a checklist; do not block sign-off on it.

DELIVERABLE 2 — Coverage matrix vs prior 2026-04-08 audit.

Produce a markdown table (attach to issue #205 as a comment titled "Coverage matrix vs 2026-04-08 audit"):

| Prior audit phase | Re-verified? | Deepened? | New scope added |
|-------------------|--------------|-----------|------|
| 01_BASELINE_AND_PRIOR_REVIEW | ... | ... | ... |
| 02_SECURITY_AND_BOUNDARY | ... | ... | hashed-token migration validation (new) |
| 03_DATA_LOGIC_AND_INTEGRATIONS | ... | ... | finance subsystem deep-dive (new) |
| 04_UI_TESTS_OPS_AND_DOCS | ... | ... | blue-green deploy script (new) |
| 05_REMEDIATION_AND_VERIFICATION | ... | ... | ... |
| 06_GO_LIVE_AND_DEPLOY | ... | ... | post-launch operational gaps (new) |

Show what got re-verified, what got deepened, and what's genuinely new vs the prior audit.

DELIVERABLE 3 — Final report at docs/audit/07_RE_REVIEW_2026_04.md.

Match the format of docs/audit/00_EXECUTION_MODEL.md and 06_GO_LIVE_AND_DEPLOY.md.

Required sections:
1. Executive summary (1 paragraph): scope, dates, methodology, headline findings.
2. Scope: phases run, sequence, total findings count by severity.
3. Methodology: re-verification of audited spine via citation spot-checks; deep-dive of post-audit surface; live-system safety rules; Codex coordination model.
4. Findings table: every finding with link, severity, status (fixed/deferred/accepted).
5. Remediations applied: table of merged PRs.
6. Deferred items: each with rationale and re-review trigger.
7. Operational watch items: monitors / alerts created (deliverable 4 below).
8. Sign-off: GO / GO-WITH-CAVEATS / HOLD with concrete reasons.

Commit this file in a final PR titled "[Review] Final report and sign-off".

DELIVERABLE 4 — Operational watch items (each must have a real backing).

For each ongoing risk surfaced by the review, create a real monitor:
- Sentry alert for: any cron job that hasn't run for 24h+
- Sentry alert for: any payment_intent webhook that errors
- Sentry alert for: any Xero API call returning 401 (token expired)
- Sentry alert for: any Stripe API call returning idempotency_violation (means dedup logic missed)
- DB-query monitor (or scheduled job) for: any plaintext token row appearing in token tables (hashed-token migration regression)
- Daily check that the cron leader is exactly one (CRON_ENABLED=true on exactly one color)

For each watch item, list:
- The condition.
- The actual monitor (Sentry alert ID, scheduled job filename, etc.).
- The on-call response.

Anything that's "we'll keep an eye on it" without a real backing = file a follow-up to add the actual monitor.

DELIVERABLE 5 — Final sign-off decision.

Based on findings status:
- All CRITICAL fixed, all HIGH fixed-or-accepted = GO.
- HIGH items deferred but with strict triggers and short windows = GO-WITH-CAVEATS.
- Any CRITICAL deferred or HIGH without a trigger = HOLD (reschedule release until fixed).

State the decision in the executive summary of 07_RE_REVIEW_2026_04.md.

Phase exit criteria (issue #205):
- Every HIGH finding has merged PR or written acceptance with re-review trigger
- Every MEDIUM finding has remediation PR or scheduled follow-up issue
- 07_RE_REVIEW_2026_04.md committed
- Coverage matrix attached
- Watch items have real backing
- Final sign-off decision recorded

When done — execute these steps yourself:
1. Verify every exit-criteria checkbox in issue #205: `gh issue view 205`.
2. Post final summary: `gh issue comment 205 --body "Phase 10 complete. Sign-off: <GO/GO-WITH-CAVEATS/HOLD>. Final report: docs/audit/07_RE_REVIEW_2026_04.md. Remediation PRs: <list>."`
3. Close issue #205: `gh issue close 205`
4. Update parent epic #194 body: change all phase checkboxes from `[ ]` to `[x]`, prepend a header line `**Status: SIGNED OFF on YYYY-MM-DD**`. Use `gh issue edit 194 --body "<new body>"`.
5. Close epic #194: `gh issue close 194`
6. **Final queue cleanup.** The review is done; the artifact going forward is `docs/audit/07_RE_REVIEW_2026_04.md`:
   a. `cd /home/ubuntu/TACBookings && git checkout main && git pull --ff-only origin main`
   b. `git rm docs/audit/REVIEW_PROMPTS.md` (the entire file — review queue is now empty)
   c. `git commit -m "[Review] Production re-review complete — remove prompt queue"`
   d. `git push origin main`
7. Final user message — exact wording: "Production re-review COMPLETE. Sign-off: <decision>. Final report committed at `docs/audit/07_RE_REVIEW_2026_04.md`. Epic #194 closed. Prompt queue file removed. Run `git pull` to refresh."
8. STOP.
```

---
