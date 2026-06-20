# Issue Creation Plan

Do not create issues until a human approves the backlog in
`docs/reviews/2026-06-20/REVIEW_ISSUE_BACKLOG.md`.

## Creation Order And Labels

| # | Title | Suggested labels |
|---|---|---|
| 1 | Security/auth/access-control route boundary review | `codex-ready`, `review`, `security`, `risk:high`, `effort:xhigh`, `human-review` |
| 2 | Booking/payment/membership lifecycle state-machine review | `codex-ready`, `review`, `lifecycle`, `risk:high`, `effort:xhigh`, `human-review` |
| 3 | High-risk invariant test gap review | `codex-ready`, `review`, `tests`, `risk:high`, `effort:high`, `human-review` |
| 4 | Stripe/Xero/SES idempotency and replay review | `codex-ready`, `review`, `integrations`, `risk:critical`, `effort:xhigh`, `human-review` |
| 5 | Booking capacity, waitlist, bed allocation, and recovery review | `codex-ready`, `review`, `booking`, `risk:critical`, `effort:xhigh`, `human-review` |
| 6 | Membership, family, dependent, cancellation, archive/delete lifecycle review | `codex-ready`, `review`, `membership`, `risk:high`, `effort:xhigh`, `human-review` |
| 7 | Payment, refund, credit, and accounting consistency review | `codex-ready`, `review`, `payments`, `risk:critical`, `effort:xhigh`, `human-review` |
| 8 | Xero operational outbox and reconciliation review | `codex-ready`, `review`, `xero`, `risk:high`, `effort:xhigh`, `human-review` |
| 9 | Email, notification, retry, and suppression review | `codex-ready`, `review`, `email`, `risk:high`, `effort:high`, `human-review` |
| 10 | Admin, finance, and lodge recovery/visibility review | `codex-ready`, `review`, `operations`, `risk:high`, `effort:high`, `human-review` |
| 11 | UI/UX journey clarity and accessibility review | `codex-ready`, `review`, `ux`, `a11y`, `risk:medium`, `effort:high` |
| 12 | Final release-readiness review | `codex-ready`, `review`, `release`, `risk:high`, `effort:xhigh`, `human-review` |

## Review Attendance

- Human review before implementation: all issues. These are review stubs; any
  implementation follow-up must be separately scoped and approved.
- Human-attended review preferred: issues 1-10 and 12 because they touch
  security, money, booking capacity, membership lifecycle, providers, operator
  recovery, or release readiness.
- May run unattended: issue 11 only, and only as review-only work with no app
  code edits, no production browser automation, and no live endpoints.
- Must avoid detailed public security findings: issues 1, 4, 8, 9, and 12, plus
  any finding in any issue involving auth bypass, secrets, tokens, signatures,
  provider replay, PII exposure, or payment-state manipulation.

## Safe Creation Script After Approval

After human approval, run this from the clean `codex/` branch. It reads the
approved backlog sections into temporary files and creates the 12 issues in
order. If labels do not already exist, `gh` will fail before creating later
issues; fix labels manually and rerun for the remaining items.

```bash
CREATE=1 bash <<'SH'
set -euo pipefail

review_file="docs/reviews/2026-06-20/REVIEW_ISSUE_BACKLOG.md"
tmpdir="$(mktemp -d)"
csplit -s -f "$tmpdir/issue-" -b "%02d.md" "$review_file" '/^## [0-9]\+\. /' '{*}'
rm -f "$tmpdir/issue-00.md"

cat > "$tmpdir/issues.tsv" <<'EOF'
01	Security/auth/access-control route boundary review	codex-ready,review,security,risk:high,effort:xhigh,human-review
02	Booking/payment/membership lifecycle state-machine review	codex-ready,review,lifecycle,risk:high,effort:xhigh,human-review
03	High-risk invariant test gap review	codex-ready,review,tests,risk:high,effort:high,human-review
04	Stripe/Xero/SES idempotency and replay review	codex-ready,review,integrations,risk:critical,effort:xhigh,human-review
05	Booking capacity, waitlist, bed allocation, and recovery review	codex-ready,review,booking,risk:critical,effort:xhigh,human-review
06	Membership, family, dependent, cancellation, archive/delete lifecycle review	codex-ready,review,membership,risk:high,effort:xhigh,human-review
07	Payment, refund, credit, and accounting consistency review	codex-ready,review,payments,risk:critical,effort:xhigh,human-review
08	Xero operational outbox and reconciliation review	codex-ready,review,xero,risk:high,effort:xhigh,human-review
09	Email, notification, retry, and suppression review	codex-ready,review,email,risk:high,effort:high,human-review
10	Admin, finance, and lodge recovery/visibility review	codex-ready,review,operations,risk:high,effort:high,human-review
11	UI/UX journey clarity and accessibility review	codex-ready,review,ux,a11y,risk:medium,effort:high
12	Final release-readiness review	codex-ready,review,release,risk:high,effort:xhigh,human-review
EOF

while IFS="$(printf '\t')" read -r number title labels; do
  body_file="$tmpdir/issue-$number.md"
  test -s "$body_file"
  gh issue create --title "$title" --body-file "$body_file" --label "$labels"
done < "$tmpdir/issues.tsv"
SH
```
