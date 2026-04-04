# Stack and Structure Audit

**Date:** 2026-04-04
**Scope:** Tech stack, folder structure, environment/config, Docker setup, third-party integrations

---

## 1. Tech Stack

| Layer | Technology | Version | Purpose |
|---|---|---|---|
| Framework | Next.js (App Router) | 16.2.2 | Full-stack TypeScript monolith (frontend + API routes) |
| Language | TypeScript | 5.x | Type-safe application code |
| Runtime | Node.js | 20 (alpine) | Server runtime (Docker base image) |
| Database | PostgreSQL | 16 (alpine) | Primary data store |
| ORM | Prisma | 6.19.3 | Type-safe database access, schema management, migrations |
| Auth | NextAuth (Auth.js) v5 | 5.0.0-beta.30 | Credentials provider, JWT sessions, Prisma adapter |
| UI | Tailwind CSS + shadcn/ui | 4.x | Utility-first CSS with Radix UI-based components |
| Payments | Stripe | SDK 22.0.0 | PaymentIntents, SetupIntents, webhooks |
| Accounting | Xero | xero-node 15.0.0 | OAuth2 integration for invoices, contacts, memberships |
| Email | nodemailer | 8.0.4 | Transactional email via AWS SES (SMTP) |
| Scheduling | node-cron | 4.2.1 | Background jobs (booking confirmation, Xero sync, backups) |
| Validation | Zod | 4.3.6 | Input validation on all API routes |
| Charts | Recharts | 3.8.1 | Admin reports dashboard |
| Testing | Vitest | 4.1.2 | Unit and integration tests |
| Reverse Proxy | Caddy | 2 (alpine) | Automatic HTTPS via Let's Encrypt |
| Hosting | AWS Lightsail | - | Docker Compose on single instance |

### Notable Frontend Libraries

- **Radix UI** - Primitives for avatar, dialog, dropdown-menu, label, select, separator, tabs
- **Lucide React** - Icon library
- **next-themes** - Dark mode support
- **sonner** - Toast notifications
- **date-fns** - Date manipulation
- **class-variance-authority / clsx / tailwind-merge** - Component styling utilities

---

## 2. Folder Structure (2 Levels Deep)

```
TACBookings/
├── .claude/                        # Claude Code configuration
│   ├── rules/                      # Path-scoped rules (api.md, database.md, testing.md, stripe.md)
│   └── settings.json               # Permissions and hooks
├── docs/                           # Documentation
│   └── audit/                      # Audit documents
├── prisma/                         # Database layer
│   ├── migrations/                 # Migration history
│   ├── schema.prisma               # Data model (16 models, 9 enums)
│   └── seed.ts                     # Seed script (rooms, policies, chores, admin user)
├── public/                         # Static assets
├── src/                            # Application source
│   ├── app/                        # Next.js App Router
│   │   ├── (admin)/                # Admin pages (role-guarded layout)
│   │   ├── (authenticated)/        # Member pages (auth-guarded layout)
│   │   ├── (public)/               # Public pages (login, register, password reset)
│   │   ├── (website)/              # Marketing/public website pages
│   │   ├── api/                    # API routes (see Section 2a)
│   │   ├── error.tsx               # 500 error boundary
│   │   ├── global-error.tsx        # Global error boundary
│   │   ├── not-found.tsx           # 404 page
│   │   ├── layout.tsx              # Root layout with auth provider
│   │   ├── globals.css             # Global styles
│   │   └── sitemap.ts              # Sitemap generator
│   ├── components/                 # React components
│   │   ├── admin/                  # Admin-specific components
│   │   ├── stripe/                 # Stripe payment components (PaymentForm, SetupForm, StripeProvider)
│   │   ├── ui/                     # shadcn/ui component library
│   │   ├── admin-sidebar.tsx       # Admin navigation sidebar
│   │   ├── booking-calendar.tsx    # Date picker with availability
│   │   ├── booking-payment-section.tsx
│   │   ├── guest-form.tsx          # Guest details form
│   │   ├── nav-bar.tsx             # Main navigation
│   │   ├── promo-code-input.tsx    # Promo code entry component
│   │   └── website-footer.tsx      # Public site footer
│   ├── lib/                        # Core business logic and utilities
│   │   ├── __tests__/              # Test files (14 test files, 292 tests)
│   │   ├── age-tier.ts             # Age tier + season year computation
│   │   ├── audit.ts                # Audit logging helper
│   │   ├── auth.ts                 # NextAuth configuration
│   │   ├── backup.ts               # pg_dump backup + S3 upload
│   │   ├── bumping.ts              # FIFO non-member bumping algorithm
│   │   ├── cancellation.ts         # Cancellation policy + refund calculation
│   │   ├── capacity.ts             # Bed availability calculator (29-bed cap)
│   │   ├── chore-allocator.ts      # Round-robin chore assignment
│   │   ├── cron-confirm-pending.ts # Auto-confirm pending bookings
│   │   ├── email-templates.ts      # Branded HTML email templates (7 templates)
│   │   ├── email.ts                # Email transport (AWS SES via nodemailer)
│   │   ├── pricing.ts              # Rate calculation engine
│   │   ├── prisma.ts               # Prisma singleton client
│   │   ├── promo.ts                # Promo code validation + redemption
│   │   ├── rate-limit.ts           # In-memory rate limiter
│   │   ├── stripe.ts               # Stripe client + helpers
│   │   └── xero.ts                 # Xero client, OAuth, invoices, contacts, memberships
│   ├── types/                      # TypeScript type declarations
│   │   └── next-auth.d.ts          # NextAuth session type augmentation
│   ├── instrumentation.ts          # Next.js instrumentation hook (cron scheduler)
│   └── middleware.ts               # Security headers (CSP, HSTS, X-Frame-Options, etc.)
├── .env.example                    # Environment variable template
├── .gitignore
├── Caddyfile                       # Caddy reverse proxy config
├── CLAUDE.md                       # Project instructions and build history
├── Dockerfile                      # Multi-stage container build
├── docker-compose.yml              # Service orchestration
├── eslint.config.mjs               # ESLint configuration
├── next.config.ts                  # Next.js config (standalone output)
├── package.json                    # Dependencies and scripts
├── postcss.config.mjs              # PostCSS configuration
├── prisma.config.ts                # Prisma config (dotenv loading)
├── tsconfig.json                   # TypeScript configuration
└── vitest.config.ts                # Vitest test runner config
```

