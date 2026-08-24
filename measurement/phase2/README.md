# Phase 2: paired baseline/current timing evidence (#2352 slice 1)

Audience: developer / agent

This harness produces relative Windows/WSL evidence for the already-reviewed
slice-1 implementation. It does not decide whether work progresses. Every
completed aggregate from the exact declared final profile remains
`OWNER_REVIEW_REQUIRED`; every nonfinal/test profile, changed parameter, or
pair set other than exactly four valid evenly counterbalanced pairs remains
`PRELIMINARY_ONLY`. Four is the harness's
integrity choice for a balanced C-B/B-C final run; it is stricter than the
owner's verbatim minimum of three.

## Owner thresholds (verbatim)

- At least three contemporaneous current/baseline pairs are required.
- Preferred CPU reduction is at least 80%; below roughly 50% is the explicit stop condition; 50-80% requires owner review.
- Current warm cached median and p95 should be approximately 300 ms or below, with repeatable improvement, stable idle recovery and no unacceptable churn/memory/regeneration load.
- Windows/WSL results support relative comparison only, not exact Tokoroa capacity.

The word "approximately" is intentionally qualitative. The reporter records
median and p95 but applies no invented autonomous p95 gate. Every non-timing
correctness/security check must pass before timing; any failure stops
progression. The pre-timing report marks only `MC-08B` (current) and `BND-09`
(both sides) as `DEFERRED_TO_PHASE2`. It can reach only
`pre_timing_passed`, never a final correctness pass. Each sealed timing side
must replace its exact deferred set with independently derived `PASS` evidence
before a pair, pair set, or aggregate can complete.

## Safety and prerequisites

- Run the harness from Git Bash on Windows. Direct WSL/Linux execution has not
  been cleared for this host and fails closed.
- Activate the repository runtime in that same Git Bash process before the
  final run; the system `node` may otherwise be Node 22:

  ```bash
  eval "$(fnm env --shell bash)"
  fnm use --install-if-missing
  EXPECTED_NODE_VERSION="$(tr -d '\r\n' < .nvmrc)"
  test "$(node -p 'process.versions.node')" = "$EXPECTED_NODE_VERSION"
  # The reviewed repository pin is currently 24.15.0; .nvmrc is authoritative.
  ```

  The orchestrator and both runners reject any other major and seal the
  observed version in `inputs/node-version.txt`.
- Use only the isolated `tacbookings-measure` Compose project and its loopback
  ports. Never use production/staging credentials, databases, backups, or live
  providers.
- Do not copy `.env.measure` or any raw `results/` directory into a patch or PR.
  The frozen harness manifest explicitly excludes `.env.measure`. Automatic
  secret scanning must pass before side or set evidence is sealed or shared;
  still review raw application logs and Docker diagnostics manually before
  publication.
