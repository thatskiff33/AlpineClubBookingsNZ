# TACBookings - AWS Lightsail Deployment Guide

Deploy TACBookings to an AWS Lightsail instance with live Stripe, Xero, and email integrations, accessible via HTTPS.

**Estimated time:** ~1 hour (plus DNS propagation)

---

## Prerequisites Checklist

Before starting, ensure you have:

- [ ] AWS Lightsail instance (4 GB RAM, 2 vCPUs, 80 GB SSD, Ubuntu 24.04)
- [ ] Domain name with DNS access
- [ ] Stripe account with live API keys
- [ ] Xero developer app with client ID and secret
- [ ] AWS account (for SES email and S3 backups)

---

## Step 1: Set Up AWS SES (Email)

SES sends booking confirmations, password resets, and notifications.

1. **Go to AWS Console > SES** (use `ap-southeast-2` region to match Lightsail)

2. **Verify your domain:**
   - SES > Verified identities > Create identity > Domain
   - Enter your domain (e.g. `yourdomain.co.nz`)
   - Add the DNS records SES provides (DKIM CNAME records) to your domain's DNS
   - Wait for verification (usually 5-30 minutes)

3. **Request production access** (if in sandbox):
   - SES > Account dashboard > Request production access
   - Use case: "Transactional emails for a club booking system"
   - While in sandbox you can only send to verified email addresses — fine for initial testing

4. **Create SMTP credentials:**
   - SES > SMTP settings > Create SMTP credentials
   - Save the **SMTP username** → this is your `AWS_SES_ACCESS_KEY_ID`
   - Save the **SMTP password** → this is your `AWS_SES_SECRET_ACCESS_KEY`
   - Note the SMTP endpoint: `email-smtp.ap-southeast-2.amazonaws.com`

---

## Step 2: Create S3 Bucket for Database Backups

1. **AWS Console > S3 > Create bucket**
   - Name: `tacbookings-backups` (or similar, must be globally unique)
   - Region: `ap-southeast-2`
   - Block all public access: **Yes**
   - Versioning: optional but recommended

2. **Create an IAM user for backup uploads:**
   - IAM > Users > Create user (e.g. `tacbookings-backup`)
   - Attach a custom policy:
     ```json
     {
       "Version": "2012-10-17",
       "Statement": [{
         "Effect": "Allow",
         "Action": ["s3:PutObject"],
         "Resource": "arn:aws:s3:::tacbookings-backups/*"
       }]
     }
     ```
   - Create access key → save the **Access Key ID** and **Secret Access Key**

---

## Step 3: Point Your Domain to Lightsail

1. **Attach a static IP** to your Lightsail instance (Networking tab in Lightsail console) if you haven't already

2. **Add DNS records** at your domain registrar:
   - `A` record → point to `<Lightsail static IP>`
   - If using a subdomain (e.g. `bookings.tac.org.nz`), create the A record for that subdomain

3. **Open firewall ports** in Lightsail:
   - Lightsail > Instance > Networking > IPv4 Firewall
   - Add **TCP 80** (HTTP) and **TCP 443** (HTTPS)
   - Do **NOT** open port 5432 (Postgres) or 3000 (app) — these stay internal to Docker

---

## Step 4: Install Docker on Lightsail

SSH into your instance:

```bash
ssh ubuntu@<your-lightsail-ip>
```

Install Docker and Docker Compose:

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com | sudo sh

# Add your user to docker group (avoids needing sudo)
sudo usermod -aG docker ubuntu

# Log out and back in for group change to take effect
exit
```

SSH back in, then verify:

```bash
ssh ubuntu@<your-lightsail-ip>
docker --version
docker compose version
```

Install AWS CLI (needed for S3 backups):

```bash
sudo apt install -y awscli
```

---

## Step 5: Clone the Repository

```bash
cd ~
git clone https://github.com/thatskiff33/tacbookings.git TACBookings
cd TACBookings
```

---

## Step 6: Generate Secrets and Create .env

Generate all the secrets you need. Run each command and save the output:

```bash
# NEXTAUTH_SECRET (64 random chars)
openssl rand -base64 48

# CRON_SECRET (32 random chars)
openssl rand -base64 24

# DB_PASSWORD (strong random password)
openssl rand -base64 24

# XERO_ENCRYPTION_KEY (64-char hex string, 32 bytes)
# Requires Node.js — if not installed on host, skip and generate after Docker is running
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Create the `.env` file in the project root:

```bash
nano ~/TACBookings/.env
```

Paste and fill in **every** placeholder:

