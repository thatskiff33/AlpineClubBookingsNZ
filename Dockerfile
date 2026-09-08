FROM node:24.17-alpine AS base
RUN npm install -g npm@11.14.0 && npm cache clean --force

# Install dependencies only when needed
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma/
COPY prisma.config.ts ./
RUN --mount=type=cache,target=/root/.npm npm ci

# Build the application
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
ENV DATABASE_URL=postgresql://tac:password@postgres:5432/tacbookings

# Stripe publishable key is delivered at runtime from the encrypted DB store
# (#2082), never inlined at build time — so no NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
# build ARG/ENV here.

ARG NEXT_PUBLIC_SENTRY_DSN
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN

# Deployed-code knowledge bundle (AID-3, #2372). Generated here in the builder,
# where the dependencies exist (a plain `docker compose build` on a club's
# server has no host Node/npm toolchain, so generation cannot run outside the
# image). The commit SHA is INJECTED at build time via GIT_COMMIT_SHA because
# `.git` is absent from the build context; KNOWLEDGE_BUNDLE_OBSERVED_AT pins the
# observed-at for a byte-reproducible artifact. Both are passed by CI / the
# deploy runner (see .github/workflows/ci.yml and
# scripts/run-production-blue-green-deploy.sh). When GIT_COMMIT_SHA is absent
# (a bare `docker build`), the generator writes a placeholder-SHA bundle that the
# runtime loader treats as UNVERIFIED and fail-closes on — the image still
# builds and runs, with diagnostics code answers disabled. Generation FAILS
# CLOSED on any detected secret, stopping the build rather than shipping a leak.
# `docs/` is available to this stage (see the .dockerignore note); the runtime
# image still excludes raw docs — only the curated bundle is copied to the runner.
ARG GIT_COMMIT_SHA=""
ENV GIT_COMMIT_SHA=$GIT_COMMIT_SHA
ARG KNOWLEDGE_BUNDLE_OBSERVED_AT=""
ENV KNOWLEDGE_BUNDLE_OBSERVED_AT=$KNOWLEDGE_BUNDLE_OBSERVED_AT
RUN npm run diagnostics:bundle

# Release identifier for the per-release public-website CSP nonce (#2352 D1).
# Declared in the BUILDER as well as the runner on purpose: a bundle that inlines
# `process.env` at build time captures this value, a runtime read sees the runner's,
# and setting both from the one ARG is what stops the two disagreeing. CI and
# scripts/run-production-blue-green-deploy.sh pass the commit SHA. Absent (a bare
# `docker build`), src/lib/release-nonce.ts falls back to GIT_COMMIT_SHA and then to
# one random value per process, logging an error — see that file for why a
# multi-reader deployment must not rely on the fallback.
ARG RELEASE_ID=""
ENV RELEASE_ID=$RELEASE_ID

# Optional Node flags for the BUILD only (not the runtime image).
#
# Empty by default, so every deployment builds exactly as it did before this
# existed — an empty NODE_OPTIONS is ignored by Node. It is here because
# `next build` is the memory peak of the whole image, and on a small server it
# can exhaust Node's default heap and be OOM-killed. The operator's alternative
# was editing this line locally and re-applying it after every `git pull`.
#
# Set it through compose, which maps NODE_BUILD_OPTIONS from .env onto this arg:
#   NODE_BUILD_OPTIONS=--max-old-space-size=4096
#
# Deliberately NOT named NODE_OPTIONS on the .env side. That name is read by
# every Node process, so a developer who has it set in their shell for an
# unrelated reason would silently change what the image is built with; the build
# knob is its own name, and only this ARG turns it into NODE_OPTIONS, only here.
#
# A declared ARG is exposed to RUN as an environment variable, which is why the
# build line below needs no change.
ARG NODE_OPTIONS=""

RUN npx prisma generate
RUN npm run build

