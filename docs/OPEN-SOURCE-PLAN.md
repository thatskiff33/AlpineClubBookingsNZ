# Open-source TACBookings via full extraction (upstream/downstream)

This is the canonical plan for making TACBookings publicly available on GitHub while continuing to run TAC's production deployment. It is the source of truth: when this doc and any issue, comment, or commit disagree, this doc wins. Pivots require a Decision log entry at the bottom of this file *before* code changes.

## Context

We are making TACBookings public so other small clubs can adopt it, while continuing to deploy and develop for Tokoroa Alpine Club. The chosen approach:

- **Path B**: properly refactor before publishing so the public repo is genuinely adoptable, not a stripped-down dump.
- **Dev workflow**: public repo is the source of truth; TAC's actual deployment lives in a private fork that pulls from public upstream and adds a thin TAC-specific overlay (branding, config, seed data).

This is a multi-week effort, sequenced so TAC's production never breaks. Each phase is independently shippable to TAC's prod.

## Target architecture

```
GitHub: thatskiff33/TACBookings  (PUBLIC — generic, MIT, config-driven)
  ├── src/                       generic application code
  ├── prisma/                    schema + generic migrations
  ├── config/                    *.example.json (templates only)
  ├── public/branding/           default placeholder logo/favicon
  └── docs/                      generic documentation

GitHub: thatskiff33/TACBookings-tokoroa  (PRIVATE — TAC deploy fork)
  ├── (everything above, via `git pull upstream main`)
  ├── config/club.json           TAC's actual config (gitignored upstream)
  ├── config/features.json       TAC's feature flags
  ├── public/branding/logo.png   TAC's real logo (gitignored upstream)
  ├── seeds/tokoroa/             TAC's seed data (gitignored upstream)
  ├── .env                       TAC's real secrets (already gitignored)
  └── deploy/                    TAC-specific deploy scripts if any
```

Production at tokoroa.org.nz deploys from `TACBookings-tokoroa`. Every generic improvement flows: develop in `TACBookings` (public) → merge → `cd TACBookings-tokoroa && git pull upstream main` → deploy.

## Governance

Four artifacts work together:

- **`docs/OPEN-SOURCE-PLAN.md`** (this file) — canonical plan + decision log.
- **GitHub Epic issue** in `thatskiff33/TACBookings` — high-level tracker, pinned, links to all phase sub-issues.
- **GitHub sub-issues** — one per phase, with acceptance criteria from this plan as a checklist. PRs reference them.
- **`MEMORY.md` entry** in Claude's auto-memory — pointer so every future Claude session in this repo auto-loads context.

**Anti-drift rules**:
1. Pivots require a Decision log entry in this file *before* code changes. A plan-doc diff with no decision log entry is a smell.
2. A phase issue cannot be closed until its acceptance-criteria checklist is fully ticked.
3. Every PR includes a "Plan adherence" line referencing the phase issue + flagging deviations.

**Multi-session / multi-agent flow**:
- New Claude session in this repo: memory points to the epic → read this doc → read epic + current phase issue → pick up the work.
- Subagents spawned for a phase: prompt them with links to this doc, the phase issue, and the acceptance criteria. Their report becomes a comment on the issue.
- Blocker or conflict: comment on the issue with details; do not silently change approach. The next session resolves and updates the decision log below.

## Phasing (each phase is independently mergeable + deployable to TAC)

### Phase 0 — Set up tracking (2 hours)

Done before any refactor work begins.

- Create `docs/OPEN-SOURCE-PLAN.md` (this file).
- Create the GitHub Epic issue with title "Epic: Open-source TACBookings via full extraction (upstream/downstream)". Body: link to this doc + checklist of phase sub-issue references.
- Create 13 phase sub-issues (Phases 0–12), each with the phase section copied in and an acceptance-criteria checklist. Labels: `area: open-source`, `type: phase`.
- Update `.github/pull_request_template.md` to add a "Plan adherence" line.
- Save a memory entry pointing future Claude sessions at the epic.

**Acceptance criteria**:
- [ ] `docs/OPEN-SOURCE-PLAN.md` committed to main
- [ ] Epic issue created and pinned
- [ ] 13 phase sub-issues created and linked from the epic
- [ ] PR template updated
- [ ] Memory entry saved

