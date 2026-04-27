#!/usr/bin/env bash
set -Eeuo pipefail

###############################################################################
# TACBookings — 12-Stage Best-Practice Review
#
# Orchestrates per-stage Claude Code CLI invocations, each with a fresh
# context window and focused prompt. Produces a consolidated report at
# docs/COMPREHENSIVE_REVIEW_<date>.md
#
# Usage:
#   ./scripts/run-review.sh              # Run all 12 stages
#   ./scripts/run-review.sh 3            # Resume from stage 3
#   ./scripts/run-review.sh 5 7          # Run stages 5 through 7 only
#
# Requirements:
#   - Claude Code CLI (`claude`) on PATH
#   - Run from the TACBookings repo root (or set PROJECT_DIR)
###############################################################################

PROJECT_DIR="${PROJECT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
REPORT_DATE="$(date +%Y-%m-%d)"
REPORT_FILE="$PROJECT_DIR/docs/COMPREHENSIVE_REVIEW_${REPORT_DATE}.md"
LOG_DIR="$PROJECT_DIR/logs/review-${REPORT_DATE}"
MODEL="${REVIEW_MODEL:-opus}"
START_STAGE="${1:-1}"
END_STAGE="${2:-12}"

mkdir -p "$LOG_DIR"

# Colours for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

stage_names=(
  ""  # 0-indexed padding
  "Prior Review Verification"
  "Security Audit"
  "Database & Schema Audit"
  "API Design & Consistency"
  "Business Logic Audit"
  "Integration Audit (Stripe/Xero/Email)"
  "Testing Audit"
  "Performance Audit"
  "Infrastructure & DevOps"
  "UI/UX Audit"
  "Documentation Audit"
  "Dependency Audit"
)

info()  { printf "${CYAN}[%s]${NC} %s\n" "$(date +%H:%M:%S)" "$1"; }
ok()    { printf "${GREEN}[%s] DONE${NC} %s\n" "$(date +%H:%M:%S)" "$1"; }
warn()  { printf "${YELLOW}[%s] WARN${NC} %s\n" "$(date +%H:%M:%S)" "$1"; }
fail()  { printf "${RED}[%s] FAIL${NC} %s\n" "$(date +%H:%M:%S)" "$1"; }

# Shared context preamble injected into every stage prompt
read -r -d '' PREAMBLE <<'PREAMBLE_EOF' || true
You are performing a best-practice audit of the TACBookings repository.
This is a production Next.js 16 booking system for a 29-bed alpine lodge with Stripe, Xero, and AWS SES integrations.

IMPORTANT RULES:
- This is a REPORT-ONLY audit. Do NOT modify any source code.
- Your ONLY writable action is appending your findings to the report file.
- Be precise: cite file paths and line numbers for every finding.
- Classify each finding as CRITICAL / HIGH / MEDIUM / LOW.
- For each finding include: severity, file:line, impact, and recommended fix.
- Be thorough but concise — no filler, no preamble, just findings.
- If a prior review finding (from docs/CODEBASE_REVIEW_2026-04-07.md) overlaps with your stage, note its status (FIXED / OPEN / PARTIALLY FIXED).
PREAMBLE_EOF

###############################################################################
# Stage prompt functions — each returns the stage-specific prompt
###############################################################################

stage_1_prompt() {
cat <<'EOF'
## Stage 1: Prior Review Verification

Read docs/CODEBASE_REVIEW_2026-04-07.md in full. It contains 46 issues (C1-C5, H1-H15, M1-M16, L1-L10).

For EACH issue:
1. Read the cited file at the cited line
2. Determine if the described fix has been applied
3. Mark as: FIXED (with evidence), OPEN (issue still present), or PARTIALLY FIXED (explain what remains)

Write your output as a markdown table with columns: ID | Title | Severity | Status | Evidence

Then write a summary: X fixed, Y open, Z partially fixed.
EOF
}