```env
# Database
DB_PASSWORD=<generated-db-password>

# NextAuth
NEXTAUTH_URL=https://yourdomain.co.nz
NEXTAUTH_SECRET=<generated-nextauth-secret>

# Stripe (use LIVE keys for production)
STRIPE_SECRET_KEY=sk_live_...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_...
STRIPE_WEBHOOK_SECRET=whsec_placeholder   # Updated in Step 10

# Addressfinder.nz (browser autocomplete)
NEXT_PUBLIC_ADDRESSFINDER_KEY=<your-addressfinder-browser-key>

# Xero
XERO_CLIENT_ID=<your-xero-client-id>
XERO_CLIENT_SECRET=<your-xero-client-secret>
XERO_REDIRECT_URI=https://yourdomain.co.nz/api/admin/xero/callback
XERO_ENCRYPTION_KEY=<generated-64-char-hex>
XERO_WEBHOOK_KEY=                          # Updated in Step 11 (optional)

# Email (AWS SES) — from Step 1
SMTP_HOST=email-smtp.ap-southeast-2.amazonaws.com
SMTP_PORT=587
AWS_SES_ACCESS_KEY_ID=<ses-smtp-username>
AWS_SES_SECRET_ACCESS_KEY=<ses-smtp-password>
EMAIL_FROM=bookings@yourdomain.co.nz

# Deployment
DOMAIN=yourdomain.co.nz

# Cron
CRON_SECRET=<generated-cron-secret>

# Database Backups — from Step 2
BACKUP_ENABLED=true
BACKUP_S3_BUCKET=tacbookings-backups
BACKUP_S3_REGION=ap-southeast-2
BACKUP_S3_ACCESS_KEY_ID=<s3-iam-access-key>
BACKUP_S3_SECRET_ACCESS_KEY=<s3-iam-secret-key>
BACKUP_RETENTION_DAYS=7
BACKUP_CRON_SCHEDULE=0 3 * * *
```

> **Important:** Replace every `<...>` with real values. `STRIPE_WEBHOOK_SECRET` and `XERO_WEBHOOK_KEY` are created in later steps — use a placeholder for now.

---

## Step 7: Build and Start the Application

```bash
cd ~/TACBookings

# First-time bootstrap: build and start Postgres, app cron leader, blue/green web slots, and Caddy.
# For routine production updates after bootstrap, use ./scripts/run-production-blue-green-deploy.sh instead.
docker compose up -d --build

# Watch logs to verify everything starts cleanly
docker compose logs -f
# Press Ctrl+C to stop watching (services keep running)
```

Verify all services are healthy:

```bash
docker compose ps
```

You should see `postgres`, `app`, `app_blue`, `app_green`, and `caddy` showing "healthy" or "running". The `app` service is the cron leader and fallback upstream; `app_blue` and `app_green` are web-only blue/green slots with cron disabled.

**If the app container fails to start**, check logs:

```bash
docker compose logs app
```

Common causes: missing `.env` values, or `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` / `NEXT_PUBLIC_ADDRESSFINDER_KEY` not set at build time (public `NEXT_PUBLIC_*` values are baked into the client bundle). If you need to fix env vars, edit `.env` and rebuild:

```bash
docker compose up -d --build
```

---

## Step 8: Run Database Setup and Seed

```bash
# Create all database tables from the Prisma schema
docker compose exec app npx prisma db push

# Seed with initial data (rooms, chore templates, cancellation policies, admin user)
docker compose exec app npx tsx prisma/seed.ts
```

The seed creates a default admin account:

| Field | Value |
|-------|-------|
| Email | `support@tokoroa.org.nz` |
| Password | `admin123` |

> **Change this password immediately** after first login (Step 9).

For future schema changes, use migrations instead. The dedicated `migrate` profile service uses the builder image and should be used when you want migrations isolated from the running app process:

```bash
docker compose exec app npx prisma migrate deploy
docker compose run --rm migrate
```

---

## Step 9: Verify HTTPS and First Login

1. Open `https://yourdomain.co.nz` in your browser
2. Caddy auto-provisions a Let's Encrypt certificate — first request may take 10-30 seconds
3. You should see the login page
4. Log in with `support@tokoroa.org.nz` / `admin123`
5. Go to **Profile** and change the password to something strong (minimum 12 characters)

**If you get a certificate error:**
- Verify DNS is resolving: `dig yourdomain.co.nz` should show your Lightsail IP
- Check Caddy logs: `docker compose logs caddy`
- Ensure ports 80 and 443 are open in Lightsail firewall

---

## Step 10: Configure Stripe Webhook

Stripe needs to notify your app when payments succeed, fail, or are refunded.