### Phase 1 — Configuration architecture (1–2 days)

Set the patterns. No behavior changes; just scaffolding.

- Create `config/` directory.
- Define schema files (e.g., Zod or just TypeScript types) for `ClubConfig` and `FeatureFlags`.
- Pick a loader pattern: read `config/club.json` at boot, fall back to `config/club.example.json`, validate via Zod, expose as a typed module (`src/config/club.ts`).
- Same for features: `src/config/features.ts` driven by env vars (`FEATURE_KIOSK=true`) for ease.
- Commit `config/club.example.json` and `config/club.json` (TAC's real values) to the repo *for now* — the split into public/private happens in Phase 9.
- Add the loader unit tests.

**Files added:**
- `config/club.example.json`
- `config/club.json` (TAC values; will be gitignored in public later)
- `src/config/club.ts`
- `src/config/features.ts`
- `src/config/__tests__/`

### Phase 2 — Extract club identity (2–3 days)

Migrate hardcoded TAC strings to config. Touch one area at a time so each commit is reviewable.

Audit found ~157 hardcoded "Tokoroa Alpine Club" + ~159 "tokoroa" references. Group them:

- **Display strings** (emails, pages, error messages): replace with `clubConfig.name` / `clubConfig.supportEmail` etc.
- **Email sender**: `src/lib/email-sender.ts` `DEFAULT_EMAIL_FROM` → config-driven. Likely partly done.
- **Email templates** (`src/lib/email-templates.ts`): every "Tokoroa Alpine Club" → `clubConfig.name`; every `tokoroa.org.nz` URL → `clubConfig.publicUrl`.
- **Seed file** (`prisma/seed.ts:209`): use `clubConfig.supportEmail`.
- **Domain/Sentry references**: most are already env-driven; verify.

**Verification per area**: snapshot the rendered email/page before, refactor, confirm identical output with TAC's `club.json` values.

### Phase 3 — Extract operational config (3–5 days)

The "things every club differs on":

- **Beds / accommodation layout**: today hardcoded somewhere (find via grep `bed` in `src/`). Move to `config/club.json` → `beds: [{id, name, capacity, type}]`. Migration code that depended on hardcoded values now reads from config or DB rows seeded from config.
- **Membership tiers / pricing**: into config.
- **Currency, timezone, locale**: env vars (`CURRENCY=NZD`, `TZ=Pacific/Auckland`).
- **Xero account codes**: these are TAC-specific — leave as env-driven (`XERO_REVENUE_ACCOUNT=...`). Already env-driven per audit.
- **NOT extracted**: NZ tax handling, Stripe webhook handling, generic business logic — these are correct for any club and shouldn't be configurable.

Run the full test suite after each extraction. Deploy to TAC's production after Phase 3 to confirm nothing regressed.

### Phase 4 — Feature flags (2–3 days)

Identify optional modules and add toggles. Candidate modules to flag (verify by reading routes):

- `FEATURE_KIOSK` — kiosk PIN access
- `FEATURE_CHORES` — chore/roster module if present
- `FEATURE_FINANCE_DASHBOARD` — the finance dashboard (already a distinct boundary per ADR-003)
- `FEATURE_WAITLIST` — waitlist if it's optional
- `FEATURE_XERO_INTEGRATION` — Xero sync (default off for clubs without Xero)

Gate at three levels:
1. **Routes/API**: return 404 if flag off (a single middleware can do this from a route → feature map).
2. **Navigation**: filter nav items from `clubConfig` or feature map.
3. **Cron jobs**: skip registration if feature off.

Database tables for disabled features can exist but stay empty — simpler than conditional migrations.

### Phase 5 — Branding extraction (1–2 days)

- Move `public/images/tac-logo.png` → `public/branding/logo.png`.
- Add `public/branding/logo.example.png` (generic placeholder) for upstream.
- Update all logo references to use `/branding/logo.png`.
- Same for favicon, og-image, any other club-identifying images.
- TAC's actual `branding/` content will be gitignored from public in Phase 9.

### Phase 6 — Sanitization pass (1–2 days)

After the structural work, the remaining string-level cleanups:

- `src/lib/__tests__/xero-find-or-create-contact.test.ts` — replace `jordan.hartleysmith@gmail.com` with `test.contact@example.org`.
- `prisma/seed.ts` — read admin email/password from `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD` env, fail loudly if unset. Remove `admin123` and `support@tokoroa.org.nz` from `README.md`.
- Verify "password change required on first login" enforcement actually works in the auth code (not just claimed in the seed log).
- `LICENSE` — confirm copyright holder.
- Final grep: only acceptable remaining `tokoroa`/`Tokoroa Alpine Club` references should be in (a) README's "reference deployment" line, (b) `config/club.json` (TAC's private values).