### 2a. API Route Structure

```
src/app/api/
├── admin/
│   ├── bookings/                   # Admin booking management
│   ├── cancellation-policy/        # Policy CRUD
│   ├── chores/                     # Chore template CRUD
│   │   └── [id]/
│   ├── members/                    # Member management
│   │   └── [id]/
│   ├── promo-codes/                # Promo code CRUD
│   │   └── [id]/
│   ├── reports/                    # Analytics/reporting
│   ├── roster/                     # Chore roster management
│   │   └── [date]/
│   ├── seasons/                    # Season CRUD
│   │   └── [id]/
│   └── xero/                       # Xero integration (connect, callback, sync, status)
├── auth/
│   ├── [...nextauth]/              # NextAuth handler
│   ├── forgot-password/
│   ├── register/
│   └── reset-password/
├── availability/                   # Bed availability query
├── bookings/                       # Booking CRUD + quote + cancel
│   ├── [id]/
│   │   └── cancel/
│   ├── cancel/
│   └── quote/
├── chores/
│   └── roster/[date]/print/        # Printable roster
├── contact/                        # Contact form
├── cron/                           # Manual cron trigger
│   └── xero/                       # Xero membership refresh cron
├── payments/                       # Stripe payment intents + setup intents
│   └── charge-saved-method/
├── profile/                        # Member profile
├── promo-codes/
│   └── validate/                   # Promo code validation
├── seasons/                        # Public season listing
└── webhooks/
    ├── stripe/                     # Stripe webhook handler
    └── xero/                       # Xero webhook handler
```

---

## 3. Environment and Config Files

### .env.example - Environment Variables