1. **Stripe Dashboard > Developers > Webhooks > Add endpoint**
2. Endpoint URL: `https://yourdomain.co.nz/api/webhooks/stripe`
3. Select events:
   - `payment_intent.succeeded`
   - `payment_intent.payment_failed`
   - `charge.refunded`
4. Click **Add endpoint**
5. Copy the **Signing secret** (starts with `whsec_`)
6. Update `.env` on the server:
   ```bash
   nano ~/TACBookings/.env
   # Replace STRIPE_WEBHOOK_SECRET=whsec_placeholder with the real value
   ```
7. Restart to pick up the change:
   ```bash
   cd ~/TACBookings && docker compose up -d
   ```
8. Back in Stripe, click **Send test webhook** to verify the endpoint responds with 200

---

## Step 11: Connect Xero

### 11a. Update Xero App Redirect URI

1. Go to **developer.xero.com > My Apps > your app**
2. Under **OAuth 2.0 redirect URIs**, add exactly:
   ```
   https://yourdomain.co.nz/api/admin/xero/callback
   ```
3. Ensure the app has these scopes: `openid profile email accounting.transactions accounting.contacts offline_access`
4. Save

If you are also using the finance workspace with a separate finance Xero app, that app must use the finance callback path and include the finance reporting scope:

- Redirect URI: `https://yourdomain.co.nz/api/finance/xero/callback`
- Scopes: `openid profile email accounting.contacts accounting.invoices accounting.payments accounting.settings.read accounting.reports.read offline_access`

### 11b. Set Up Xero Webhook (Optional)

Only needed if you want Xero to push updates to your app:

1. In your Xero app settings, add a webhook
2. URL: `https://yourdomain.co.nz/api/webhooks/xero`
3. Copy the **webhook key** Xero provides
4. Update `.env`:
   ```bash
   nano ~/TACBookings/.env
   # Set XERO_WEBHOOK_KEY=<the-key-from-xero>
   ```
5. Restart: `cd ~/TACBookings && docker compose up -d`
6. Xero sends an intent-to-receive validation — the app handles this automatically

### 11c. Connect from Admin Panel

1. Log in as admin at `https://yourdomain.co.nz`
2. Go to **Admin > Xero**
3. Click **"Connect Xero"**
4. Authorize in the Xero popup
5. Once connected, click **"Sync Contacts"** to import existing members
6. Click **"Refresh Memberships"** to check subscription statuses

---

## Step 12: Configure Seasons, Rates, and Cancellation Policy

Before members can book, set up:

1. **Admin > Seasons** — Create your current season(s) with name, type (Winter/Summer), and date range
2. **Set rates for each season** — 6 rate combinations per season:
   - Adult Member, Adult Non-Member
   - Youth Member, Youth Non-Member
   - Child Member, Child Non-Member
3. **Admin > Cancellation Policy** — Configure refund tiers, e.g.:
   - 14+ days before stay: 100% refund
   - 7-14 days: 50% refund
   - Less than 7 days: 0% refund

---

## Step 13: Create Member Accounts

Options for getting members into the system:

- **Self-registration:** Members sign up at `https://yourdomain.co.nz/register`
- **Xero sync:** After connecting Xero (Step 11), contacts are imported — but members still need to register for a login
- **Bulk import:** A future enhancement — import from Checkfront/Xero data exports

---

## Ongoing Operations

### Deploying Updates

Use the single supported production deploy entrypoint:

```bash
cd ~/TACBookings
./scripts/run-production-blue-green-deploy.sh
```

The wrapper fetches `origin/main`, deploys that exact commit from a clean workspace under `~/tacbookings-deployments/`, keeps the existing slot live until the new slot and cron leader pass readiness, fast-forwards `~/TACBookings` to the deployed commit when that checkout is clean on `main`, removes stale inactive web-slot containers, removes orphaned Compose containers, and prunes old deploy workspaces after success.

### Blue/Green Deployment Guidance

With the current production host size of 4 GB RAM, 2 vCPUs, and 80 GB SSD, same-host blue/green is implemented for the web tier.

Run it with:

```bash
cd ~/TACBookings
./scripts/run-production-blue-green-deploy.sh
```

What the script does:

