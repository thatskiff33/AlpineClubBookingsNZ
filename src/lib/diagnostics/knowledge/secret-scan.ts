/**
 * Secret scanner for the knowledge bundle (AID-3). Generation runs this over
 * EVERY candidate file and FAILS CLOSED — a file whose content matches any rule
 * is refused, never truncated-and-included — so a committed credential can
 * never reach the bundle (and, through it, Anthropic).
 *
 * This is a second, independent line to the repo's gitleaks gate
 * (`.gitleaks.toml` plus the required `Secret scan (gitleaks)` job, which since
 * #2686 covers both the pull request's own commits and the full repository
 * history): that guards what is committed; this guards what is EXTRACTED into a
 * shipped artifact. Independence earned its keep — before #2686 the gitleaks
 * config disabled every rule it was meant to run, and this scanner was the only
 * secret gate actually working.
 * The rules are deliberately HIGH-PRECISION (provider-shaped tokens
 * and key blocks), not a generic entropy sweep, so a real deploy is not broken
 * by a false positive — while a genuine live key is still caught.
 *
 * Two shapes matter most for THIS app and are handled beyond the provider
 * tokens: (1) URL-EMBEDDED credentials — `scheme://user:PASSWORD@host`, the
 * `DATABASE_URL` connection-string shape — flagged whenever the password is a
 * real (non-placeholder) value; and (2) UNQUOTED high-entropy assignments —
 * `SECRET_KEY=<random>` in a `.env`/YAML/shell snippet — flagged by the generic
 * assignment rule via an entropy+charset guard so ordinary identifiers and code
 * references (`process.env.X`, dotted paths, dictionary words) do not trip it.
 *
 * The patterns match secret SHAPES only; no real secret appears in this file or
 * its tests. A documented placeholder (`AKIAEXAMPLE…`, `your-secret-here`,
 * `...redacted...`) is NOT a leak — the allowlist below mirrors the gitleaks
 * placeholder allowance so docs that SHOW a token shape stay buildable.
 *
 * ONE class is deliberately STRICTER than that allowance: a Stripe token shape
 * (`sk_(test|live|prod)_…`, `rk_…`, `whsec_…`) fails closed EVEN when it carries
 * a placeholder marker. Trivy's `stripe-secret-token` rule (the image
 * `docker-image-security` gate) has NO placeholder exemption and flags such a
 * shape wherever it appears in the shipped bundle — including a doc "example"
 * that gitleaks waves through because gitleaks ignores test keys. So the rules
 * that mirror Trivy's own no-exemption shapes carry `ignorePlaceholder` and
 * refuse to bundle the file rather than ship a string the image scan will fail
 * on (regression guard for the `sk_test_…placeholder` doc example, #2531 — spelled
 * with the ellipsis HERE because this very comment ships in the server bundle the
 * moment anything routes through this module, and the contiguous spelling is
 * itself the shape Trivy flags. The image scan finding that proved it:
 * PR #2817's `docker-image-security`, 13 Aug 2026).
 */

import { must } from "@/lib/indexed-access";

export interface SecretFinding {
  /** Which rule matched (stable identifier, safe to log). */
  rule: string;
  /** 1-based line number of the match. */
  line: number;
  /**
   * A redacted preview of the match — first 4 chars then `…`, never the full
   * secret — so a finding is safe to surface in a build log or error.
   */
  preview: string;
}

interface SecretRule {
  id: string;
  pattern: RegExp;
  /**
   * Optional per-rule confirmation. When present, a raw pattern match counts as
   * a finding only if this ALSO returns true — the extra guard for rules whose
   * regex is intentionally broad (URL credentials, unquoted assignments) so the
   * precision comes from an entropy/placeholder check on a captured group rather
   * than from the pattern alone. The universal placeholder screen on the whole
   * match still applies FIRST, so `confirm` only ever narrows, never widens.
   */
  confirm?: (match: RegExpExecArray) => boolean;
  /**
   * When true, the universal placeholder screen does NOT exempt this rule — a
   * documented-placeholder marker inside the match is ignored and the shape
   * still fails closed. Set ONLY for shapes a downstream image secret scanner
   * (Trivy) flags with no placeholder allowance of its own (Stripe
   * `sk_/rk_/whsec_`), so a doc "example" of that shape can never be bundled and
   * then trip `docker-image-security`. Left unset for shapes whose Trivy/gitleaks
   * counterparts DO allow an example marker (AWS `…EXAMPLE`), and for the generic
   * assignment/URL rules, so ordinary docs stay buildable.
   */
  ignorePlaceholder?: boolean;
}

