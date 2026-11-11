# Login & Security

Audience: Operator

## What it is

The club-wide controls for how members and admins sign in and how strong their
passwords must be: a **password policy** card, an **email sign-in link**
(magic-link) card, and a **Google sign-in** card. Find it at **Admin → Setup &
Configuration → Login & Security** (`/admin/security`).

The page sits under the **support** ("Support & System") permission area. The
sign-in method cards are tied to their modules — the magic-link and Google cards
configure the `magicLink` and `googleLogin` modules you enable on
[Modules](modules.md). See [`SECURITY.md`](../SECURITY.md) and the
[disclosure policy](../../SECURITY.md) for the wider security posture.

When officer sign-in is switched on (#4620), the same page also has an
**Officer two-factor** card. A Full Admin can require an authenticator app or a
passkey for Full Admins and for officers whose role can edit Finance or
Support & System, and can set a grace period of 0 to 60 days (14 by default).
Anyone else who can open the page sees that card but cannot change it. The
same Full Admin sees who has not set one up yet. Resetting a lost factor is a
button on the other person's account, after the Full Admin has confirmed it is
them. It emails that person and ends their sessions. A club with one Full
Admin uses `pnpm run auth:reset-factors -- --member <email>` instead.

## When you'd use it

- You want to raise password strength requirements for the whole club.
- You're rolling out passwordless email sign-in links and need to set (or check)
  their expiry.
- You're enabling Google sign-in and want to confirm the server credentials are
  in place before members see the button.

## Step-by-step

### Set the password policy and sign-in options

1. Go to **Admin → Setup & Configuration → Login & Security**.

   ![Login & Security page with the password policy card, the email sign-in link card, and the Google sign-in card](../images/admin/admin-security.png)

   Each of the three cards opens read-only. To change anything, use the card's
   **Edit** button, make your changes, then **Save** (or **Cancel** to discard
   them) — nothing is applied until you save. If your admin role can view but not
   change these settings, the Edit button is disabled and a short "view only"
   note appears.

2. In **Password policy**, click **Edit**, set the strength requirements that
   apply to every member and admin password, then **Save**. **Refuse passwords
   found in public data breaches** (on by default) checks each newly chosen
   password against a public list of leaked passwords; only the first five
   characters of a one-way code made from the password are sent, and if the
   service does not answer within three seconds the password is accepted.
   **Sign members out after (hours)** sets how long anyone stays signed in,
   counted from when they signed in, however much they use the site: a whole
   number of hours from 8 to 720 (30 days), default 168 (7 days). A change
   applies to people already signed in, on their next page load. The lodge
   kiosk account keeps its own 30 days.
3. In **Email sign-in link**, click **Edit**, confirm the enable toggle is on,
   set the link's expiry (a whole number of minutes between 5 and 60; default
   15), then **Save**. For **Google sign-in**, first set up and verify the
   credentials in-app at **Admin → Integrations → Google sign-in** (no env vars);
   the enable toggle on this card stays locked until a real Google OAuth round-trip
   verifies. Once verified, click **Edit**, turn it on, then **Save**.

## Settings reference

| Setting | What it controls | Notes / constraints |
| --- | --- | --- |
| Password policy | Minimum strength requirements for all passwords | Applies club-wide, across members and admins |
| Refuse passwords found in public data breaches | Whether a newly chosen password is checked against a public breach list | Default on; applies when a password is set, never at login; needs outbound HTTPS to `api.pwnedpasswords.com` ([details](../SECURITY.md#breached-password-check-4610)) |
| Sign members out after (hours) | The most time a signed-in session lasts from sign-in, however active | Default 168 hours (7 days), 8 to 720; nothing extends it; the lodge kiosk keeps its own 30 days ([details](../SECURITY.md#maximum-session-age-4611)) |
| Email sign-in link (magic link) | Passwordless single-use email sign-in | Requires the `magicLink` module and configured transactional email; additive to password login, never a replacement, for existing verified members only |
| Magic-link expiry | How long a sign-in link stays valid | Default 15 minutes |
| Google sign-in | Sign in with a linked Google account | Requires the `googleLogin` module **and** Google OAuth credentials entered + verified in-app (Admin → Integrations → Google — encrypted at rest, no env vars); the module can't be enabled until verification passes; a member links their own Google account from their profile; no account is ever created from Google |

Two-factor authentication is a related sign-in control, but it is switched on as
the `twoFactor` module on [Modules](modules.md).

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| The email sign-in card is inert | The `magicLink` module is off, or email delivery isn't configured | Enable it on [Modules](modules.md); configure transactional email in [`CONFIGURATION.md`](../../CONFIGURATION.md) |
| No Google button appears for members | The `googleLogin` module is off, or the credentials aren't set up / verified | Set up and verify Google at Admin → Integrations → Google sign-in, then enable the module on Login & Security |
| Can't turn on Google sign-in (toggle locked) | Google hasn't been verified yet, or a credential was replaced (re-locks) | Run the Verify step in the Google sign-in setup wizard |
| Stored Google credentials stopped working after an `AUTH_SECRET` rotation, or a data-encryption key was removed or unset | Encrypted credentials can no longer be decrypted (see [`DEPLOYMENT.md`](../../DEPLOYMENT.md#adding-a-data-encryption-key-4456)) | Re-enter and re-verify them in the Google sign-in setup wizard |
| A member can't sign in with Google | Their Google account isn't linked | They link it from their own profile while signed in; unlinked accounts are refused |
| Settings won't save | Your role lacks support edit access | Ask a full admin for support edit access |
| Members (or the lodge tablet) are asked to sign in again although they were using the site | The maximum session age was reached; it counts from sign-in, not from the last use | Expected. Lengthen **Sign members out after (hours)** if the club prefers; the kiosk's 30 days is fixed |

## Related links

- Back to the [documentation hub](../README.md).
- Sibling guides: [Modules](modules.md), [Access Roles](access-roles.md),
  [Setup](setup.md).
- Reference: [`SECURITY.md`](../SECURITY.md) and the
  [security disclosure policy](../../SECURITY.md).
