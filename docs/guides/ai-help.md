# AI Help Assistant

Audience: Operator

## What it is

The in-app **help widget** and its optional **AI help assistant**. A **Help**
button sits in the corner of every page — the public website, a member's
signed-in area, the admin console, and the finance area. Opening it shows a small
panel with two tabs:

- **Ask** — a greeting ("Kia ora — need a hand with this page?"), a set of
  tappable **question chips** curated for the current page, and — when the AI
  assistant is switched on — a free-text box to ask a question in your own words.
- **Page guide** — the full curated help for that page (what you can do, the
  fields, and any extra notes), shown as plain text.

> **Administrators may see a third tab, *Diagnostics*.** That is a **different
> product** sharing the same doorway — an admin-only, read-only investigation
> assistant that answers "why is this booking stuck?" from live evidence, rather
> than "what does this page do?" from the curated corpus. It has its own model, its
> own budget, its own per-question consent, and its own settings page at
> **Admin → AI Diagnostics**. Nothing on this page applies to it: see
> [`../ai-diagnostics/ux.md`](../ai-diagnostics/ux.md) and its
> [hub](../ai-diagnostics/README.md). The rest of this guide is about the help
> assistant only.

The chips and the Page guide are always available and cost nothing; they come
from a **curated help corpus** shipped with the app (a fixed set of page write-ups
keyed by surface and page — there is no database content and no external call).
The free-text AI box is the only part that calls a paid model, and it is **off by
default**.

Find the operator settings at **Admin → AI help assistant** (`/admin/ai-assistant`),
reached from the **AI help assistant** card on **Admin → Integrations** or the
sidebar item under *Monitoring & Support*.

> **Text-only guide.** The assistant calls a live paid provider, so the
> documentation screenshot harness does not exercise the free-text path; it is
> described in prose here.

## When you'd use it

- You want members to get quick, page-aware answers without emailing the
  committee.
- You've decided the club is comfortable paying a small monthly amount for AI
  answers and want to turn the assistant on.
- You're checking this month's AI spend, or adjusting the spend cap.
- The assistant has stopped answering and you need to work out why.

## What members and visitors see

The curated help is always there for everyone; the AI box appears only once you
enable it.

| Who | Help button | Question chips + Page guide | Free-text AI ask box |
| --- | --- | --- | --- |
| Signed-out website visitor | Yes (bottom-right; hidden while the cookie banner shows) | Yes — public pages only | **Never** — the public widget is curated-only |
| Signed-in member | Yes | Yes — member pages | Only when the module is on **and** a key is stored |
| Admin / finance operator | Yes | Yes — admin/finance pages | Only when the module is on **and** a key is stored |

A signed-out visitor also sees a footer note ("Members: sign in for more help.")
because the public corpus is deliberately smaller than the member one.