/**
 * Substrings that mark a match as a documented PLACEHOLDER rather than a live
 * secret. Case-insensitive. Kept aligned with `.gitleaks.toml`'s allowance.
 */
const PLACEHOLDER_MARKERS = [
  "placeholder",
  "example",
  "redacted",
  "changeme",
  "your-",
  "your_",
  "dummy",
  "sample",
  "xxxxxxxx",
  "notreal",
  "fake",
  // A "mock"-labelled value is a fixture, not a live secret (e.g. the test-only
  // `mock-access-token` in the Xero mock route). Real provider secrets are still
  // caught: their specific rules (AWS/Stripe/Anthropic/…) match the token SHAPE,
  // whose own match text never contains these markers, so this exemption only
  // relaxes the generic `assigned-secret-literal` catch-all.
  "mock",
];

/**
 * Passwords in a `scheme://user:PASSWORD@host` URL that are DOCUMENTATION or
 * local-dev creds, not a live secret. Lower-cased, exact-match. Covers the
 * task-named placeholders (`password`, `pass`, `changeme`, `xxx`, `***`) plus
 * the example/dev connection-string passwords this repo actually ships in its
 * docs (`pass`, `postgres`, `codex`) — kept here rather than in an ignore list
 * so the RULE stays honest and a genuinely random password is still caught.
 * Marker-based placeholders (`example`, `redacted`, `your-…`) are handled
 * separately by `isPlaceholder`, so they are not duplicated here.
 */
const URL_PASSWORD_PLACEHOLDERS = new Set([
  "password",
  "passwd",
  "pwd",
  "pass",
  "secret",
  "changeme",
  "admin",
  "root",
  "user",
  "guest",
  "test",
  "demo",
  "local",
  "none",
  "empty",
  "null",
  "postgres",
  "postgresql",
  "mysql",
  "mariadb",
  "mongo",
  "mongodb",
  "redis",
  "db",
  "database",
  "codex",
]);

/**
 * Per-character Shannon entropy (bits) of a token. A uniformly random token over
 * a large alphabet approaches log2(alphabet); a repetitive or dictionary-like
 * string sits far lower. Used only to gate UNQUOTED assignment values.
 */