1. Fetch `origin/main` by default and resolve the exact commit that will be deployed.
2. Archive that commit into a clean workspace under `~/tacbookings-deployments/` and copy in the local production `.env`.
3. Reconstruct the live `deploy/caddy/tacbookings-active.caddy` state from the running Caddy bind mount, Caddy autosave config, or the currently running color service.
4. Run the low-level `scripts/blue-green-deploy.sh` script from that clean workspace with the stable `tacbookings` Docker Compose project name.
5. Build the new image while the current app stays live.
6. Start the inactive color service (`app_blue` or `app_green`) alongside the live one.
7. Verify the target color with `/api/health/ready` before any traffic switch.
8. Recreate `app` on the new release and verify cron registration before any traffic switch.
9. Point Caddy at the target color as the primary upstream with `app` as the automatic fallback upstream.
10. Verify the public domain still resolves to the target color, not just the fallback.
11. Wait a short drain period so in-flight requests on the previous color can finish.
12. Remove inactive web-slot containers so only the target color remains after a successful cutover.
13. Remove orphaned Compose containers from older service definitions.
14. Fast-forward `~/TACBookings` to the deployed commit when that checkout is clean on `main`.
15. Prune stale deploy workspaces under `~/tacbookings-deployments/` after Caddy is confirmed to be bind-mounting the new workspace.

Current constraints and rules:

- `app` remains the cron leader and the Caddy fallback upstream after a successful blue/green deploy.
- `app_blue` and `app_green` are web-only services with cron disabled.
- Caddy switches traffic by reloading a managed upstream file under `deploy/caddy/`.
- The repo-standard wrapper requires a clean `~/TACBookings` checkout on `main`, keeps the live Caddy bind mounts out of `/tmp`, and seeds the managed upstream file from live state before each deploy so the low-level script does not guess the active color from a fresh checkout.
- Caddy no longer depends on `app` health to start. Live traffic is modeled as `active color -> app fallback`.
- `/api/health` stays public and DB-only. Blue/green health gates and container health checks use `/api/health/ready`, which also verifies runtime config and confirms whether the instance is a web slot or the cron leader.
- The blue/green script waits `BLUE_GREEN_DRAIN_SECONDS` before it restarts or stops the previous service so in-flight requests can complete.
- After a successful cutover, the non-target web-slot containers are removed so old code cannot keep running outside the active slot.
- After a successful cutover, the wrapper fast-forwards the clean `~/TACBookings` checkout to the deployed commit and removes stale deploy workspaces that are no longer mounted by Caddy.
- Postgres remains a shared dependency, not a blue/green service on this host.
- The blue/green script scans pending Prisma migrations and blocks obviously breaking SQL unless both `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1` and `BLUE_GREEN_MIGRATION_OVERRIDE_REASON="..."` are set deliberately.
- The Prisma migration scan is heuristic only. A pass means "no obvious breaking SQL was detected", not "old and new code are definitely compatible".
- Prisma migrations must be backward-compatible across the cutover. Use expand-contract schema changes so old and new app versions can overlap safely.

### Cutover Safety And Recovery Model

- If the target color fails readiness, deploy stops before any traffic switch.
- If the refreshed `app` cron leader fails readiness or cron registration, deploy stops before any traffic switch and the existing live color stays in service.
- If cutover begins but the public domain resolves to the fallback `app` instead of the target color, the deploy is treated as failed and the script restores the previous primary color automatically.
- After a successful cutover, Caddy can fail over from the active color to `app` if the color container dies or stops passing readiness checks. Treat that as degraded mode and repair or redeploy the color service promptly.

### Database Continuity During Blue/Green

There is only one live PostgreSQL database. Blue/green switches the web application tier, not the database tier, so there is no replication lag or data copy step during cutover. Both the old and new app versions talk to the same Postgres instance before, during, and after the switch.

If someone is booking during cutover:

1. Existing requests keep writing to the shared Postgres database.
2. New requests are routed to the new color only after the target app and refreshed cron leader both pass readiness checks.
3. The previous service is left running for a short drain window before it is restarted or stopped.

For booking consistency specifically, the write paths already serialize booking creation and key booking transitions inside database transactions with PostgreSQL advisory locks. See `src/app/api/bookings/route.ts` and `src/app/api/bookings/[id]/confirm-draft/route.ts`.

### Prisma Migration Rules For Blue/Green

Do not ship a breaking Prisma migration in the same deploy where old and new app versions overlap.

Safe pattern:

1. Add new tables, columns, indexes, or nullable fields.
2. Deploy code that can work with both old and new schema shapes.
3. Backfill data if needed.
4. Switch reads and writes fully to the new shape.
5. Remove old columns or constraints in a later deploy after all live instances are on the new code.

Treat these as breaking unless you explicitly review and override them:

- `DROP TABLE`
- `DROP COLUMN`
- `DROP TYPE`
- `DROP CONSTRAINT`
- column renames
- table renames
- column type changes
- `SET NOT NULL` on an existing column without a prior compatible rollout