stage_2_prompt() {
cat <<'EOF'
## Stage 2: Security Audit

Audit these areas for security vulnerabilities:

1. Auth & session: Read src/lib/auth.ts — check JWT config, session expiry, role guards. Sample 10+ API routes across admin/, auth/, bookings/, payments/, lodge/ — verify each has auth() check and role guard.
2. Input validation: Check 10+ API routes for Zod schemas. Look for missing .max() on strings, unvalidated query params, raw SQL (grep for $executeRaw, $queryRaw).
3. Injection: Check src/lib/email-templates.ts for escapeHtml usage on all user content. Check for dangerouslySetInnerHTML in tsx files. Check for SQL injection via raw queries.
4. Secrets: Grep source code (excluding .env, .env.example, node_modules, .git) for patterns like password=, secret=, apiKey=, sk_live, sk_test. Verify .env is in .gitignore.
5. Rate limiting: Read src/lib/rate-limit.ts. Check which public endpoints (register, login, forgot-password, contact) use rate limiting.
6. Security headers: Read Caddyfile for CSP, HSTS, X-Frame-Options. Check if src/middleware.ts exists.
7. Webhook security: Read src/app/api/webhooks/stripe/route.ts and xero/route.ts — verify signature verification.
8. Password policy: Check bcrypt salt rounds in auth.ts, min password length in register route schema.
9. Data exposure: Check that no API response includes passwordHash, token fields, or internal secrets.

Report all findings with severity, file:line, impact, recommended fix.
EOF
}

stage_3_prompt() {
cat <<'EOF'
## Stage 3: Database & Schema Audit

Read prisma/schema.prisma in full. Audit:

1. Unique constraints: List every field that should logically be unique but lacks @unique (e.g., Member.email).
2. Indexes: For every relation field (FK), verify there's a corresponding @@index. List any missing.
3. Cascade policies: For every @relation, check if onDelete is specified. List any without explicit cascade policy.
4. Data types: Verify all money fields are Int (cents). Check for any Float money fields. Check if bounded string fields use @db.VarChar.
5. Enum consistency: List all enums. For each, grep the codebase to verify all values are used and no code references non-existent values.
6. Model completeness: Check for any models referenced in code but missing from schema, or schema models never queried.

Then check query patterns:
7. Grep for `include:` in API routes — flag any that include entire relations without select (potential over-fetching).
8. Check for unbounded findMany calls (no take/skip) in non-cron code.

Report all findings.
EOF
}

