# TACBookings - AWS Lightsail Deployment Guide

Deploy TACBookings to an AWS Lightsail instance with live Stripe, Xero, and email integrations, accessible via HTTPS.

**Estimated time:** ~1 hour (plus DNS propagation)

---

## Prerequisites Checklist

Before starting, ensure you have:

- [ ] AWS Lightsail instance (2GB+ RAM, Ubuntu 24.04)
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

# Build and start all 3 services (first build takes 3-5 minutes)
docker compose up -d --build

# Watch logs to verify everything starts cleanly
docker compose logs -f
# Press Ctrl+C to stop watching (services keep running)
```

Verify all services are healthy:

```bash
docker compose ps
```

You should see `postgres`, `app`, and `caddy` all showing "healthy" or "running".

**If the app container fails to start**, check logs:

```bash
docker compose logs app
```

Common causes: missing `.env` values, or `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` not set at build time (it's baked into the client bundle). If you need to fix env vars, edit `.env` and rebuild:

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

For future schema changes, use migrations instead:

```bash
docker compose exec app npx prisma migrate deploy
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

```bash
cd ~/TACBookings
git pull origin main
docker compose up -d --build
# If the Prisma schema changed:
docker compose exec app npx prisma migrate deploy
```

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
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` must be set before build (it's baked into client JS)

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
- App scopes must include: `openid profile email accounting.transactions accounting.contacts offline_access`
- Check app logs: `docker compose logs app | grep -i xero`

### Database issues
- Connect directly: `docker compose exec postgres psql -U tac tacbookings`
- Reset and re-seed (destroys all data): `docker compose exec app npx prisma db push --force-reset && docker compose exec app npx tsx prisma/seed.ts`
- Check if migrations are pending: `docker compose exec app npx prisma migrate status`

### Out of disk space
- Check usage: `df -h`
- Clean old Docker images: `docker system prune -a`
- Check backup files: `ls -lah /tmp/tacbookings-backups/`

### Out of memory (2GB instance)
- Check usage: `free -m` and `docker stats`
- Consider upgrading to 4GB Lightsail instance ($20/mo)
- Restart to reclaim memory: `docker compose restart`