### Phase 7 — Issue triage (a few hours)

The 366 GitHub issues become public when the repo flips. Skim (`gh issue list --state all --limit 400`) for:
- Customer names
- Specific incident details / financial figures
- Internal communications referenced

Edit/redact anything sensitive. Most issues look like technical task tracking and should be fine.

### Phase 8 — Documentation for adopters (1–2 days)

The public repo needs a "deploy this for your club" path:

- **README**: rewrite intro for generic audience. Add "Adopting this for your club" section listing: what env vars are required, where to put `config/club.json`, where to put branding, how to seed initial admin, how to flip feature flags.
- **Reference deployment note**: "TACBookings is the open-source booking system originally built for and deployed at [Tokoroa Alpine Club](https://tokoroa.org.nz)."
- **CONTRIBUTING.md**: confirm it makes sense for outside contributors (PR workflow, test requirements).
- **CONFIGURATION.md** (new): full env var reference + `config/club.json` schema.
- **DEPLOYMENT.md**: ensure deploy docs are generic, not TAC-specific.

### Phase 9 — Split into two repos (1 day)

This is the architectural cutover. Sequence matters.

**9a. Backup**
```bash
cp -r /home/ubuntu/TACBookings /home/ubuntu/TACBookings.backup-pre-split
```

**9b. Create the private TAC overlay repo**
- On GitHub, create `thatskiff33/TACBookings-tokoroa` (private, empty).
- In a fresh clone of the current `TACBookings` repo, this becomes TAC's working dir going forward.
- Push the current state (with all TAC config/branding) to the new private remote:
  ```bash
  cd /home/ubuntu/TACBookings-tokoroa  # fresh clone
  git remote rename origin upstream
  git remote add origin git@github.com:thatskiff33/TACBookings-tokoroa.git
  git push -u origin main
  ```

**9c. Strip TAC-specific files from the public-bound `TACBookings`**
- Remove TAC overlay files from tracking (they stay in the private fork from 9b):
  ```bash
  git rm --cached config/club.json
  git rm --cached public/branding/logo.png
  git rm -r --cached seeds/tokoroa/  # if present
  ```
- Add to `.gitignore`:
  ```
  config/club.json
  config/features.json
  public/branding/logo.png
  seeds/tokoroa/
  ```
- Keep `.example` versions tracked: `config/club.example.json`, `public/branding/logo.example.png`.
- Commit: "chore: separate TAC overlay from public-bound code"

**9d. Verify upstream/downstream sync works**
```bash
cd /home/ubuntu/TACBookings-tokoroa
git pull upstream main
# Confirm: TAC's club.json/branding/etc. still present locally; upstream changes merged
npm test
```

### Phase 10 — Git history rewrite (1 hour)

Strip personal email from authorship across both repos.

```bash
# Get the GitHub noreply form:
gh api users/thatskiff33 --jq .id
# Construct: <id>+thatskiff33@users.noreply.github.com
```

For **each repo** (public-bound first, then private fork):
```bash
sudo apt install git-filter-repo
echo "Jordan <ID+thatskiff33@users.noreply.github.com> <jordan.hartleysmith@gmail.com>" > /tmp/mailmap.txt
git filter-repo --mailmap /tmp/mailmap.txt --force
git remote add origin <repo-url>  # filter-repo removes remotes; re-add
git push --force-with-lease origin main
```

Verify with `git shortlog -sne --all` — no personal email.

### Phase 11 — Flip TACBookings to public (15 minutes)

- GitHub UI: `TACBookings` → Settings → "Change visibility" → Public.
- Enable: secret scanning + push protection (free on public), CodeQL default config, Dependabot already on.
- Add topics: `nextjs`, `prisma`, `stripe`, `xero`, `booking-system`, `nonprofit-software`.
- Write a description + homepage URL.