When the AI box is available, a member types a question, presses send, and gets a
short answer **grounded strictly in that page's curated help** — if the answer
isn't in the help content the assistant says it doesn't know and points to the
page's help panel or to contacting the club. It has no tools and no access to
member or booking data. A persistent disclaimer sits above the box (see
[Privacy](#privacy)), and each conversation is capped to a few exchanges, after
which the box offers **Start new chat**.

## Step-by-step: enabling the assistant

The recommended order is **key first, module second, cap third** — enabling the
module with no key stored is harmless (the box simply stays off and curated help
keeps working), but doing the key first means the assistant works the moment you
flip the module on.

### 1. Enter the Anthropic API key (Full Admin)

1. Create the key in an Anthropic account. We strongly recommend a **dedicated
   Anthropic workspace** for it, with a **console spend limit of about
   US$20–30/month** set on that workspace. That console limit is a hard backstop
   that sits *outside* this app, so even a misconfiguration can't spend past it.
2. Go to **Admin → AI help assistant** (or the **AI help assistant** card on
   **Admin → Integrations**).
3. In **Anthropic API key**, paste the key (it starts `sk-ant-…`) and **Save API
   key**. The field is **write-only**: once saved the key is never shown again,
   never returned to the browser, never logged, and never written to the audit
   log. To rotate it, paste a new key over the old one.

Only a **Full Admin** can set the key. Support-level operators see the usage and
status but not the key field.

### 2. Enable the module

1. Go to **Admin → Modules** and turn on **AI help assistant**.
2. That's it — with a key already saved, the free-text box now appears on the
   member, admin, and finance help widgets. The public website widget stays
   curated-only regardless.

Unlike Google sign-in, there is **no verify-step** on the key: the app never
pings Anthropic to prove the key works before enabling. If the key is wrong the
box still renders but each answer returns a generic can't-answer notice
pointing members at the Page guide tab or the club office (and an operator
alert is raised — see Troubleshooting).

### 3. Set the monthly spend cap

1. On **Admin → AI help assistant**, the **monthly spend cap** editor takes an
   amount in the club's configured currency. The default is **10.00 in the
   club's configured currency per month** (NZ$10 for a New Zealand club).
2. Adjusting the cap needs **support-edit** access (it doesn't require Full
   Admin).

### 4. If the club's currency is not New Zealand dollars: set the conversion rate

AI usage is priced in **New Zealand dollars** (the provider's US-dollar list
prices at a fixed, conservative 1.8 NZD per USD). A club configured for another
currency enters and reads its cap in its **own** money, so each estimate is
converted through **one administrator-set rate** before it counts against the
cap. The rate is shared with AI Diagnostics — it is one setting, shown on both
AI settings pages.

1. On **Admin → AI help assistant** (or **Admin → AI Diagnostics**), the
   **Currency for AI spend** card shows the club's currency, the current rate
   and **when it was last set**. Until a rate is set, spend is counted as if one
   New Zealand dollar were one unit of the club's currency, and the card says so.
2. Enter how many units of the club's currency one New Zealand dollar buys — for
   example `0.92` — and save. Support-edit access is required.
3. **Check the rate now and then.** Nothing updates it for you; a rate that
   drifts makes the caps silently too loose or too tight, which is why the card
   shows when it was last set. The rate is rounded in the club's favour of
   caution: every converted estimate is rounded **up** to the next cent.

A New Zealand club sees a one-sentence note that no conversion applies and no
rate editor. Past usage is never re-priced: each recorded call keeps the
club-currency cost at the rate in force when it was made.

## Cost and spend behaviour

- The assistant uses a small, inexpensive model (Anthropic **Claude Haiku 4.5**).
  A typical question costs on the order of a couple of cents.
- The **monthly spend cap** is a **hard cutoff** for the calendar month
  (measured in New Zealand time, Pacific/Auckland). Once the month's estimated
  spend would exceed the cap, the assistant stops making paid calls and returns a
  "unavailable for the rest of the month" notice; curated page help keeps working.
  Spend resets at the start of the next NZ month.
- Cost is deliberately **over-estimated** (a conservative US-dollar to New
  Zealand dollar rate, then — for a club in another currency — the
  administrator's rate, always rounded up), so the cap trips **early rather
  than late** — your real Anthropic bill should come in a little under the cap,
  not over.
- The cap reserves the worst-case cost of an in-flight question before allowing
  it, and the app **stops spending if it can no longer record usage**
  ("can't-meter, don't-spend"). Per-member, per-IP, and global daily rate limits
  also throttle bursts, but the monthly cap is the real spend ceiling — with the
  Anthropic console limit (step 1) as the outer backstop.
- The cap and the currency conversion rate are **deployment-specific**
  controls: neither travels in a config-transfer/import bundle, so a freshly
  imported club starts at the default cap of 10.00 in its configured currency
  and, outside New Zealand, with no rate set.

## Privacy

- When a member asks a free-text question, the **question text** (and any page
  context the widget attaches) is sent to **Anthropic PBC (United States)** to
  generate the reply. Anthropic acts as a data **processor** for the club.
- This app **does not store the question text**. Only aggregate metering is
  kept — token counts, estimated cost, success/failure, the page, and the
  question's *length* (character count) — never the words themselves. The admin
  usage panel therefore can't show you what anyone asked.
- The box carries a fixed, non-editable disclaimer:

  > "AI answers can be wrong — check the page itself for anything important. Your
  > question is sent to Anthropic (US); don't include personal details."

- **Update your privacy page before enabling.** The club's public privacy
  statement is club-authored (the `/privacy` page). A club turning this on should
  add Anthropic to its list of processors. Suggested wording:

  > "If you use our in-app AI help assistant, the question you type is sent to
  > Anthropic PBC (United States), our AI processor, to generate a reply. We do
  > not store the text of your question. Please don't include personal or
  > sensitive details in AI help questions."

## Settings reference

| Setting | Where | Who can change it | Notes |
| --- | --- | --- | --- |
| AI help assistant module | Admin → Modules | Module editor | Off by default. Turns the free-text box on across authenticated surfaces. |
| Anthropic API key | Admin → AI help assistant | **Full Admin** | Write-only, encrypted at rest, never shown/logged/audited. No `ANTHROPIC_API_KEY` env var exists — the key is in-app only. |
| Monthly spend cap | Admin → AI help assistant | Support (edit) | Default **10.00 in the club's configured currency** (NZ$10 for a New Zealand club). Hard cutoff for the NZ calendar month. Not carried in config-transfer bundles. |
| Currency for AI spend | Admin → AI help assistant, Admin → AI Diagnostics (one shared setting) | Support (edit) | How many units of the club's currency one New Zealand dollar buys, shown with when it was last set. Only for a club whose currency is not NZD; unset means 1:1. Not carried in config-transfer bundles. |
| Usage panel | Admin → AI help assistant | Support (view) | Month spend vs cap, token totals, request/failed counts, per-surface breakdown, recent failures. No question text. |

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Members don't see the ask box (only chips + Page guide) | The module is off, or no key is stored | Enable the module on **Admin → Modules** and confirm the key shows **Saved** on **Admin → AI help assistant** |
| Box shows "unavailable for the rest of the month" | The monthly spend cap has been reached | Wait for the next NZ calendar month, or raise the cap (support-edit) |
| Box appears but every answer is the generic "Sorry — I could not answer that just now" notice | The stored key is invalid/rejected, the provider is failing, or metering can't be written | Re-enter a valid Anthropic key (Full Admin); an auth rejection also raises an operator alert. Curated help keeps working meanwhile |
| Key status shows **Re-enter required** | The app auth secret (`AUTH_SECRET`/`NEXTAUTH_SECRET`) was rotated, so the encrypted key can no longer be decrypted | Re-enter the Anthropic key (Full Admin); the assistant stays off until you do |
| "That's the limit for one conversation." | The per-conversation exchange cap was reached | Use **Start new chat** to begin a fresh conversation |
| `/admin/ai-assistant` returns 404 | The AI help assistant module is off | Enable it on **Admin → Modules** — the whole admin page is hidden while the module is off |

## Related links

- [`CONFIGURATION.md`](../../CONFIGURATION.md) — the "AI help assistant" reference
  (DB-only key, spend cap, and the privacy note).
- [Modules](modules.md) — the on/off panel where the AI help assistant module
  lives.
- [Integrations](integrations.md) — the hub that carries the AI help assistant
  card alongside Xero, Stripe, and Backups.