If you must override the guard, the deploy command must be intentionally noisy:

```bash
ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1 \
BLUE_GREEN_MIGRATION_OVERRIDE_REASON="explain the reviewed expand/contract plan" \
./scripts/run-production-blue-green-deploy.sh
```

That override only bypasses the regex guard. It does not prove compatibility, and it should not be used instead of a staged expand-contract rollout.

If the app images are already present on the host and you intentionally want to reuse them without rebuilding:

```bash
SKIP_APP_IMAGE_BUILD=1 ./scripts/run-production-blue-green-deploy.sh
```

That flag is handled by the low-level `scripts/blue-green-deploy.sh` runner and fails fast if the expected `app`, target color, or `migrate` images are missing.

### Viewing Logs

```bash
docker compose logs -f          # All services
docker compose logs -f app      # Just the app
docker compose logs --tail 100 app  # Last 100 lines
```

### Manual Database Backup

Automated backups run daily at 3 AM. For a manual backup:

```bash
docker compose exec postgres pg_dump -U tac tacbookings | gzip > ~/backup-$(date +%Y%m%d).sql.gz
```

### Restoring a Backup

```bash
gunzip -c backup-20260403.sql.gz | docker compose exec -T postgres psql -U tac tacbookings
```

### Restarting Services

```bash
docker compose restart           # Restart all
docker compose up -d             # Restart with env changes (no rebuild)
docker compose up -d --build     # Full rebuild (after code changes)
```

### Monitoring

```bash
docker compose ps        # Service health
docker stats             # Container CPU/memory usage
df -h                    # Disk space
free -m                  # Memory
```

---

## Quick Reference: Time Estimates

| Step | What | Time |
|------|------|------|
| 1 | Set up AWS SES | 15-30 min (DNS verification) |
| 2 | Create S3 backup bucket + IAM user | 10 min |
| 3 | Point domain DNS + open firewall | 5 min + propagation |
| 4 | Install Docker on Lightsail | 5 min |
| 5 | Clone the repo | 1 min |
| 6 | Generate secrets + create .env | 10 min |
| 7 | Build and start (`docker compose up`) | 5 min |
| 8 | Database setup + seed | 2 min |
| 9 | Verify HTTPS + change admin password | 2 min |
| 10 | Configure Stripe webhook | 5 min |
| 11 | Connect Xero | 5 min |
| 12 | Configure seasons, rates, policy | 10 min |
| 13 | Create member accounts | Varies |

---

## Troubleshooting

### Caddy won't get a certificate
- Ports 80 and 443 must be open in Lightsail firewall
- DNS must resolve to the correct IP: `dig yourdomain.co.nz`
- Check Caddy logs: `docker compose logs caddy`
- Ensure no other process is using port 80/443

### App won't start
- Check logs: `docker compose logs app`
- Verify all required `.env` values are set
- Ensure postgres is healthy: `docker compose ps`
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` and `NEXT_PUBLIC_ADDRESSFINDER_KEY` must be set before build (they are baked into client JS)

### Emails not sending
- Check SES sandbox status — sandbox can only send to verified addresses
- Verify SMTP credentials in `.env`
- Check app logs for email errors: `docker compose logs app | grep -i email`

### Stripe payments failing
- Confirm you're using live keys (not `sk_test_` / `pk_test_`)
- Verify webhook signing secret matches Stripe dashboard
- Check webhook logs: Stripe Dashboard > Developers > Webhooks > select endpoint

### Xero connection failing
- Redirect URI must match **exactly**: `https://yourdomain.co.nz/api/admin/xero/callback`
- Operational app scopes must include: `openid profile email accounting.transactions accounting.contacts offline_access`
- Finance app scopes must include: `openid profile email accounting.contacts accounting.invoices accounting.payments accounting.settings.read accounting.reports.read offline_access`
- Check app logs: `docker compose logs app | grep -i xero`

### Database issues
- Connect directly: `docker compose exec postgres psql -U tac tacbookings`
- Reset and re-seed (destroys all data): `docker compose exec app npx prisma db push --force-reset && docker compose exec app npx tsx prisma/seed.ts`
- Check if migrations are pending: `docker compose exec app npx prisma migrate status`

### Out of disk space
- Check usage: `df -h`
- Clean old Docker images: `docker system prune -a`
- Check backup files: `ls -lah /tmp/tacbookings-backups/`

### Out of memory
- Check usage: `free -m` and `docker stats`
- Current production host is 4 GB RAM, 2 vCPUs, 80 GB SSD. If memory pressure persists, review container limits and host usage before scaling further.
- Restart to reclaim memory: `docker compose restart`