### Phase 12 — Document the ongoing dev workflow (1 day)

A short doc in `TACBookings-tokoroa/README.md` (or the main public README's "For maintainers" section) explaining the future workflow:

- **Generic feature/fix**: branch off `TACBookings` (public) → PR → merge to public main → `cd TACBookings-tokoroa && git pull upstream main` → deploy to TAC.
- **TAC-specific change** (config, branding, TAC-only data fix): branch off `TACBookings-tokoroa` (private) → PR → merge → deploy.
- **Hotfix in production**: branch off `TACBookings-tokoroa`, fix, deploy, then port the generic part back to public.

CI runs in both repos. Both should run tests. The private repo's CI tests with TAC's real `club.json`; the public repo's CI tests with `club.example.json`.

## Critical files to modify (across phases)

Phase 1–6 (in `TACBookings` before split):
- `config/club.example.json`, `config/club.json` — new
- `src/config/club.ts`, `src/config/features.ts` — new
- `src/lib/email-sender.ts`, `src/lib/email-templates.ts` — config-driven
- `prisma/seed.ts` — env-driven admin, config-driven club identity
- `src/lib/__tests__/xero-find-or-create-contact.test.ts` — fake email
- `README.md`, `LICENSE`, `CHANGELOG.md`, `SUPPORT.md`, `NOTICE.md`, `DEPLOYMENT.md`, `CONTRIBUTING.md`, all `docs/**/*.md` — generic phrasing + reference deployment note
- `public/branding/` — restructured logo paths
- `.env.example` — updated placeholders
- `.gitignore` — add TAC overlay paths in Phase 9

Phase 9–12: repo structure + dev workflow docs.

## Verification

Per phase:
- `npm test` green (479 test files)
- `npm run typecheck && npm run lint` green
- Deploy to TAC prod, smoke test booking + payment + email flows

End-to-end before flipping public:
1. Fresh clone of (what will be) the public `TACBookings` in `/tmp/`. With only `config/club.example.json` + placeholder branding, can you boot the app, seed an admin, make a booking? **This is the adopter experience test.**
2. `grep -ri --exclude-dir=node_modules --exclude-dir=.next "jordan.hartleysmith\|admin123" .` — zero hits in the public-bound repo.
3. `grep -ri --exclude-dir=node_modules --exclude-dir=.next "tokoroa\|Tokoroa Alpine Club" .` — only matches in README "reference deployment" line.
4. `git shortlog -sne --all` (after Phase 10) — no personal email.
5. From the private `TACBookings-tokoroa` repo, run `git pull upstream main` and confirm TAC config/branding files survive the merge as untracked-but-present local files.
6. After Phase 11: open the public repo in an incognito browser — confirm what an outsider sees matches expectations.

## Risks

- **This is weeks of work.** Estimate 3–5 weeks part-time. Each phase is independently shippable, so we can pause anywhere without leaving prod broken.
- **Production must keep working throughout.** Deploy after each phase to catch regressions early. Don't batch.
- **Schema changes are forever.** Once a migration is committed and run in prod, you can't easily reshape it. Plan Phase 3 (operational config) carefully — prefer adapting code to read from config than reshaping tables.
- **History rewrite is destructive** (Phase 10). The Phase 9a backup is non-negotiable. Force-push only while still private.
- **Going public is reversible, but anything scraped/cloned/archived isn't.** Be confident before Phase 11.
- **Feature-flag temptation**: don't over-flag. Only flag what is genuinely optional for *most* potential adopters.
- **Two repos = two repos to maintain.** Slightly more overhead per change. The payoff is a healthy upstream other clubs can actually use.

## Decision log

Pivots, scope changes, or "we discovered X so we're doing Y instead" entries go here. Each entry: date, what changed, why.

<!-- Example format:
### 2026-05-20 — Deferred FEATURE_KIOSK to v2
Discovered during Phase 4 that the kiosk module isn't cleanly separable from the booking flow; gating it cleanly would require rearchitecting the session layer. Decision: ship Phase 4 with the other 4 flags, file a v2 issue to revisit kiosk separation. Plan section updated.
-->
