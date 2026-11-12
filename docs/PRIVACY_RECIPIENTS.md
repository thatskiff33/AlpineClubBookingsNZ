# Privacy Recipient Register

**Audience: operator, adopter and developer.**

This register says where personal information can leave a club's system and
what enables each flow. A row describes a capability, not a claim that the club
uses it. Disabling a flow stops new transfers; it does not erase copies already
held by a recipient. Check the club's provider contract and privacy notice when
assessing retention, access or an incident.

The club chooses its hosting, mail relay, meeting server and central server.
The links for those roles are background references where there is no universal
provider privacy notice; the club must obtain its chosen operator's notice.
The email link covers Amazon SES; an SMTP relay has its own notice. No row
asserts a provider's data-centre country.

## Outside recipients

The member-facing column identifies recipients that a club's privacy notice
needs to cover when the flow is used. Several credential namespaces can belong
to one recipient. Services without stored credentials still appear here.

| ID | Recipient / privacy reference | Credential namespaces | Personal data sent | Turns the flow on and off | Where processed | Member-facing |
| --- | --- | --- | --- | --- | --- | --- |
| stripe | [Stripe](https://stripe.com/privacy) | `stripe` | Payment amounts, payer email, payment references and booking or subscription identifiers; card details go directly from the browser to Stripe. | Stripe credentials and payment features enable payments; disconnecting or disabling the payment feature stops new payments, but does not delete Stripe records. | See the club's Stripe account terms and Stripe's privacy notice; the application does not fix a processing country. | Yes |
| xero | [Xero](https://www.xero.com/about/legal/privacy/) | `xero`, `xero-oauth` | Member contact details and accounting records, including invoice, payment and subscription references. | The Xero integration module, saved credentials and an OAuth connection enable sync; switching the module off or disconnecting stops new sync, without deleting Xero records. | See the club's Xero account terms and Xero's privacy notice; the application does not fix a processing country. | Yes |
| email | [Email service (Amazon SES or the club's SMTP relay)](https://aws.amazon.com/privacy/) | None | Recipient addresses, names and message contents, which can include booking details and one-time action links. | USE_AWS_SES or USE_SMTP_RELAY and their credentials enable delivery; disabling delivery stops new messages, including sign-in and recovery email. | The club chooses its mail service and configured region or relay; check that provider's contract and privacy notice. | Yes |
| hosting | [Hosting provider](https://www.privacy.org.nz/your-rights/) | None | The application database, uploaded content, request and server logs, including members' personal information. | Running the application and database on the club's chosen infrastructure enables this flow; ending hosting requires an operational migration or shutdown. | The club's choice: see Admin → Website → Appearance → Club Identity → Where members' data is held. Ask the Privacy Officer if it is not set. | Yes |
| backup | [Amazon S3 backups](https://aws.amazon.com/privacy/) | `backup` | Compressed database backups containing the personal information stored in the database. The upload does not itself request S3 encryption. | Enabled backup settings, a bucket and usable S3 credentials enable uploads; disabling backups stops new uploads, without deleting stored copies. | The club chooses its S3 bucket and region in backup settings; check its AWS account terms and bucket encryption configuration. | Yes |
| google | [Google (Analytics and sign-in)](https://policies.google.com/privacy) | `google` | Analytics receives consented usage events and browser/device information, without intentional member identifiers. Google sign-in exchanges identity and authentication information. | Analytics needs the analytics module, a measurement ID and the visitor's consent; withdrawing consent stops analytics. Sign-in needs the googleLogin module and verified OAuth credentials; disabling it stops new Google sign-ins. | See Google's privacy notice and the club's Google account terms; the application does not fix a processing country. | Yes |
| anthropic | [Anthropic (AI help and AI Diagnostics)](https://privacy.anthropic.com/) | `anthropic`, `anthropic-diagnostics` | AI help receives questions, conversation and permitted page context. AI Diagnostics receives operator questions and tool results; a question can cause personal information to be returned to the model. | Each feature needs its own module and dedicated saved API key; both are off unless configured. Switching its module off stops new calls; removing one key does not disable the other feature. | See the club's Anthropic account terms and Anthropic's privacy notice; the application does not fix a processing country. | Yes |
| sentry | [Sentry](https://sentry.io/privacy/) | None | Filtered errors and diagnostic context. Optional session replay adds masked browser interaction recordings; filtering and masking do not establish that every possible value is absent. | A configured Sentry DSN enables error reporting. Replay also needs sentryReplayEnabled and eligible browser sampling; it is off by default. Disable replay separately or remove the DSN to stop new reporting. | See the club's Sentry project region, account terms and Sentry's privacy notice. | Yes |
| breached-passwords | [Have I Been Pwned (breached-password check)](https://haveibeenpwned.com/Privacy) | None | Only the first five hexadecimal characters of the chosen password's SHA-1 hash, plus the server's network request; neither the password, full hash nor member identity is sent. | The breachedPasswordCheck login-security setting enables chosen-password screening; switching it off stops new range lookups. | See Have I Been Pwned's privacy notice; the application does not fix a processing country. | Yes |
| addy | [Addy](https://www.addysolutions.com/privacy-policy) | None | Typed address searches, selected address identifiers and an optional search-session identifier. | The addressAutocomplete module and ADDY_API_KEY / ADDY_API_SECRET enable lookups; the feature is off unless configured. Disable the module or remove credentials to stop lookups. | See the club's Addy account terms and Addy's privacy notice; the application does not fix a processing country. | Yes |
| mirotalk | [Video-meeting server (MiroTalk)](https://github.com/miroslavpejic85/mirotalk) | `mirotalk` | Meeting room and signed access claims, participant display names and network information; participants send audio/video when they join. | The videoMeetings module and a usable meeting-server configuration enable meetings; it is off unless configured. Disable the module or revoke its credentials to stop issuing new access; existing calls may need ending on the meeting server. | The club chooses its meeting server and host; check that operator's location, contract and privacy notice. | Yes |
| servernz | [Alpine Central Server](https://github.com/thatskiff33/AlpineClubServerNZ) | `servernz` | The club's owned lodge listings, booking officer contact details and callback address; no member directory is uploaded. Listings can be shared with other connected clubs. | The serverNZ module, configured server, API key and sync opt-in enable sharing; it is off unless configured. Disable the module or sync opt-in to stop new sync; the central operator controls copies already shared. | The club chooses its central server address; ask that operator where it processes and shares listings and for its privacy notice. | Yes |

## Maintaining coverage

The code register is [privacy-recipient-classification.ts](../src/lib/privacy-recipient-classification.ts).
Its namespace mapping is exhaustive over the typed credential list in
[integration-credential-namespaces.ts](../src/lib/integration-credential-namespaces.ts).
The [recipient census](../src/lib/__tests__/privacy-recipient-census.test.ts)
compares every table cell with the code, checks the security inventory's
credential list, and scans literal HTTPS hosts in server-capable source.

The host scan parses string and template literals in non-test TypeScript under
`src/`, excluding explicit client components and the classification module.
Comments do not count. SDK destinations and club-configured addresses need a
register row even though they have no literal host to scan. This is a source
census, not network tracing: a dynamically constructed host can require review
without appearing in its results. Public information fetches, navigation links
and fictional examples are classified explicitly with reasons in
`NON_RECIPIENT_HTTPS_HOSTS`; they are not extra recipient rows.

Run `pnpm run test:named src/lib/__tests__/privacy-recipient-census.test.ts src/lib/__tests__/integration-credential-namespaces.test.ts`
after changing an integration, a destination or this table. Update the code
classification and its tested documentation together.

## Related links

- [Documentation hub](README.md)
- [Security attack surface and credential handling](SECURITY-ATTACK-SURFACE.md#credentials-at-rest-2079)
- [Personal-data retention](PRIVACY_RETENTION.md)