stage_4_prompt() {
cat <<'EOF'
## Stage 4: API Design & Consistency Audit

Audit ALL API routes under src/app/api/ for consistency:

1. Auth guards: For each route file, verify it checks auth(). List any non-public routes missing auth checks. Public routes (health, contact, committee, webhooks, auth/*) are exempt.
2. Input validation: For each POST/PUT/DELETE handler, verify Zod schema validation. List any accepting req.json() without validation.
3. Error response shape: Check 15+ routes — do they all return { error: string }? List inconsistencies.
4. HTTP status codes: Check for incorrect usage (e.g., 200 on error, 400 when 404 is appropriate, 401 vs 403 confusion).
5. Missing try/catch: List any route handlers without top-level error handling.
6. Method exposure: Check if any route.ts files export handlers they shouldn't (e.g., DELETE on a read-only resource).

Focus on finding real inconsistencies, not theoretical concerns. Report with file:line.
EOF
}

stage_5_prompt() {
cat <<'EOF'
## Stage 5: Business Logic Audit

Read and verify the correctness of core business logic:

1. Pricing engine (src/lib/pricing.ts): Does it handle multi-season stays correctly? Are all calculations in integer cents? Any rounding issues?
2. Capacity (src/lib/capacity.ts): Is the 29-bed limit correctly enforced? Which booking statuses count toward capacity? Is the date range correct (checkIn inclusive, checkOut exclusive)?
3. Bumping (src/lib/bumping.ts): Is the order correct (createdAt DESC = last booked first bumped)? Are promos, chores, and notifications cleaned up?
4. Cancellation (src/lib/cancellation.ts, src/lib/booking-cancel.ts): Does refund tier calculation match the policy? Are change fees excluded from refundable amount?
5. Waitlist (src/lib/waitlist.ts): Is FIFO ordering by createdAt ASC? Does capacity re-check happen on confirm? Is the 48h offer window enforced?
6. Age tier (src/lib/age-tier.ts): Is age calculated from season start (April 1), not today? Are configurable boundaries read from DB?
7. Chore allocator (src/lib/chore-allocator.ts): Does round-robin work correctly? Are age restrictions enforced? Does frequency filtering work?

For each module, trace one happy path and one edge case. Report any logic bugs found.
EOF
}

stage_6_prompt() {
cat <<'EOF'
## Stage 6: Integration Audit (Stripe, Xero, Email)

Audit external service integrations:

1. Stripe (src/lib/stripe.ts + webhook route):
   - Is the webhook handler processing all necessary event types?
   - Are idempotency keys used on PaymentIntent creation?
   - Does the webhook verify payment amounts match booking amounts?
   - Is the customer creation flow correct (find-or-create)?

2. Xero (src/lib/xero.ts):
   - How large is this file? Is it maintainable?
   - Is token refresh handled correctly (5-min buffer)?
   - Is the daily rate limit guard persistent across restarts?
   - Are credit notes using correct sign (positive amounts)?
   - Is findOrCreateContact protected against race conditions?
   - Is the encryption key handling correct (AES-256-GCM)?

3. Email (src/lib/email.ts + email-templates.ts):
   - Is escapeHtml() used on ALL user-provided values in templates?
   - Is EmailLog tracking reliable (fire-and-forget vs awaited)?
   - Does the retry cron work correctly?
   - Are notification preferences checked before sending?

4. Error resilience: For each integration, what happens if it's down? Does the booking still succeed?

Report findings with severity and file:line.
EOF
}

stage_7_prompt() {
cat <<'EOF'
## Stage 7: Testing Audit

Assess test coverage and quality:

1. Coverage map: List every file in src/lib/ and whether it has a corresponding test file in src/lib/__tests__/. Calculate the coverage percentage.
2. Untested modules: List all lib/ files with NO test coverage.
3. Test quality: Read 5 test files. Are they testing behavior or implementation details? Do assertions check the right things?
4. Mock quality: Check 3 test files that mock Prisma or Stripe. Do the mocks match the actual API shape? Are there outdated mocks?
5. Edge case coverage: For pricing, capacity, and bumping tests — are edge cases covered? (zero guests, capacity=0, season boundary dates, $0 bookings)
6. Missing test categories: Note absence of E2E tests (Playwright/Cypress), security tests, performance/load tests.
7. Test infrastructure: Read vitest.config.ts. Is the config appropriate? Any issues?

Run: npm test 2>&1 | tail -5  (to verify current pass/fail state)

Report the coverage map as a table and list all gaps.
EOF
}

stage_8_prompt() {
cat <<'EOF'
## Stage 8: Performance Audit

Check for performance issues:

1. N+1 queries: Search API routes for patterns where a findMany is followed by individual queries in a loop. Check booking listing, member listing, roster routes.
2. Unbounded queries: Search for findMany without take/skip in non-cron API routes. These could return thousands of rows.
3. Over-fetching: Search for `include: { member: true }` or similar full-model includes where only 1-2 fields are needed. Suggest using select instead.
4. Cron efficiency: Read 3 cron files. Do they batch operations or process one-at-a-time? Are queries optimized?
5. Caching: Search for any in-memory caching patterns. Are there TTLs? Could frequently-read data (seasons, chore templates, age tier settings) benefit from caching?
6. Heavy client dependencies: Check package.json for large client-side packages (html2canvas, jspdf, recharts). Are they dynamically imported?
7. Connection pooling: Read src/lib/prisma.ts. Is connection_limit configured? What's the default?

Report only actionable findings with estimated impact.
EOF
}

stage_9_prompt() {
cat <<'EOF'
## Stage 9: Infrastructure & DevOps Audit

Audit deployment and operations:

1. Docker: Read docker-compose.yml and Dockerfile.
   - Is the app container non-root? (check USER directive)
   - Is read_only set? tmpfs for writable dirs?
   - Are resource limits appropriate for the 4 GB RAM, 2 vCPU, 80 GB SSD Lightsail host?
   - Health checks configured correctly?
   - Log rotation configured?

2. CI/CD: Check for .github/workflows/ directory. Note its absence as a gap.

3. Monitoring: Read src/instrumentation.ts.
   - How many cron jobs exist?
   - Which have Sentry check-in monitoring vs which don't?
   - Are overlap guards on all crons?

4. Backups: Read src/lib/backup.ts. Is the backup strategy documented? Is restore tested?

5. Secrets: Read .env.example. Are all required vars documented? Is there guidance on key generation?

6. Health: Read src/app/api/health/route.ts. Does it check all critical dependencies?

7. Deployment scripts: Read scripts/run-production-blue-green-deploy.sh and scripts/blue-green-deploy.sh. Are they robust? Do they handle failures?

Report gaps and risks.
EOF
}

stage_10_prompt() {
cat <<'EOF'
## Stage 10: UI/UX Audit

Check frontend quality (sample key pages):

1. Error handling: Read src/app/error.tsx and src/app/global-error.tsx. Do they provide useful feedback?
2. Loading states: Search for loading.tsx files under src/app/. Are there Suspense boundaries? Search for "loading" or "isLoading" state patterns in page components.
3. Form validation: Read the booking wizard (src/app/(authenticated)/book/page.tsx). Does client-side validation match server Zod schemas? Are errors shown inline?
4. Accessibility: Search for aria- attributes in components. Check button elements for accessible names. Check img tags for alt text.
5. Toast/feedback: Search for "toast" or "sonner" usage. Do destructive actions show confirmation? Do save actions show success feedback?
6. Mobile: Check for responsive patterns (sm:, md:, lg: Tailwind classes) in key pages. Is the kiosk page touch-optimized?
7. Navigation: Read src/components/nav-bar.tsx and src/components/admin-sidebar.tsx. Are all sections reachable? Is the active state shown?

Report findings focusing on user-facing bugs and accessibility gaps.
EOF
}

stage_11_prompt() {
cat <<'EOF'
## Stage 11: Documentation Audit

Assess documentation completeness and accuracy:

1. README.md: Read it. Does it cover setup, architecture, deployment? Is it current?
2. CLAUDE.md: Read the first 200 lines. Check 5 specific claims against the actual codebase (e.g., test count, file paths, feature descriptions). Are any stale?
3. .env.example: Read it. Compare against actual env vars used in source (grep for process.env. across src/). List any vars used in code but missing from .env.example.
4. DEPLOYMENT.md: Does it exist? Is the deployment process documented?
5. API documentation: Is there an OpenAPI spec or API docs? Note absence.
6. Runbooks: Are common operations documented? (Xero reconnect, data export, backup restore, password reset for admin)
7. Architecture: Is there an architecture diagram or description beyond CLAUDE.md?

Report gaps — what's missing that an operator would need.
EOF
}

stage_12_prompt() {
cat <<'EOF'
## Stage 12: Dependency Audit

Audit project dependencies:

1. Run: npm outdated 2>&1 (report major version gaps)
2. Run: npm audit 2>&1 (report vulnerabilities by severity)
3. Unused dependencies: For each package in dependencies (not devDependencies), grep src/ for its import. List any packages that appear unused.
4. Pinning: Check package.json — are versions using ^ (caret) or exact pins? Is package-lock.json committed?
5. Notable risks: Flag any packages that are:
   - Deprecated
   - Unmaintained (no updates in 12+ months)
   - Pre-release/beta (check next-auth version specifically)
   - Known to have breaking changes planned

Report as a table: package | current | latest | status | risk.
EOF
}

###############################################################################
# Report file management
###############################################################################

init_report() {
  cat > "$REPORT_FILE" <<HEADER
# Comprehensive Best-Practice Review — TACBookings

**Date:** ${REPORT_DATE}
**Reviewer:** Claude Code (automated)
**Model:** ${MODEL}
**Repo state:** $(cd "$PROJECT_DIR" && git rev-parse --short HEAD) on $(cd "$PROJECT_DIR" && git branch --show-current)
**Tests:** $(cd "$PROJECT_DIR" && npm test 2>&1 | grep "Tests" | tail -1 || echo "unknown")
**Build:** $(cd "$PROJECT_DIR" && npm run build 2>&1 | grep -E "Compiled|error" | tail -1 || echo "unknown")

---

HEADER
  info "Report initialized at $REPORT_FILE"
}

###############################################################################
# Run a single stage
###############################################################################

run_stage() {
  local stage_num="$1"
  local stage_name="${stage_names[$stage_num]}"
  local log_file="$LOG_DIR/stage-${stage_num}.log"
  local prompt_fn="stage_${stage_num}_prompt"

  info "Stage ${stage_num}/12: ${stage_name}"

  local stage_prompt
  stage_prompt="$($prompt_fn)"

  local full_prompt="${PREAMBLE}

${stage_prompt}

INSTRUCTIONS:
- Read the plan at docs/claude-code-review-plan.md for full context on this stage.
- Write your findings as a markdown section. Start with: ## Stage ${stage_num}: ${stage_name}
- End with a count: **Findings: X CRITICAL, Y HIGH, Z MEDIUM, W LOW**
- Append your section to the file: ${REPORT_FILE}
- Do NOT modify any source code files.
- When done, output STAGE_COMPLETE on the last line."

  # Run claude in print mode with appropriate tools
  if claude \
    -p "$full_prompt" \
    --model "$MODEL" \
    --allowedTools "Read Glob Grep Bash(npm:*) Bash(git:*) Bash(wc:*) Bash(cat:*) Edit Write" \
    --permission-mode bypassPermissions \
    > "$log_file" 2>&1; then
    ok "Stage ${stage_num}: ${stage_name}"
  else
    local exit_code=$?
    fail "Stage ${stage_num}: ${stage_name} (exit code ${exit_code})"
    warn "Check log: ${log_file}"
    # Continue to next stage rather than aborting
  fi
}

###############################################################################
# Main
###############################################################################

cd "$PROJECT_DIR"

echo ""
echo "============================================"
echo "  TACBookings: Best-Practice Review"
echo "  Stages ${START_STAGE} through ${END_STAGE}"
echo "  Model: ${MODEL}"
echo "============================================"
echo ""

# Initialize report only if starting from stage 1
if [[ "$START_STAGE" -eq 1 ]]; then
  init_report
else
  if [[ ! -f "$REPORT_FILE" ]]; then
    warn "Report file does not exist. Creating header."
    init_report
  fi
  info "Resuming from stage ${START_STAGE}"
fi

# Run each stage sequentially
for stage in $(seq "$START_STAGE" "$END_STAGE"); do
  run_stage "$stage"
  echo ""
done

# Final summary
echo ""
echo "============================================"
echo "  Review Complete"
echo "============================================"
echo ""
echo "  Report: ${REPORT_FILE}"
echo "  Logs:   ${LOG_DIR}/"
echo ""

if [[ -f "$REPORT_FILE" ]]; then
  # Count findings
  critical=$(grep -c "CRITICAL" "$REPORT_FILE" 2>/dev/null || echo 0)
  high=$(grep -c "HIGH" "$REPORT_FILE" 2>/dev/null || echo 0)
  medium=$(grep -c "MEDIUM" "$REPORT_FILE" 2>/dev/null || echo 0)
  low=$(grep -c "LOW" "$REPORT_FILE" 2>/dev/null || echo 0)
  echo "  Approximate findings: ${critical} CRITICAL, ${high} HIGH, ${medium} MEDIUM, ${low} LOW"
fi