- The host must be quiet. Close build lanes, browser/E2E work, and heavy apps.
  `run-pair.sh` requires `QUIET_HOST_ATTESTED=YES`, captures Windows process/CPU
  and Docker evidence before/between/after sides, and fails if an unexpected
  running container or excessive sampled host CPU is present. The recorded
  limit is a contamination control, not a product-performance threshold.

  When that check reports an unexpected container, run `npm run stale-containers`
  (#2794) before doing anything else. It names each non-measurement container's
  owning issue and whether that issue is closed, which is usually the whole
  answer: the blockage is abandoned lane debris, not a live workload worth
  waiting for. **Clean the host; never widen `ALLOWED_RUNNING_CONTAINERS` to get
  a run started.** That allowlist is the contamination control itself, and the
  reporter deliberately has no removal mode — it tells you what is there, and a
  human runs the teardown.
- Build both images from immutable source archives, set
  `org.opencontainers.image.revision` to the exact source commit, and retain the
  archives. Do not identify an image by a mutable tag alone.
- Complete the exact correctness/security evidence chain for each image first.
  The timing manifest binds the SHA-256 of the last, create-only
  `COMPLETED.json`, not a naked Boolean report. The verifier walks backwards
  through immutable inputs, the exact 35-ID `MC-*`/`BND-*` census, producer
  source hashes, create-only producer results/raw files, exact raw manifest,
  secret scan, and independently derived report. The reviewed producer source
  archive contains every correctness and timing producer, its exact SHA-256
  manifest, and the archived writer census. At orchestration start the complete
  live timing harness is hashed again and every byte is matched to that archive;
  this sealed binding is carried through pair-set completion and aggregation.
  The correctness inputs also bind a typed installed-runtime snapshot: Node 24,
  both npm locks, exact Playwright/axe package manifests, the Playwright Chromium
  registry, and the hashed Node/Chromium executables.
  The correctness finalizer verifies the complete live producer-source census
  against the archive before deriving evidence and again immediately before its
  completion marker. A failed finalization removes only its derived report,
  scan, manifest, and completion files so the immutable raw run can be retried.
  A complete but failed, unverified, or owner-disposition-needed chain cannot
  enter timing, and no check outside the exact Phase 2-owned set may be deferred.
- `MC-03D` (CMS deletion invalidation) is a measured check. It was blocked as
  `OWNER_DISPOSITION_NEEDED` for as long as the product had no supported way to
  delete a CMS page, because an absent endpoint is never fabricated as a pass or
  an N/A. PR #2637 shipped `DELETE /api/admin/page-content`, so the block was
  resolved by implementation rather than by disposition: `source-census` binds
  the endpoint and its canonical invalidation structurally, and `cms-lifecycle`
  exercises it against the running image. Final timing still cannot start until
  it and every other required producer passes.

## One-time canonical database preparation

Prepare the sanctioned isolated dataset, then create one immutable custom dump.
The dump path must not already exist; the helper refuses to overwrite it.

```bash
cd C:/Users/jorda/Local_Repos/wt-measure
bash measurement/stack/measure-stack.sh with-private-env -- \
  bash measurement/stack/measure-stack.sh prepare-canonical-dump \
    C:/Users/jorda/AppData/Local/Temp/issue-2352/canonical.dump
```

Record the printed archive SHA-256. Each side is restored from that exact dump,
then the complete logical database is fingerprinted before and after timing.
Any drift aborts the pair. The runner also records the app's redacted database
target, DNS result, Postgres identity, container/network identity, and the full
uninterpolated Compose/resource definition so the restored database and the app
connection cannot be confused with another stack.

Every schema reset stops both `app` and `caddy` before `DROP SCHEMA`. Plain
`prepare` restarts them only after migrations and both seeds succeed. The
combined command above additionally keeps them stopped while `pg_dump` is
verified with `pg_restore --list` and atomically published, then starts them.
Any reset, seed, dump, publication or startup failure makes the command fail and
leaves both services stopped. Inspect the failure before recovery: if the target
archive is absent, correct the cause and rerun the combined command with an
absent target; if a target confirmed absent before the run now exists, atomic
publication completed, so retain and verify its printed SHA before deliberately
starting the stack. Never start writers
against a database whose reset or seed stage did not complete.

**One key was ADDED to the reviewed exact set under #3035, so an existing private
`.env.measure` needs one new line.** `USE_LOCAL_CAPTURE=true` joins `USE_AWS_SES`
and `USE_SMTP_RELAY` there. Without it the contract check fails loudly with
`measurement env key inventory differs from the reviewed exact set`, which is the
intended behaviour rather than a bug — the key set is exact on purpose. The value
in the file is inert for this stack (`docker-compose.measure.yml` hard-codes all
three flags on the app service, exactly as it hard-codes `APP_ENVIRONMENT_ROLE`);
what the entry buys is that an *ambient* `USE_LOCAL_CAPTURE` is refused rather
than quietly ignored, the same protection its two siblings already had.

`with-private-env` owns the same fixed machine-wide lock as final phase-2
orchestration. It copies `measurement/stack/.env.measure` to a new restrictive
private snapshot, HMAC-binds that snapshot with a fresh private key, exports the
three required bindings only to the child command, and token-verifies ownership
before deleting the snapshot, key and private audit. Do not source
`.env.measure`, export its values, manufacture these bindings manually, or run
an inner `measure-stack.sh` command outside this wrapper. The combined action
keeps reset, migration, seed and canonical-dump creation inside one lock.
Do not wrap `orchestrate-pairs.sh` with `with-private-env`: final orchestration
owns that same lock and creates its own evidence-retained snapshot audit.

## Bind correctness, sources, images, and expected responses

Copy `correctness-manifest.example.json` outside the repository results tree and
replace every placeholder. For both sides it binds:

- immutable Docker image ID and exact OCI revision;
- source archive path and SHA-256. It must be a `git archive` whose embedded
  commit ID exactly equals the OCI revision;
- correctness root `COMPLETED.json` path and SHA-256. Its copied overall result
  is never trusted; the verifier recomputes it from the exact chain;
- canonical database archive path and SHA-256;
- exact body SHA-256 and ETag for current `/about`, plus expected
  `X-Nextjs-Cache` classification for every route. Dynamic routes deliberately
  bind `body_sha256` and `etag` to `null`: per-request CSP nonces make their raw
  bodies unstable, while the exact correctness-completion checksum binds their
  independently verified content/security evidence chain.

Expected bodies/ETags come from the completed correctness run, never from the
first timed request. Current `/about` must be `HIT`; baseline `/about` and all
three controls must have no `X-Nextjs-Cache` header (the intended dynamic
classification). `verify-binding.mjs` compares the manifest to the image,
archives, and completion chain before any samples. The immutable correctness
inputs also bind the same side, image ID, OCI revision, and source/database
archive checksums. `correctness-report.example.json` deliberately illustrates
a not-yet-derived state; it is not permission to substitute a scalar pass.
`verify-http-proof.mjs` checks exact
status/body/ETag/classification immediately before and after every CPU block.

For each create-only correctness root, use the private wrapper shown in the
current-main producer README. After the producer runner returns successfully,
seal and independently derive that side's result before putting its completion
path in the manifest:

```bash
node measurement/phase2/bin/finalize-correctness-evidence.mjs \
  --dir C:/Users/jorda/AppData/Local/Temp/issue-2352/current-correctness

node measurement/phase2/bin/finalize-correctness-evidence.mjs \
  --dir C:/Users/jorda/AppData/Local/Temp/issue-2352/baseline-correctness
```

Each command refuses an existing derived seal, verifies the complete live and
archived producer-source set at both boundaries, scans the exact evidence tree,
and writes the required `COMPLETED.json`. A completed result that is failed,
unverified or `OWNER_DISPOSITION_NEEDED` remains ineligible for timing. No
check carries that last outcome any more; it stays in the vocabulary so a future
genuinely blocked check can be reported honestly instead of being forced into a
PASS or FAIL that does not fit.

## Exact run order

Run one complete orchestrated set in a quiet-host session. The owner's minimum
is three contemporaneous pairs; this wrapper deliberately runs four so C-B and
B-C each repeat twice, with no order imbalance:

1. current then baseline;
2. baseline then current;
3. current then baseline;
4. baseline then current.

Do not call `run-phase2.sh` or `run-pair.sh` directly for decision evidence.

```bash
cd C:/Users/jorda/Local_Repos/wt-measure
export QUIET_HOST_ATTESTED=YES

bash measurement/phase2/bin/orchestrate-pairs.sh \
  --manifest C:/Users/jorda/AppData/Local/Temp/issue-2352/correctness-manifest.json \
  --output-id post2637-final
```

The wrapper first copies `.env.measure` byte-for-byte to a restrictive private
lock directory and uses that snapshot for every Compose call. It rejects
ambient overrides, keeps the snapshot and common environment-audit HMAC key out
of publishable evidence, and removes them only while it still owns the lock.
It then snapshots and checksums the manifest and every referenced immutable
input, acquires a fixed machine-wide single-flight lock for the one Compose/DB
resource (independent of the configurable results root), continuously monitors
host contamination, assigns collision-proof pair IDs and absolute output roots,
enforces inter-side and inter-pair gaps, validates every sealed pair, and writes
its set-level completion marker only after all four return successfully. The
lock carries an ownership token so one process cannot remove another's lock.
`--output-id` must be new; never reuse a partial output directory. The live
harness/archive binding is re-verified at pair start, after each sealed side,
immediately before each pair and set finalization, and again by aggregation.
Changing a harness byte after the initial snapshot therefore invalidates the
run instead of leaving a valid-looking historical self-hash. If that happens
after pair or pair-set finalization, the runner removes only the exact derived
seal files and preserves the raw timing evidence for review or retry.

Restore and fingerprint hooks are prohibited for final decision evidence. The
orchestrator must use the reviewed canonical stack helpers, whose bytes are in
the frozen complete harness manifest. That manifest must contain the exact set
of every Node/shell file in `measurement/phase2/bin`, the base Compose file,
`Caddyfile.staging`, and both measurement-stack files; it is verified before
every side and its SHA-256 must be identical across the full set. The pair
runner receives the frozen manifest, exact side images/archive/checksum, and
explicit new output root. The side runner independently proves the launched
container image ID and after-fingerprint. It also binds the reviewed Caddy and
Mailpit images/resources and proves that loopback `127.0.0.1:8027` reaches
`app:3000` through the adapted Caddy config.

After every database restore, counts-only evidence proves that no Xero token or
prohibited integration credential exists, the analytics/AI/Xero/Google module
flags are all off, and no analytics measurement ID is stored (zero settings
rows are valid). The launched app's raw `Config.Env` is piped directly through
a sanitizer: exact runtime/database/local-Mailpit settings, blank live-provider
surfaces, blank seed overrides, and unknown sensitive key names fail closed.
Only classifications, audited key names, and a common opaque HMAC enter the
evidence; raw values, lengths, and prefixes do not.

The default maximum gaps between sides and between pairs are 600 seconds. A
restore or interruption that exceeds either invalidates the set rather than
silently weakening contemporaneity. Exact start/end/gap timestamps are in each
`pair.json` and the orchestration events. Do not loosen them during a run; use a
fresh output ID after any interrupted attempt.

Each side performs, in order:

1. immutable binding and complete environment/service/resource capture;
2. cold-start observations;
3. per-route warm-up, exact pre-proof, sequential CPU/timing block, exact
   post-proof. Every request inside the timed block retains its raw headers and
   body and must match the bound status/cache/body/ETag expectation; pre/post
   samples alone are not accepted;
4. isolated idle cycles, each less than 300 seconds, preserving the first
   request and its cgroup CPU separately from four follow-ups;
5. a separate 300+ second revalidation segment (never pooled with idle). The
   current trigger must be `STALE`, never `MISS`; CPU, cgroup, restart, memory,
   stats, and logs remain in-window until background regeneration is confirmed
   by a bound `HIT`. Baseline remains `ABSENT` and has no regeneration attempts;
6. bounded concurrency with a real request timeout, monotonic actual elapsed
   RPS, status counts, and classified errors;
7. database after-fingerprint, summary, output checksums, and durable
   `COMPLETED.json` marker.

Every timed segment has UTC boundary markers, cgroup CPU/memory/throttling/OOM
snapshots, at least two continuous 1-second Docker CPU/memory/PID/I/O samples
for app, Postgres, Caddy, and Mailpit, restart counts, and segment-scoped
application logs. The exact
configured segment/file set is required; missing cgroup fields, unbalanced or
empty container samples, invalid timestamps, or command stderr fail closed. A
restart or OOM aborts summarisation. Log noise, throttling, memory, and
regeneration load remain owner-reviewed evidence.

Tunables are `RUNS=200`, `WARMUP=20`, `COLD_RUNS=5`, `IDLE_CYCLES=3`,
`IDLE_SECONDS=120`, `REVALIDATION_SECONDS=305`, `CONC=10`, `DURATION=30`,
and `REQUEST_TIMEOUT_SECONDS=10`. A declared `final-decision` run requires
those values exactly, plus four pairs, 600-second side/pair gap limits, the
10-second host-monitor interval, and the exact four-container allowlist.
Changing any of them fails before execution. A rehearsal declares
`MEASUREMENT_PROFILE=nonfinal-test` and remains preliminary even if its values
happen to match. `IDLE_SECONDS >= 300` and `REVALIDATION_SECONDS < 300` also
fail closed.

## Aggregate without changing raw evidence

Point the aggregator at the completed, sealed orchestration output. It derives
the four pair directories from the checksummed set record; do not hand-select a
subset:

```bash
node measurement/phase2/bin/aggregate-pairs.mjs \
  --orchestration measurement/phase2/results/orchestration-post2637-final \
  --label "#2352 post-#2637 four-pair evidence" \
  --out-prefix C:/Users/jorda/AppData/Local/Temp/issue-2352/phase2-aggregate
```

Aggregation verifies every exact file-and-directory census (including no late
or case-variant extras), nested checksum/completion marker, unique pair ID,
exactly four final-profile pairs with equal C-B/B-C counts, non-overlapping chronology and
bounded gaps, one common correctness/harness/archive/logical-DB fingerprint,
the sealed live-harness-to-producer-archive binding, and the exact Phase 2-owned
PASS set for each re-derived side summary,
before/after database equality, response proof, exact sample shape,
restart/OOM status, and load errors. It re-derives each preserved `summary.json`
from sealed raw evidence instead of trusting summary fields. Aggregate JSON,
Markdown, their output manifest, and completion marker all refuse existing
paths; the completion marker binds the sealed orchestration manifest and the
aggregate checksums. The aggregate prefix resolves through existing real
ancestors with Windows case-folding and must be outside the sealed set. It
reports paired reductions, repeatability, relative
latency, idle/revalidation, control drift, cache proof,
memory/throttling/restart/log evidence, and concurrency. Those qualitative
dimensions are explicitly `OWNER_REVIEW_REQUIRED`; output never says a
progression gate autonomously passed.

## Dependency-free refutation tests

No install is required:

```bash
node measurement/phase2/bin/self-test.mjs
node measurement/phase2/bin/orchestrate-pairs.self-test.mjs
bash -n measurement/phase2/bin/run-phase2.sh
bash -n measurement/phase2/bin/run-pair.sh
bash -n measurement/phase2/bin/orchestrate-pairs.sh
bash -n measurement/stack/measure-stack.sh
```

The fixtures mutate the exact correctness census and chain, the two-stage
deferred/PASS boundary, missing/failing/forged Phase 2-owned IDs, producer cleanup,
raw census/checksums, duplicate cache/ETag headers, UTF-16/NUL/quoted/argument
secrets (including AWS session/security tokens and generic API keys), the
live-harness-to-producer-archive binding, measurement-env
quoting/duplicates/reparse points/ambient overrides,
every live-provider environment key, app/database invariants, profile
classification, and sealed file/directory census. They contain no credentials
or measurement results.

## Cleanup and reporting

Leave the isolated stack down while retaining its volume and images:

```bash
bash measurement/stack/measure-stack.sh with-private-env -- \
  bash measurement/stack/measure-stack.sh down
```

Report the generated evidence as preliminary/relative until the owner reviews
all qualitative dimensions. A later Tokoroa confirmation still checks warm
response time, container CPU/cache operation, immediate invalidation, CSP, and
proxy/filesystem behavior; Windows/WSL results are not Tokoroa capacity.