# Production image
FROM node:24.17-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV TZ=Pacific/Auckland
# DEFENCE IN DEPTH ONLY (#3252). `TZ` above was pinned and the COLLATION was not,
# which is the whole of #3252 in one line: the environment-dependent thing
# somebody thought about is controlled, and the one nobody thought about is not.
# Bare `localeCompare` resolves its collation from these variables, and a stored
# booking-exception fingerprint used to depend on it - so a base-image bump could
# have made approval report an untouched member request as tampered with.
#
# `en_US.UTF-8` is deliberate and is NOT a preference: it is what this container
# resolves TODAY with nothing set, measured inside the running image (node
# 24.17.0, ICU 78.3, `Intl.Collator().resolvedOptions().locale` -> `en-US`).
# Pinning anything else would quietly re-sort every admin list, email and CSV in
# the product, because those orderings are locale-aware ON PURPOSE. So this
# changes no behaviour; it stops the behaviour changing by itself.
#
# BOTH VARIABLES, because they are not the same lever: `LANG` is the fallback and
# `LC_ALL` overrides everything, so setting only `LANG` leaves an inherited
# `LC_ALL` in charge. Verified on `node:24.17-alpine` that Node really honours
# them despite musl having no locale support of its own - `LANG=da_DK.UTF-8`
# resolves `da-DK` and reverses `Aaberg` against `Zylstra`, while `en_US.UTF-8`
# resolves `en-US` exactly as the unset default does.
#
# It is defence in depth and nothing more. Every path where an order becomes part
# of a stored or re-derived identity now goes through `compareOrdinal`
# (`src/lib/ordinal-order.ts`), which has no ICU dependency at all, so those are
# locale-proof whatever these variables say.
ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8

RUN apk add --no-cache aws-cli postgresql16-client
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
  /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static/ ./.next/static/
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/node_modules ./node_modules
# Guaranteed placement of the deployed-code knowledge bundle (AID-3, #2372)
# alongside the standalone trace, so the runtime loader
# (src/lib/diagnostics/knowledge/load.ts) finds it at
# /app/.artifacts/diagnostics/knowledge-bundle.json regardless of tracing. The
# builder's `npm run diagnostics:bundle` step above always writes this path (a
# real bundle, or a placeholder-SHA one the loader fail-closes on), so this COPY
# never fails.
COPY --from=builder /app/.artifacts ./.artifacts

RUN mkdir -p .next/cache && chown nextjs:nodejs .next/cache

# Per-release public-website CSP nonce (#2352 D1). The value has to be readable
# from the FINISHED image's own environment, because that is where
# src/lib/release-nonce.ts reads it. Repeating the ARG here is what promotes the
# build argument into a runtime ENV; the check below is what proves it, so a
# Dockerfile that passed the ARG but forgot the ENV — or a compose file that never
# forwarded it — fails visibly at build instead of falling back silently at
# runtime. Empty is tolerated (a bare `docker build` has no release), and says so.
ARG RELEASE_ID=""
ENV RELEASE_ID=$RELEASE_ID
# GIT_COMMIT_SHA is declared in the runner too, so src/lib/release-nonce.ts's
# documented SECOND fallback is real rather than aspirational. It used to be a
# builder-only ENV, so a runtime read saw nothing and the chain skipped straight
# past it (slice-1 review finding). Anything that passes the knowledge-bundle arg
# but not RELEASE_ID now still gets a per-release nonce.
ARG GIT_COMMIT_SHA=""
ENV GIT_COMMIT_SHA=$GIT_COMMIT_SHA
# Empty is tolerated rather than fatal: a bare `docker build` and a plain
# `docker compose build` both legitimately have no release, and next.config.ts
# substitutes a per-BUILD seed into every bundle for exactly that case, so the
# nonce is still one value per release. The message says which state the image is
# in; CI asserts the real value on the image it publishes (publish-ghcr-images).
RUN node -e "const id=(process.env.RELEASE_ID??'').trim(); const sha=(process.env.GIT_COMMIT_SHA??'').trim(); if(id===''&&sha===''){console.warn('WARNING: neither RELEASE_ID nor GIT_COMMIT_SHA is set in the runtime image. The public website CSP nonce falls back to the build-time seed baked into the bundles (#2352). That is safe, but the deployed revision is not identifiable from the image.');}else{console.log('Release identifier is readable in the runtime image (RELEASE_ID: '+id.length+' characters, GIT_COMMIT_SHA: '+sha.length+' characters).');}"

# Image Manager uploads are written here at runtime. Create the directory owned
# by the app user so that a freshly-mounted named volume (docker-compose:
# image_uploads -> /app/public/images) inherits uid 1001 ownership on first init
# and is writable under the read-only container root filesystem.
RUN mkdir -p public/images && chown -R nextjs:nodejs public/images

# Local database backups land here when the compose stack mounts a volume at
# /backups (BACKUP_LOCAL_DIR). Created and owned by the app user in the IMAGE so
# a named volume mounted over it inherits uid 1001 on first init — the same
# mechanism /app/public/images relies on. Without this the default volume would
# be root-owned and the app could not write its own backups.
RUN mkdir -p /backups && chown -R nextjs:nodejs /backups

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
