# Privacy incidents

Audience: Operator

## What it is

The club's procedure for suspected loss, disclosure or unauthorised access to
members' personal information. Start with **Admin → Monitoring & Support → Audit
Log** (`/admin/audit-log`) for recorded activity. There is no incident-management
screen: keep the incident record privately, with access limited to the response
team. This text-only guide joins the existing controls and runbooks.

## When you'd use it

- An officer account or server may have been compromised.
- A database backup, member export, email or shared link reached the wrong people.
- A member or provider reports that personal information has been exposed.

## Step-by-step

### First hour

1. **Contain.** Name an incident lead and involve the club's Privacy Officer and
   server operator. From a trusted device, stop the suspected access: switch off
   the affected account's login, restrict an exposed backup bucket, or have the
   operator isolate a compromised server. Use the containment levers below.
   Record what you changed and when; stop ongoing disclosure without waiting
   for a complete investigation.
2. **Preserve evidence.** Keep the report, discovery time, affected addresses or
   object keys, account IDs, request IDs and relevant logs before they rotate.
   Preserve originals in restricted storage, record who collected each item and
   its source/time zone, and work from copies. Do not put personal data, tokens,
   dumps or keys into this public repository or a public issue.
3. **Assess harm.** Establish what information was involved, whose it was,
   when exposure began and ended, who could obtain it, and whether they likely
   did. Treat birth dates, contact details, family/guest and stay history,
   dietary/allergy information, identity documents in free text and financial
   references with particular care. Use the [personal-data retention
   schedule](../PRIVACY_RETENTION.md) to identify records and the [recipient
   register](../PRIVACY_RECIPIENTS.md) to trace outside copies. A whole database
   backup includes password hashes and encrypted integration credentials too;
   possession of its encryption key changes the risk substantially.
4. **Decide whether to notify.** The Privacy Officer assesses whether the breach
   has caused, or is likely to cause, serious harm. Record the facts, uncertainty,
   decision-maker and reasons, including a decision that notification is not
   required. Use the Commissioner's guidance below; do not wait for proof of
   misuse before making this assessment.
5. **Notify.** If serious harm has occurred or is likely, notify the Privacy
   Commissioner and affected people as soon as practicable. Use the notification
   tool below and a trusted communication channel. Give the known facts now and
   update them as the investigation develops; ask the Commissioner about any
   proposed exception or delay in telling individuals.
6. **Record.** Keep a private timeline of discovery, exposure, containment,
   evidence, harm assessment, notifications and next actions, with an owner and
   review time for each. Record the Commissioner's reference and copies of
   notices. Continue reassessing as new facts arrive.

### Containment levers

**An affected account.** Open [Members](members.md), the member's detail, then
**Account & Access**, and switch off **Can Login**. The app checks this on
session refresh; switching it off records a revocation time, so switching it
back on does not revive sessions issued before that time. Changing a password
also revokes older sessions; merely sending a reset email does not. Check the
account's access roles and linked sign-in methods before restoring access.
These checks cannot recall information already downloaded or cancel a request
that has already passed its permission check. The [session security
rule](../../src/lib/session-member-security.ts) documents the enforcement.

