// Reads captured email back from the staging mailpit SMTP capture container
// (docker-compose.staging.yml). The staging app relays all outbound mail to
// mailpit (USE_SMTP_RELAY), so the email-code two-factor spec can trigger a
// send in the browser and then read the emitted six-digit code here rather than
// depending on a live mail provider. mailpit forwards mail nowhere, so no real
// inbox is ever contacted.
//
// mailpit HTTP API shape (v1), confirmed against axllent/mailpit:v1.30.3:
//   GET    /api/v1/messages          -> { messages: [{ ID, To: [{ Address }], Subject, Created }], ... } (newest first)
//   GET    /api/v1/message/{ID}       -> { HTML, Text, ... }
//   DELETE /api/v1/messages           -> 200 (deletes all)

const DEFAULT_MAILPIT_URL = "http://localhost:8025";

function mailpitBaseUrl(): string {
  return (process.env.E2E_MAILPIT_URL ?? DEFAULT_MAILPIT_URL).replace(/\/$/, "");
}

type MailpitSummary = {
  ID: string;
  To: Array<{ Address: string }>;
  Subject: string;
  Created: string;
};

type MailpitMessage = {
  HTML?: string;
  Text?: string;
};

async function mailpitFetch(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${mailpitBaseUrl()}${path}`, init);
  if (!response.ok) {
    throw new Error(
      `mailpit ${init?.method ?? "GET"} ${path} failed: ${response.status} ${response.statusText}`,
    );
  }
  return response;
}

// Deletes every captured message. Called before triggering a fresh send so the
// next matching message is unambiguously the one this step produced. The suite
// runs serially (playwright workers: 1), so no other spec is mid-send.
export async function clearMailbox(): Promise<void> {
  await mailpitFetch("/api/v1/messages", { method: "DELETE" });
}

function toMatches(message: MailpitSummary, recipient: string): boolean {
  const target = recipient.toLowerCase();
  return (message.To ?? []).some(
    (addr) => addr.Address?.toLowerCase() === target,
  );
}

// Pulls the six-digit code out of the two-factor email. The template renders it
// as `<strong ...>123456</strong>` (src/lib/email-templates/account.ts), so anchoring on
// the strong tag is exact — it cannot grab a stray digit run elsewhere in the
// email-HTML wrapper. The plaintext fallback covers mailpit's auto-generated
// text part.
function extractSixDigitCode(message: MailpitMessage): string | null {
  const html = message.HTML ?? "";
  const tagCode = html.match(/<strong[^>]*>\s*(\d{6})\s*<\/strong>/)?.[1];
  if (tagCode) return tagCode;

  const text = message.Text ?? "";
  const textCode = text.match(/(?:^|[^\d])(\d{6})(?:[^\d]|$)/)?.[1];
  if (textCode) return textCode;

  return null;
}

async function findLatestMatch(
  recipient: string,
  subjectFragment: string,
): Promise<string | null> {
  const list = (await (await mailpitFetch("/api/v1/messages")).json()) as {
    messages: MailpitSummary[];
  };
  const subject = subjectFragment.toLowerCase();
  const match = list.messages.find(
    (message) =>
      toMatches(message, recipient) &&
      (message.Subject ?? "").toLowerCase().includes(subject),
  );
  if (!match) return null;

  const full = (await (
    await mailpitFetch(`/api/v1/message/${match.ID}`)
  ).json()) as MailpitMessage;
  return extractSixDigitCode(full);
}

type CapturedEmail = {
  id: string;
  to: string[];
  subject: string;
};

async function listMessages(): Promise<MailpitSummary[]> {
  const list = (await (await mailpitFetch("/api/v1/messages")).json()) as {
    messages: MailpitSummary[];
  };
  return list.messages ?? [];
}

// Polls mailpit until an email addressed to `recipient` whose subject contains
// `subjectFragment` (case-insensitive) is captured, then returns it. Clear the
// mailbox before the send that produces it so a stale message cannot match.
// Used to prove a booking-owner email (e.g. "Booking Pending - …") is sent to a
// real-email non-member owner (#1962).
export async function waitForEmail(
  recipient: string,
  subjectFragment: string,
  { timeoutMs = 20_000, intervalMs = 500 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<CapturedEmail> {
  const deadline = Date.now() + timeoutMs;
  const subject = subjectFragment.toLowerCase();
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const match = (await listMessages()).find(
        (message) =>
          toMatches(message, recipient) &&
          (message.Subject ?? "").toLowerCase().includes(subject),
      );
      if (match) {
        return {
          id: match.ID,
          to: (match.To ?? []).map((addr) => addr.Address),
          subject: match.Subject ?? "",
        };
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  const suffix = lastError instanceof Error ? ` (last error: ${lastError.message})` : "";
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for an email to ${recipient} with subject ` +
      `containing "${subjectFragment}" via mailpit at ${mailpitBaseUrl()}.${suffix}`,
  );
}

// Asserts that NO captured email is addressed to any recipient on `domain`
// throughout a bounded settle window, failing fast on the first sighting. Used
// to prove a walk-in placeholder owner (…@no-email.invalid) is never emailed:
// the send is structurally never attempted (notifyMember:false) and the sendEmail
// core also suppresses placeholder recipients, so the reserved domain must never
// appear as a recipient (#1962). Clear the mailbox before the create so an
// earlier spec's capture cannot pollute the assertion.
export async function assertNoEmailToDomain(
  domain: string,
  { settleMs = 5_000, intervalMs = 500 }: { settleMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const needle = `@${domain.replace(/^@/, "")}`.toLowerCase();
  const deadline = Date.now() + settleMs;

  do {
    const leaked = (await listMessages()).find((message) =>
      (message.To ?? []).some((addr) =>
        (addr.Address ?? "").toLowerCase().endsWith(needle),
      ),
    );
    if (leaked) {
      throw new Error(
        `An email leaked to the reserved placeholder domain ${needle}: ` +
          `"${leaked.Subject}" → ${leaked.To.map((a) => a.Address).join(", ")}. ` +
          `A walk-in placeholder owner must never be emailed (#1935/#1962).`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (Date.now() < deadline);
}

// Polls mailpit until a two-factor code email addressed to `recipient` arrives,
// then returns its six-digit code. Clear the mailbox before the send that
// produces it so a stale code cannot be read.
export async function waitForTwoFactorCode(
  recipient: string,
  { timeoutMs = 20_000, intervalMs = 500 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const code = await findLatestMatch(recipient, "two-factor code");
      if (code) return code;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  const suffix = lastError instanceof Error ? ` (last error: ${lastError.message})` : "";
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for a two-factor code email to ${recipient} ` +
      `via mailpit at ${mailpitBaseUrl()}. Is the mailpit container up and is the ` +
      `staging app configured for USE_SMTP_RELAY -> mailpit?${suffix}`,
  );
}