| Group | Variable | Description |
|---|---|---|
| **Database** | `DATABASE_URL` | PostgreSQL connection string |
| | `DB_PASSWORD` | Database password (used in docker-compose) |
| **NextAuth** | `NEXTAUTH_URL` | Application base URL |
| | `NEXTAUTH_SECRET` | JWT signing secret |
| **Stripe** | `STRIPE_SECRET_KEY` | Server-side Stripe API key |
| | `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Client-side Stripe key |
| | `STRIPE_WEBHOOK_SECRET` | Webhook signature verification |
| **Xero** | `XERO_CLIENT_ID` | OAuth2 app client ID |
| | `XERO_CLIENT_SECRET` | OAuth2 app client secret |
| | `XERO_REDIRECT_URI` | OAuth2 callback URL |
| | `XERO_ENCRYPTION_KEY` | AES-256-GCM key for token encryption (64-char hex) |
| | `XERO_WEBHOOK_KEY` | Webhook HMAC verification key |
| **Email** | `SMTP_HOST` | SES SMTP endpoint |
| | `SMTP_PORT` | SMTP port (587) |
| | `SMTP_USER` | SES SMTP username |
| | `SMTP_PASS` | SES SMTP password |
| | `EMAIL_FROM` | Sender address |
| | `CONTACT_EMAIL` | Admin contact email |
| **Deployment** | `DOMAIN` | Domain for Caddy HTTPS |
| **Cron** | `CRON_SECRET` | Secures manual cron trigger endpoints |
| **Backups** | `BACKUP_ENABLED` | Enable/disable automated backups |
| | `BACKUP_S3_BUCKET` | S3 bucket name (optional) |
| | `BACKUP_S3_REGION` | AWS region (default: ap-southeast-2) |
| | `BACKUP_S3_ACCESS_KEY_ID` | AWS access key |
| | `BACKUP_S3_SECRET_ACCESS_KEY` | AWS secret key |
| | `BACKUP_RETENTION_DAYS` | Local backup retention (default: 7) |
| | `BACKUP_CRON_SCHEDULE` | Backup timing (default: `0 3 * * *`) |

### tsconfig.json

- Target: ES2017, strict mode enabled
- Path alias: `@/*` maps to `./src/*`
- JSX: `react-jsx`

### next.config.ts

- `output: "standalone"` for Docker-optimized builds

### vitest.config.ts

- Environment: `node` (with JSDOM for component tests)
- Globals enabled
- Path aliases matching tsconfig

---

## 4. Docker Setup

### docker-compose.yml - Three Services

**Service: `postgres`**
- Image: `postgres:16-alpine`
- User/database: `tac` / `tacbookings`
- Password from `${DB_PASSWORD:-password}` env var
- Health check: `pg_isready` every 10s
- Volume: `postgres_data` (persistent)
- No exposed ports (internal Docker network only)

**Service: `app`**
- Built from `Dockerfile` (multi-stage)
- Depends on: `postgres` (healthy)
- Health check: `wget` on port 3000 every 30s
- All env vars passed via `environment:` block
- No exposed ports (accessed through Caddy only)

**Service: `caddy`**
- Image: `caddy:2-alpine`
- Ports: `80:80`, `443:443`
- Depends on: `app` (healthy)
- Volumes: `caddy_data` (certs), `caddy_config`
- Caddyfile mounted from project root

### Dockerfile - Multi-Stage Build

| Stage | Base | Purpose |
|---|---|---|
| `deps` | node:20-alpine | Install npm dependencies, generate Prisma client |
| `builder` | node:20-alpine | Build Next.js application |
| `runner` | node:20-alpine | Production image with standalone output |

- Final image runs as non-root user (`nextjs`)
- Exposes port 3000
- Copies standalone build, static assets, and Prisma client

### Caddyfile

```
{$DOMAIN} {
    reverse_proxy app:3000
}
```

Caddy automatically provisions and renews TLS certificates via Let's Encrypt for the configured domain.

---

## 5. Third-Party Integrations

### Stripe (Payments)

- **SDK:** `stripe` 22.0.0 (server), `@stripe/stripe-js` 9.0.1 + `@stripe/react-stripe-js` 6.1.0 (client)
- **PaymentIntents** for confirmed bookings (immediate charge)
- **SetupIntents** for pending bookings (save card, charge later)
- **Webhooks** at `/api/webhooks/stripe/` with signature verification and idempotency tracking (`ProcessedWebhookEvent` model)
- Server-side price calculation; client cannot manipulate amounts

### Xero (Accounting)

- **SDK:** `xero-node` 15.0.0
- **OAuth2 flow** via admin panel (`/admin/xero`)
- **Token storage:** AES-256-GCM encrypted in database (`XeroToken` model), auto-refresh before 30-min expiry
- **Invoices:** Created on booking confirmation with per-guest line items; credit notes on refunds
- **Contacts:** Bidirectional sync, find-or-create on invoice creation
- **Membership verification:** Checks Xero invoices for subscription payments, updates `MemberSubscription` status
- **Webhooks** at `/api/webhooks/xero/` with HMAC-SHA256 signature verification (timing-safe)
- **Daily cron** refreshes membership status for all active members

### AWS SES (Email)

- **Transport:** nodemailer SMTP to SES endpoint
- **Templates:** 7 branded HTML email templates in `src/lib/email-templates.ts` (welcome, password reset, booking confirmed/pending/bumped/cancelled, chore roster)
- **HTML injection protection:** `escapeHtml()` applied to all user-provided values

### node-cron (Scheduling)

- Registered via Next.js `instrumentation.ts` hook (server-side only)
- **Three scheduled jobs:**
  - Every 3 hours: Auto-confirm pending bookings past hold deadline
  - Daily 2 AM: Xero membership status refresh
  - Configurable (default 3 AM): Database backup (pg_dump + optional S3)
- All jobs have overlap guards to prevent concurrent execution

---

## 6. Database Schema Summary

16 Prisma models, 9 enums. Key models:

| Model | Purpose |
|---|---|
| `Member` | Users (MEMBER/ADMIN roles, age tiers, Xero contact link) |
| `MemberSubscription` | Annual season subscription status from Xero |
| `Season` / `SeasonRate` | Seasonal periods with per-tier pricing |
| `Booking` / `BookingGuest` | Reservations and individual guests |
| `Payment` | Stripe payment records with Xero invoice reference |
| `PromoCode` / `PromoRedemption` | Discount codes and usage tracking |
| `ChoreTemplate` / `ChoreAssignment` | Chore definitions and daily roster |
| `CancellationPolicy` | Configurable refund tiers |
| `XeroToken` | Encrypted OAuth2 tokens |
| `ProcessedWebhookEvent` | Webhook idempotency |
| `AuditLog` | Sensitive action audit trail |
| `PasswordResetToken` | Single-use password reset tokens (1-hour expiry) |

All prices stored as integer cents. Primary keys use `cuid()`. Season year runs April-March.