function shannonEntropyBits(token: string): number {
  const counts = new Map<string, number>();
  for (const ch of token) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / token.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * Whether an UNQUOTED assigned value looks like real secret material rather than
 * an identifier or code reference. Requires: length ≥16; not a dotted qualified
 * name (`process.env.X`, `a.b.c`); at least two of lower/upper/digit character
 * classes; and a per-char entropy floor. Together these admit random API keys /
 * base64 tokens while rejecting `process.env.SECRET`, dotted config paths, and
 * plain dictionary words.
 */
function looksHighEntropySecret(token: string): boolean {
  if (token.length < 16) return false;
  if ((token.match(/\./g)?.length ?? 0) >= 2) return false;
  const classes =
    Number(/[a-z]/.test(token)) +
    Number(/[A-Z]/.test(token)) +
    Number(/[0-9]/.test(token));
  if (classes < 2) return false;
  return shannonEntropyBits(token) >= 3.0;
}

/**
 * Confirm a `url-embedded-credential` match: keep it only when the captured
 * password (group 1) is present and is NOT an obvious placeholder / dev cred.
 */
function isLiveUrlPassword(match: RegExpExecArray): boolean {
  const password = match[1] ?? "";
  if (password.length === 0) return false;
  if (URL_PASSWORD_PLACEHOLDERS.has(password.toLowerCase())) return false;
  if (isPlaceholder(password)) return false;
  // A purely symbolic redaction (***, xxxx, ....) is never a real password.
  if (/^[*x.\-_#]+$/i.test(password)) return false;
  return true;
}

/**
 * Confirm an `assigned-secret-literal` match. A QUOTED value (group 1) keeps the
 * original behaviour — any ≥16-char literal is a finding (placeholder screen
 * already applied). An UNQUOTED value (group 2) must additionally clear the
 * entropy/charset guard so ordinary unquoted code does not flood the scan.
 */
function isAssignedSecret(match: RegExpExecArray): boolean {
  if (match[1] !== undefined) return true;
  if (match[2] !== undefined) return looksHighEntropySecret(match[2]);
  return false;
}

/**
 * HIGH-PRECISION rules. Each matches a token shape distinctive enough that a
 * match is almost certainly a real credential. Ordered roughly by specificity.
 */
const SECRET_RULES: SecretRule[] = [
  // PEM private key blocks of any flavour (RSA/EC/OPENSSH/PGP/generic).
  {
    id: "private-key-block",
    pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----/,
  },
  // AWS access key ids (long-term AKIA / temporary ASIA).
  { id: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  // Stripe secret / restricted keys — ALL environments, TEST included. Trivy's
  // `stripe-secret-token` rule matches `(sk|rk)_(test|live|prod)_[0-9a-zA-Z]{10,}`
  // with NO placeholder allowance, so even a doc "example" of this shape trips the
  // image `docker-image-security` gate once bundled. `ignorePlaceholder` makes the
  // bundle gate fail closed on the identical shape so the string never ships.
  {
    id: "stripe-secret-key",
    pattern: /\b(?:sk|rk)_(?:test|live|prod)_[0-9a-zA-Z]{10,}\b/,
    ignorePlaceholder: true,
  },
  // Stripe webhook signing secret. Same rationale — a shipped `whsec_…` shape is
  // a credential-shaped string a downstream image scan will flag.
  {
    id: "stripe-webhook-secret",
    pattern: /\bwhsec_[0-9a-zA-Z]{10,}\b/,
    ignorePlaceholder: true,
  },
  // Anthropic API keys.
  { id: "anthropic-api-key", pattern: /\bsk-ant-[0-9A-Za-z_-]{20,}\b/ },
  // Google API keys.
  { id: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  // GitHub personal-access / OAuth / app tokens.
  { id: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{36}\b/ },
  { id: "github-fine-grained-pat", pattern: /\bgithub_pat_[0-9A-Za-z_]{22,}\b/ },
  // Slack tokens.
  { id: "slack-token", pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  // URL-EMBEDDED credentials: `scheme://user:PASSWORD@host` (e.g. a DATABASE_URL
  // connection string). This is the app's PRIMARY secret shape. Group 1 is the
  // password; `confirm` flags it only when that password is a real, non-
  // placeholder value (allows `user:pass`, `postgres`, `changeme`, `***`, …).
  {
    id: "url-embedded-credential",
    pattern: /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:/@]+:([^\s/@]+)@/,
    confirm: isLiveUrlPassword,
  },
  // Generic assignment of a long secret literal to a secret-named key. Group 1
  // is a QUOTED value (>=16 chars); group 2 is an UNQUOTED token (>=16 chars,
  // token charset). The >=16 length stops ordinary code (a field NAMED
  // `password`, a short label) being swept up; `confirm` additionally gates the
  // UNQUOTED branch on entropy/charset (`isAssignedSecret`) so `.env`/YAML/shell
  // secrets are caught without drowning in false positives; placeholder markers
  // exempt documented values.
  {
    id: "assigned-secret-literal",
    pattern:
      /\b(?:password|passwd|pwd|secret[_-]?access[_-]?key|secret[_-]?key|secret|api[_-]?key|apikey|access[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\b["'\s]*[:=]\s*(?:["']([^"'\n]{16,})["']|([A-Za-z0-9+/=_.-]{16,}))/i,
    confirm: isAssignedSecret,
  },
];

function isPlaceholder(matchText: string): boolean {
  const lower = matchText.toLowerCase();
  return PLACEHOLDER_MARKERS.some((marker) => lower.includes(marker));
}

function redact(matchText: string): string {
  const head = matchText.slice(0, 4);
  return `${head}…`;
}

/**
 * Scan text for credential shapes. Returns every finding (empty ⇒ clean). The
 * caller (`generate.ts`) treats a non-empty result as FATAL and refuses to emit
 * the bundle. Line numbers are 1-based against the already-normalized content.
 */
export function scanForSecrets(content: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = must(lines[i], `scanForSecrets: no line at index ${i} within lines.length`);
    for (const rule of SECRET_RULES) {
      const match = rule.pattern.exec(line);
      if (!match) continue;
      // Universal placeholder screen FIRST (documented shapes never leak), then
      // the rule's own confirmation (entropy/placeholder on a captured group).
      // Rules flagged `ignorePlaceholder` opt OUT of the screen: their shape is
      // one a downstream image scanner (Trivy) flags with no example allowance,
      // so even a documented placeholder of that shape must fail closed rather
      // than ship in the bundle.
      if (!rule.ignorePlaceholder && isPlaceholder(match[0])) continue;
      if (rule.confirm && !rule.confirm(match)) continue;
      findings.push({
        rule: rule.id,
        line: i + 1,
        preview: redact(match[0]),
      });
    }
  }
  return findings;
}