**Everyone's sessions.** The deployment operator can rotate `AUTH_SECRET`
(or the legacy `NEXTAUTH_SECRET`) and redeploy **every web slot and the cron
leader** following the [auth-secret rotation
runbook](../../DEPLOYMENT.md#auth-secret-rotation-runbook). Cookies signed with
the previous secret stop working where the new secret is running. There is no
separate **sign everyone out** button. Do not use this as a casual logout:
without completing the data-key preparation below, it can strand credentials
and two-factor enrolments. It also invalidates links signed with that secret,
but does **not** revoke every bearer link: password-reset, verification, chore
and nomination links use unkeyed hashes ([token storage](../TOKEN_HASHING.md)).

**An integration or exposed backup.** Switch off the affected capability on
[Modules](modules.md) or its specific sharing controls, using the
[recipient register](../PRIVACY_RECIPIENTS.md) for each flow's actual gate.
This limits future app activity; it does not revoke a stolen provider key,
withdraw already sent data, or guarantee cancellation of work already running.
Revoke keys at the provider as well. For a backup leak, remove public access
and compromised identities at the storage provider immediately, preserving
access evidence first where possible. Turning off nightly backups does not
make existing objects private or remove them. Neither the backup upload nor
this product guarantees backup encryption: verify the bucket's encryption,
access policy and logging with the storage operator ([Backups](backups.md)).

**A compromised server.** Have the hosting operator restrict network access and
stop compromised app and scheduler processes as needed, preserving evidence.
Admin module switches are not server isolation. Treat every secret readable
by that host as exposed, including deployment credentials, email credentials
and diagnostic database access. Arrange recovery on a trusted host before
entering replacement secrets; an attacker retaining access can steal them again.

### Replace compromised credentials in order

The deployment operator carries out these operations. This is an ordering and
impact checklist; follow the linked runbooks for commands and verification.
Do not postpone urgent revocation of an actively abused credential to finish
preparation: isolate access and record the resulting outage.

1. **Establish trusted access and secure the database.** Rotate database passwords
   for every configured role: operator/superuser, application, migration, audit
   retention, AI Diagnostics and any backup restore-validation database. For
   split roles, follow [Least-privilege database
   roles](../../DEPLOYMENT.md#least-privilege-database-roles): update deployment
   values, apply the role passwords, then deploy promptly. Existing connections
   remain open; a password change alone does not evict an attacker's connection.
   Have the database operator isolate/terminate unauthorised connections.
   Diagnostics has its own [password rotation
   procedure](../ai-diagnostics/deployment.md#rotating-the-password); its URL and
   app containers must be updated too. Wrong or mismatched passwords interrupt
   app access, migrations, retention, diagnostics or restore checks.
2. **Prepare and rotate `DATA_ENCRYPTION_KEYS` before routine auth rotation.**
   Follow [Adding a data-encryption
   key](../../DEPLOYMENT.md#adding-a-data-encryption-key-4456), including the
   two redeploys for an existing ring: distribute the new key as a reader first,
   then promote it for writes, then move stored data and finally remove the old
   key. Verify the running app's fingerprint and remaining-key counts as the
   runbook requires. With no ring, encryption falls back to `AUTH_SECRET`:
   replacing that secret first makes legacy credentials and authenticator
   secrets unreadable. Removing a ring key prematurely has the same effect on
   its rows. Setting a ring invalidates legacy recovery codes; removing an old
   key retires recovery codes issued under it. Follow the runbook's explicit
   legacy-code retirement and member instructions; unsetting the ring can
   otherwise make previously refused legacy codes work again.
3. **Rotate `AUTH_SECRET` and retire legacy decryption.** Once Setup's **Data
   Encryption Key** check is green, follow the [auth-secret rotation
   runbook](../../DEPLOYMENT.md#auth-secret-rotation-runbook) and [legacy-key
   retirement](../../DEPLOYMENT.md#retiring-the-legacy-key-4456). If preparation
   is impossible, use that runbook's maintenance/break-glass path and plan
   credential re-entry and two-factor re-enrolment. Rotating keys cannot make a
   stolen backup or already stolen authenticator secret unreadable to someone
   holding the old key. Assess enrolments as compromised where appropriate;
   rewrapping the same secret does not replace it.
4. **Replace every affected provider credential.** After server/database
   compromise, review all nine store namespaces below, including unused but
   still valid keys. Revoke compromised credentials at their issuer, save fresh
   values on the trusted deployment, then verify each connection before
   resuming it. Follow [provider credential re-entry](../../DEPLOYMENT.md#provider-credentials-db-only-upgrade--auth-secret-rotation-2079)
   and the specific guides. Allow for other processes' credential caches
   (typically 30–60 seconds); provider revocation is the control for a stolen key.

| Credential namespace | Replacement order and side effect |
| --- | --- |
| `stripe` | Replace API keys and the endpoint signing secret with matching issuer/app values; verify the connection and webhook in the [Stripe re-entry runbook](../../DEPLOYMENT.md#upgrade-db-only-provider-credentials). Payments and reconciliation can pause; replacing a key clears webhook verification. Reconcile deliveries during the gap. |
| `xero` | Replace the app client secret and webhook key through [Xero setup](xero.md#set-up-mappings-and-import-xero-setup), then reconnect. Credential writes reset the connection; invoice/sync automation pauses. |
| `xero-oauth` | Revoke the compromised connection/token set at Xero, then complete OAuth again using the replacement `xero` configuration ([reconnection runbook](../../DEPLOYMENT.md#upgrade-db-only-provider-credentials)). Fresh tokens are created by Connect; there is no token-paste form. |
| `google` | Replace the OAuth client secret in [Google sign-in setup](security.md), then re-verify before enabling. A credential change locks the enable toggle until verification passes; existing app sessions require the separate containment above. |
| `backup` | Revoke the exposed S3 access key, enter its replacement and any affected shadow-database URL in [Backups](backups.md#configure-the-destination-and-credentials-full-admin), then verify. Uploads or restore validation fail until access works; existing objects remain. |
| `anthropic` | Revoke the AI help key at its issuer, then paste a replacement under [AI Help](ai-help.md#1-enter-the-anthropic-api-key-full-admin). Help is unavailable while disabled or without a readable key. |
| `anthropic-diagnostics` | Replace the separate Diagnostics key through its [setup procedure](../ai-diagnostics/deployment.md#setup-order); also rotate its database password in step 1. Diagnostics requires its own key and verified read-only role before it can resume. |
| `mirotalk` | Replace the host username/password and signing key on the meeting server and in the app together, following [video-meeting setup](calendar.md#video-meetings-mirotalk). Mismatched keys reject joins; old signed join links fail with the new signing key. This does not promise to disconnect an ongoing meeting. |
| `servernz` | Revoke the old API key with the central-server operator, save its replacement, then check push registration and sync following [central-server setup](integrations.md#connect-to-the-alpine-central-server). Replacing the key clears the push secret; cached old push credentials stop being accepted within 45 seconds. |

Finally replace exposed email-service credentials (`AWS_SES_ACCESS_KEY_ID` /
`AWS_SES_SECRET_ACCESS_KEY`, or `EMAIL_SERVER_USER` / `EMAIL_SERVER_PASSWORD`)
at the issuer and in deployment configuration, then redeploy and verify delivery
([email configuration](../../CONFIGURATION.md#email-delivery)). Email is
outside the credential store. Failed delivery affects resets, sign-in codes and
incident notices; use a separate trusted channel while it is unavailable.

### Where the evidence is

- [Audit Log](audit-log.md): actor/subject, action, outcome, timestamp, request
  ID, IP and details where recorded. Filter security, privacy and admin activity
  and changes to credentials, roles and member records. It is not a complete
  log of every read or proof that no information was taken.
- Server/application logs and reverse-proxy request logs: ask the hosting
  operator to preserve the relevant period, deployment history and host access
  logs. Availability depends on the deployment; [access-log
  guidance](../../DEPLOYMENT.md#access-logs) explains URL redaction and rotation.
- [Backup history](backups.md) and storage-provider logs: preserve object names,
  creation/access times, policy changes and evidence of downloads where logging
  existed. A successful backup run does not prove the destination was private.

Normal deletion still matters during an investigation. Review the
[retention schedule](../PRIVACY_RETENTION.md) and [audit archive
runbook](../AUDIT_RETENTION_ARCHIVE_RUNBOOK.md) promptly with the operator to
preserve relevant copies before expiry. The app's automatic incident-preserved
flag covers particular system events; the Audit Log has no general **hold this
incident** button. Keep any necessary evidence outside routine cleanup in
restricted storage, with a documented purpose, review date and disposal plan.
Do not indefinitely retain unrelated member data or restore over the live
database as an evidence-gathering shortcut.

### Notifying

Under Part 6 of New Zealand's Privacy Act 2020, a breach that has caused or is
likely to cause serious harm must be notified to the Privacy Commissioner and
affected individuals as soon as practicable. The club owns this assessment;
the application neither decides notifiability nor sends breach notices.

Use the Commissioner's [privacy-breach guidance](https://www.privacy.org.nz/responsibilities/privacy-breaches/)
and [NotifyUs assessment and notification tool](https://www.privacy.org.nz/responsibilities/privacy-breaches/notify-us/).
Consider sensitivity, possible harm, who obtained the information, protections
such as encryption, and steps taken to reduce harm. A protected dump is not
automatically harmless when its key was stolen too. This guide supports the
club's response; use the Commissioner's guidance for the legal assessment.

Tell affected people what happened, which of their information was involved,
what the club has done, what they can do now, and how to contact the Privacy
Officer. Avoid exposing other people's information in the notice. Keep the
initial notice and subsequent corrections in the incident record.

### After the incident

Confirm that access is contained and affected integrations are verified before
restoring service. Reconcile interrupted payments, provider deliveries and
backups through their existing operator queues. Review officer access and
[two-factor sign-in](security.md), patch the entry point, and test the recovery
using synthetic data. Record the root cause, completed fixes and named owners
for further work in the private incident record.

Keep the public disclosure accurate. Open **Admin → Setup & Configuration →
Site Appearance & Content → Club Identity**
(`/admin/appearance/identity`), section **Where members' data is held**.
With content edit access, set **Hosting provider** and **Where your data is
held**, naming both locations if database and backups differ; keep them current
when hosting changes. These are public plain-text disclosures, never credentials.
The optional `{{data-hosting}}` page-body token uses these settings; blanks use
role-only fallback wording. Review your club's actual privacy page against the
[recipient register](../PRIVACY_RECIPIENTS.md), including optional features.
The starter privacy policy's section 5 lists the register's member-facing
services and names the host through the token; an unedited privacy page is moved
to it by a one-off migration, and an edited one is left for you to check
([upgrade note](../UPGRADING.md#starter-privacy-policy-lists-its-recipients-and-names-your-host-5007)).
The [#4918 note](../UPGRADING.md#privacy-incident-guide-and-hosting-disclosure-settings-4918)
explains the rollback limit.

## Related links

- Back to the [documentation hub](../README.md) and [operator index](../adopters/README.md).
- Sibling guides: [Login & Security](security.md), [Backups](backups.md),
  [Audit Log](audit-log.md), [Page Content](page-content.md).
- Reference: [Recipient register](../PRIVACY_RECIPIENTS.md),
  [personal-data retention](../PRIVACY_RETENTION.md),
  [deployment runbooks](../../DEPLOYMENT.md).
- For a product vulnerability, use the private [security disclosure route](../../SECURITY.md).
