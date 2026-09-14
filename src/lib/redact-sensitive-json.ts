const REDACTED_SECRET = "[REDACTED]";

/**
 * Recursion and failure bounds for the object walk (#2683).
 *
 * `redactSensitiveJson` used to recurse with no depth limit and no
 * circular-reference guard. Hand it a Prisma result carrying a self-referencing
 * relation — a member whose family group lists the member — and it recursed
 * until the stack overflowed. Because this redactor sits inside pino's `log`
 * formatter (`src/lib/logger.ts`) and Sentry's `beforeSend` in all THREE Sentry
 * surfaces (`src/instrumentation-client.ts`, `sentry.server.config.ts`,
 * `sentry.edge.config.ts`), the overflow happened while the server was trying
 * to LOG something, usually from inside an error handler: the process died
 * instead of recording why it was unhappy. That is an availability failure, not
 * only a privacy one.
 *
 * TWO ENTRY POINTS, because a log line and a stored record want different
 * things from the same redaction rules:
 *
 *   - `redactSensitiveJson` is the LOG/Sentry path. It caps depth at 6, because
 *     nothing downstream needs the tail of a runaway structure and the formatter
 *     must stay cheap.
 *   - `redactSensitiveRecord` is the STORED-or-DISPLAYED path — `sanitizeForJson`
 *     in `src/lib/xero-sync.ts` writes `XeroSyncOperation.requestPayload` /
 *     `responsePayload` through it, and the admin Xero panels render through it.
 *     Those are persisted records and the admin's only view of them, several
 *     written by read-modify-write cycles that re-persist what they read, so a
 *     cut branch is permanent and compounds. It therefore keeps the circular
 *     guard (which it never had) and drops the log depth cap to a bound no real
 *     Xero payload approaches. Measured: at the log cap an invoice update lost
 *     `lineItems[].tracking`, silently and forever.
 *
 * TRUNCATION IS ALWAYS VISIBLE. A branch cut by the depth cap is replaced by
 * the literal `[TRUNCATED]`, a back-reference by `[Circular]`, a value whose own
 * getter threw by `[UNREADABLE]`, and a walk that failed outright by
 * `[REDACTION_FAILED]`. Nothing is dropped, emptied or silently flattened — a
 * redactor that quietly deleted fields would hide the very error context the log
 * exists to capture, which is exactly the trade this guard must not make.
 *
 * Only OBJECTS and ARRAYS are subject to the cap. Scalars are returned at any
 * depth, and an `Error` renders its name, message and stack at any depth too —
 * only its recursive parts (`cause`, `AggregateError.errors`, attached own
 * properties such as Prisma's `code`/`meta`) are bounded. An error message that
 * vanished because the object around it was deep is the one loss a log redactor
 * must never cause.
 *
 * THREE DIFFERENCES from the audit-metadata sanitiser at `src/lib/audit.ts`,
 * which this otherwise mirrors (same cap value, same marker strings):
 *
 *  1. The WeakSet here tracks the ANCESTOR PATH — an object is removed again on
 *     the way back out — rather than every object ever visited. `audit.ts` never
 *     removes, so the second sibling reference to one shared object is reported
 *     as `[Circular]` when nothing is circular at all. In an audit row that is a
 *     cosmetic loss; in a log line it would blank a payload an operator is
 *     reading to diagnose an incident.
 *  2. Because ancestor-only tracking re-renders a shared subtree once per path
 *     that reaches it, rendered subtrees are MEMOISED by identity and depth,
 *     which is what `audit.ts`'s visited-set gets for free by being wrong about
 *     siblings. A subtree whose rendering CONSULTED the ancestor set (it
 *     contains a `[Circular]` marker) is path-dependent and is therefore never
 *     memoised.
 *  3. The log path carries an OUTPUT BUDGET (`MAX_LOG_REDACTION_ENTRIES`) that
 *     `audit.ts` has no equivalent of, and does not carry `audit.ts`'s size caps
 *     (50 array items, 75 object keys, 1000-character strings) at all.
 *
 * That third difference is worth the detail, because the obvious answers are
 * both wrong. A seven-object diamond measured 5.2 MB of output at a fan-out of
 * 8 and 19.7 MB at 10, inside pino's formatter and three Sentry `beforeSend`s.
 *
 *   - `audit.ts`'s caps do not bound it. The blow-up is fan-out RAISED TO the
 *     depth, and a fan-out of 8 never reaches a 75-key or 50-item cap.
 *   - Memoisation does not bound it either. It bounds the WALK — measured, the
 *     same graph renders 6 distinct objects in under a millisecond — but JSON
 *     has no syntax for a reference, so `JSON.stringify` expands every shared
 *     subtree again on the way out. The walk became linear and the bytes did
 *     not move.
 *
 * So the budget counts the ENTRIES a single top-level redaction may emit — every
 * object key and array item — a memo hit costing what its subtree costs, and the
 * branch that exhausts it says `[TRUNCATED]`. It is set far above any real log payload — a Prisma member with
 * its relations is a couple of hundred nodes — so nothing an operator actually
 * reads is affected, and a pathological graph is bounded in bytes rather than
 * only in time. The string cap stays off: clipping at 1000 characters would cut
 * the tail off every stack trace, which is the diagnostic the log exists to
 * carry.
 *
 * COVERAGE IS BY KEY SPELLING, and is therefore not exhaustive — see
 * INV-PRIV-011. A person field reaches a log redacted only if its key matches
 * one of the names below. Emails and phone numbers have a second, value-shaped
 * net; names and addresses have none, because nothing about the string
 * "12 Example Street" identifies it as an address. A caller that invents a new
 * spelling, or composes a person's name into a key this list does not know, is
 * the gap — which is why the call sites that did so are fixed at source.
 */
const MAX_LOG_REDACTION_DEPTH = 6;
/**
 * Entries — object keys plus array items — one log-path redaction may emit. See
 * the note above on why neither a depth cap, nor `audit.ts`'s size caps, nor
 * memoisation bounds the serialised size of a shared subtree on their own.
 *
 * Entries rather than nodes, because output size tracks the number of key/value
 * pairs written, not the number of containers: a budget counted in containers
 * lets a wide one through at a hundred times the bytes of a narrow one. Two
 * orders of magnitude above any real log payload, and roughly a quarter of a
 * megabyte at its very worst.
 */
const MAX_LOG_REDACTION_ENTRIES = 10_000;
/**
 * The stored/displayed bound. The ancestor guard already guarantees termination
 * for any finite object graph, so this is a backstop against a pathologically
 * deep (or synthesising, e.g. Proxy-generated) structure rather than a content
 * policy. No Xero request or response payload comes close to it.
 *
 * The stored path has NO output budget: a Xero payload is a tree parsed from the
 * provider's own JSON, not a shared graph, so the blow-up the log budget exists
 * for cannot arise — and truncating a persisted record is the exact harm this
 * split was made to stop.
 */
const MAX_RECORD_REDACTION_DEPTH = 100;
const TRUNCATED_BRANCH = "[TRUNCATED]";
const CIRCULAR_REFERENCE = "[Circular]";
const UNREADABLE_VALUE = "[UNREADABLE]";
const REDACTION_FAILED = "[REDACTION_FAILED]";

const SENSITIVE_JSON_KEYS = new Set([
  "authorization",
  "cookie",
  "setcookie",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "apikey",
  "stripetoken",
  "email",
  "phone",
  "phonenumber",
  "mobilephone",
  "paymentmethod",
  "paymentmethodid",
  "charge",
  "chargeid",
  "clientreferenceid",
  // Person fields (#2683). `dateofbirth` is covered by the fragment below;
  // "dob" is the one spelling a fragment cannot reach.
  "dob",
  // Xero's NZBN field, which THIS club uses to carry a member's date of birth
  // (#2859). Before #2859 the app only ever read it, so it never reached a
  // stored payload; the outbound contact writers now SEND it, which would have
  // written a date of birth into `XeroSyncOperation.requestPayload` and left it
  // there. No fragment reaches this spelling and the `dd/mm/yyyy` value has no
  // value-shaped net either, so the key is the only line of defence.
  // EXACT rather than a fragment: the key is always spelled `companyNumber`
  // (Xero's `CompanyNumber` folds to the same thing), and nothing operational
  // is lost — the admin Xero panels have never displayed it.
  "companynumber",
  // Xero's own bare address keys (#2683 review). `Contact.Addresses[]` carries
  // `City`, `Region` and `Country` with no prefix, so the `street`/`postal`
  // fragments that cover this schema's own `streetCity`/`streetRegion` columns
  // never see them. EXACT rather than fragment on purpose: a `region` fragment
  // would also blank `awsRegion` and a `country` fragment `phoneCountryCode`,
  // and an exact match still catches Xero's spelling because keys are
  // case-normalised. The accepted collateral is that a genuinely operational
  // key spelled exactly `region` (e.g. a storage region in a config echo) is
  // redacted in a log; no such value is logged today, and an address region is
  // worth more than a bucket region.
  "city",
  "region",
  "country",
]);
const SENSITIVE_JSON_KEY_FRAGMENTS = new Set([
  "email",
  "phone",
  "paymentmethod",
  "charge",
  "clientreferenceid",
  // AI help assistant (#2211): a free-text question, its transcript, and the
  // client-supplied page state are user content that must never land in a log
  // or audit payload. Fragment matches also cover keys like "questionChars".
  "question",
  "transcript",
  "pagecontext",
  // Credentials (#2683 review). These were the most surprising gap in the list:
  // the exact key "password" never matched `passwordHash`, and `totpSecret`
  // matched nothing at all, so the LOG redactor was strictly weaker than the
  // audit writer — the opposite of what any reader would assume, and reachable
  // (`api/admin/members/import` puts `row.passwordHash` in a request body,
  // which Sentry captures as `event.request.data`). Fragments, matching
  // `audit.ts`'s `includes("password")` / `includes("secret")`, so a hash, a
  // confirmation field or a TOTP seed cannot be missed on a spelling. The named
  // one-off tokens below have no shared fragment; `token` itself is NOT a
  // fragment because it would also blank `tokenCount`/`tokensUsed`, which are
  // operational metrics rather than credentials.
  "password",
  "secret",
  "resettoken",
  "verificationtoken",
  "nominationtoken",
  "sessiontoken",
  "authtoken",
  // Person fields (#2683), from `Member` in prisma/schema.prisma. Emails and
  // phone numbers are caught a second time by the value-shaped patterns below,
  // so a missing key name still cannot leak one. Names and addresses have NO
  // such fallback — nothing about the string "12 Example Street" identifies it
  // as an address — so the key name is the only line of defence and these are
  // fragments rather than exact keys: `memberFirstName`, `actor_last_name` and
  // `Contact.FirstName` all have to be caught, not just `firstName`.
  //
  // `street` and `postal` cover streetAddressLine1/2, streetCity, streetRegion,
  // streetPostalCode, streetCountry and their postal twins in one fragment
  // each; `addressline` additionally covers Xero's own `AddressLine1` shape,
  // which carries neither prefix. They also catch a handful of adjacent
  // booleans (`postalSameAsPhysical`, `showGender`, `showOccupation`) whose
  // redaction costs a log reader nothing — the same accepted trade as
  // `emailedAt`, noted on `isSensitiveJsonKey` below.
  //
  // The COMPOSED spellings (`memberName`, `guestName`, …) are the ones a server
  // route invents when it joins a first and last name together for a message.
  // They were documented as a known gap once; a gap in a redactor is work, not
  // a note (AGENTS.md §6), so they are on the list. `memberName` in particular
  // is first-party, composed in at least six server routes, and was filed as
  // "Xero's own" — it is not.
  "firstname",
  "lastname",
  "middlename",
  "givenname",
  "familyname",
  "surname",
  "fullname",
  "membername",
  "guestname",
  "contactname",
  "dateofbirth",
  "gender",
  "occupation",
  "street",
  "postal",
  "addressline",
]);
/**
 * `name` is NOT on either list. It is the key for lodges, rooms, membership
 * types, email templates, modules, fee schedules and Xero contact groups, and
 * `xero-operation-summaries.ts` reads `defaultGroup.name` and the resulting
 * group names straight out of an already-redacted payload to render the admin
 * Xero operations panel. Redacting every `name` would blank operational logs and
 * live admin UI to catch a person's name that the composed spellings above catch
 * properly. Every call site that recorded a person-or-family `name` is fixed at
 * source instead — including the Xero contact writers, whose PERSISTED request
 * payload no longer carries the `Name` that Xero's API requires them to SEND.
 */
const SENSITIVE_JSON_KEY_FRAGMENT_LIST = Array.from(
  SENSITIVE_JSON_KEY_FRAGMENTS
);

const SENSITIVE_STRING_VALUE_PATTERNS = [
  // Email addresses. The local part and the domain exclude `/` and `\` so that
  // a filesystem path is not read as an address. Without that exclusion
  // `node_modules/@sentry/nextjs/dist/index.js` matched — "…/node_modules/"
  // before the @, "sentry/nextjs/dist/index.js" after it — so EVERY server
  // stack trace naming a scoped package was replaced wholesale with
  // "[REDACTED]". A log that reports `stack: "[REDACTED]"` has thrown away the
  // only thing it was written to carry. Real addresses still match: the domain
  // needs a dot before any slash, which a scoped package path never has.
  /[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+/,
  // The same address after URL encoding, which is how one arrives inside a
  // query string (`jane%40example.test`). The bare pattern above cannot see it,
  // so an email in a URL survived byte-identical into Sentry.
  /[^\s@/\\%]+%40[^\s@/\\%]+\.[^\s@/\\%]+/i,
  // Phone-like digit runs, but only when standalone. The boundaries stop this
  // from matching digits embedded in an alphanumeric identifier (e.g. a cuid
  // such as "cmqdxeu50002101n22w2ivcas", which contains "50002101"). Without
  // them, internal operation/record IDs that happen to hold 8+ consecutive
  // digits were rewritten to "[REDACTED]", corrupting load-bearing IDs stored
  // in persisted payloads (e.g. a requeue's originalOperationId).
  /(?<![A-Za-z0-9])\+?[0-9]{8,15}(?![A-Za-z0-9])/,
];
const STRIPE_SECRET_VALUE_PATTERN =
  /\b(?:(?:sk|rk)_(?:live|test)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+|(?:pi|seti|si|cs)_[A-Za-z0-9]+_secret_[A-Za-z0-9]+)\b/g;
const TOKEN_QUERY_VALUE_PATTERN =
  /([?&](?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|payment[_-]?intent[_-]?client[_-]?secret|setup[_-]?intent[_-]?client[_-]?secret|oauth[_-]?state|token|state|code)=)[^&#\s]+/gi;
const TOKEN_KEY_VALUE_PATTERN =
  /\b(access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|password|stripe[_-]?token|token)\s*([:=])\s*("[^"]*"|'[^']*'|[^,\s;&]+)/gi;
/**
 * Any `key=value` pair in a query string, so the KEY can be tested against the
 * same denylist the object walk uses instead of against a hand-maintained list
 * of token names. This is what closes the URL half of the query-parameter leak:
 * the admin audit-log page puts `memberName` and `memberEmail` into the address
 * bar, and all three Sentry surfaces send `event.request.url` through
 * `redactSensitiveText`.
 */
const QUERY_PARAM_PATTERN = /([?&])([^?&=#\s]+)=([^&#\s]*)/g;
/**
 * A `"key": "value"` pair in text that LOOKS like JSON but does not parse — a
 * truncated provider error, say. The key is tested against `isSensitiveJsonKey`
 * rather than against a second, hand-written alternation of key names. The
 * previous alternation was that second list, and it had drifted: it never knew
 * about `passwordHash`, `memberName` or the AI-assistant keys, so the text path
 * was quietly weaker than the object path. There is now one list.
 */
const JSON_TEXT_KEY_VALUE_PATTERN =
  /("?)([A-Za-z0-9_\-.]{1,120})\1\s*:\s*"((?:[^"\\]|\\.)*)"/g;
const SENSITIVE_QUERY_KEYS = new Set([
  "access_token",
  "access-token",
  "refresh_token",
  "refresh-token",
  "id_token",
  "id-token",
  "client_secret",
  "client-secret",
  "payment_intent_client_secret",
  "payment-intent-client-secret",
  "setup_intent_client_secret",
  "setup-intent-client-secret",
  "oauth_state",
  "oauth-state",
  "token",
  "state",
  "code",
]);

function normalizeJsonKey(key: string) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveJsonKey(key: string) {
  const normalizedKey = normalizeJsonKey(key);

  // Fragment matches may redact noisy keys like emailedAt, which is acceptable to avoid leaking PII or Stripe IDs.
  return (
    SENSITIVE_JSON_KEYS.has(normalizedKey) ||
    SENSITIVE_JSON_KEY_FRAGMENT_LIST.some((sensitiveFragment) =>
      normalizedKey.includes(sensitiveFragment)
    )
  );
}

/**
 * THE NAME/VALUE PAIR (#2940). `value` beside `key` is redacted; `value`
 * anywhere else is left alone.
 *
 * The credential routes post `{ key, value, version }`, so a signing key's
 * plaintext arrives under `value` — which neither list above reached, because
 * the fragments match key NAMES. Sentry sends `event.request.data` through this
 * module, and on the MiroTalk credential route two gates sit outside the
 * handler's own try/catch, so an unhandled throw can capture that body.
 *
 * NOT an exact `"value"` denylist entry, which is the shorter and stronger fix.
 * `value` is not a credential name, it is the second half of a name/value pair,
 * and this tree writes that pair with a `label` far more often than with a
 * `key`: `booking-money-lines.ts` builds dozens of `{ label, value }` rows
 * carrying money and date ranges, `audit-query.ts` builds `{ label, value }`
 * option lists. A denylist entry blanks every one in every log line and in the
 * admin Xero panels, to catch a shape that can be identified precisely — and a
 * redactor that blinds the diagnostics has a security cost of its own.
 *
 * The pair is the right test because in `{ key, value }` the meaning of the
 * value is decided by DATA rather than by schema, so this module cannot judge it
 * and must assume the worst; everywhere else `value` means what the surrounding
 * code chose. The `key` survives, so a settings echo still says WHICH setting.
 *
 * STATED LIMIT: it needs both keys in one object, so it reads a parsed body
 * (including one parsed out of a string) but not the flat `"key":"…"` text
 * fallback, which fires only when a body is too mangled to parse and has no
 * sibling context. `password` and `secret` remain fragments there.
 */
const PAIR_NAME_KEY = "key";
const PAIR_VALUE_KEY = "value";

/** The `value` half of a `{ key, value }` pair, both halves normalised. */
function isNameValuePairSecret(
  normalizedKey: string,
  normalizedSiblingKeys: ReadonlySet<string>
) {
  return (
    normalizedKey === PAIR_VALUE_KEY && normalizedSiblingKeys.has(PAIR_NAME_KEY)
  );
}

function normalizedKeySet(keys: readonly string[]): ReadonlySet<string> {
  return new Set(keys.map(normalizeJsonKey));
}

/**
 * Query-string keys are the JSON denylist PLUS the generic OAuth/callback names.
 *
 * The union matters in both directions. `code` and `state` are meaningless as
 * JSON keys — a `code` is usually an error code and a `state` a booking state,
 * and blanking those in every logged object would be pure loss — so they belong
 * only to the query context, which is why this extra set exists at all. But the
 * previous code checked ONLY that extra set, which meant a query parameter
 * skipped the person/credential denylist entirely: `memberName=Jane Doe`
 * survived verbatim into Sentry from the admin audit-log page.
 */
function isSensitiveQueryKey(key: string) {
  return isSensitiveJsonKey(key) || SENSITIVE_QUERY_KEYS.has(key.toLowerCase());
}

function isSensitiveStringValue(value: string) {
  return SENSITIVE_STRING_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Mutable state carried through one top-level redaction.
 *
 * `rendered` is swapped and restored around the hop into a parsed JSON string
 * rather than copied, so an ordinary walk allocates nothing beyond its output.
 */
type MemoisedSubtree = {
  result: unknown;
  /** Entries this subtree emits, so a memo hit costs the budget what it costs. */
  entries: number;
};

type RedactionContext = {
  maxDepth: number;
  maxEntries: number;
  entries: number;
  ancestors: WeakSet<object>;
  rendered: Map<object, Map<number, MemoisedSubtree>>;
  circularHits: number;
};

function createContext(
  maxDepth: number,
  maxEntries: number
): RedactionContext {
  return {
    maxDepth,
    maxEntries,
    entries: 0,
    ancestors: new WeakSet<object>(),
    rendered: new Map<object, Map<number, MemoisedSubtree>>(),
    circularHits: 0,
  };
}

function createLogContext(): RedactionContext {
  return createContext(MAX_LOG_REDACTION_DEPTH, MAX_LOG_REDACTION_ENTRIES);
}

function createRecordContext(): RedactionContext {
  return createContext(MAX_RECORD_REDACTION_DEPTH, Number.POSITIVE_INFINITY);
}

function redactSensitiveQueryString(value: string): string {
  return value.replace(
    QUERY_PARAM_PATTERN,
    (match, separator: string, rawKey: string) => {
      let key = rawKey;
      try {
        key = decodeURIComponent(rawKey);
      } catch {
        // A malformed escape sequence; test the raw spelling instead.
      }
      return isSensitiveQueryKey(key)
        ? `${separator}${rawKey}=${REDACTED_SECRET}`
        : match;
    }
  );
}

function redactJsonStringCandidate(
  value: string,
  ctx: RedactionContext
): string | null {
  const trimmed = value.trim();
  const firstBraceIndex = trimmed.search(/[{[]/);

  if (firstBraceIndex === -1) {
    return null;
  }

  const prefix = trimmed.slice(0, firstBraceIndex);
  const jsonCandidate = trimmed.slice(firstBraceIndex);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonCandidate);
  } catch {
    return null;
  }

  // The parsed document restarts the depth budget at ZERO. It used to inherit
  // the outer depth, on the theory that resetting would leave the mutual
  // recursion between text and object redaction unbounded. That theory is
  // wrong, and inheriting cost something real.
  //
  // WHY IT TERMINATES. To continue the chain, each level must be a JSON
  // document containing a STRING that is itself a JSON document — and a JSON
  // string is delimited by quotes, which the next level up has to escape. So the
  // escaping at least doubles per level, and the chain hits the maximum string
  // length long before anything else: measured, building level 26 throws
  // "Invalid string length" at construction. Within each parsed document the
  // depth cap still applies, and `ctx.entries` is deliberately NOT reset, so the
  // shared output budget bounds the total work across every hop. A hop counter
  // was tried here and removed: it bounded nothing that was not already bounded,
  // and by refusing to parse the innermost document it left values there
  // redacted only by the weaker text-shaped rules.
  //
  // WHAT INHERITING COST. On the live path (`xero-operation-outbox.ts`), a Xero
  // 400 whose message carries a validation document rendered as
  // `"ValidationErrors":["[TRUNCATED]"]` — the sentence saying why Xero refused
  // the invoice, deleted, in the record kept to explain the failure.
  //
  // The memo IS reset, because a memoised subtree is only sound within the
  // document whose depths it was rendered at. `ancestors` is shared: a freshly
  // parsed document cannot contain an outer object, so sharing costs nothing and
  // keeps one guard.
  const outerRendered = ctx.rendered;
  ctx.rendered = new Map<object, Map<number, MemoisedSubtree>>();
  try {
    return `${prefix}${JSON.stringify(
      redactSensitiveJsonValue(parsed, 0, ctx)
    )}`;
  } catch {
    return null;
  } finally {
    ctx.rendered = outerRendered;
  }
}

// Token-bearing paths can land in webserver, proxy, callbackUrl, and
// observability access logs. Redact both literal paths and URL-encoded callback
// paths so opaque action tokens do not leak through login redirects.
// `lodge-maintenance` joins the list with #2780: the per-lodge QR sign carries a
// 256-bit bearer token in the path, and it is the one token here that a stranger
// can walk into a building and photograph, so keeping it out of proxy and Sentry
// logs matters at least as much as for the emailed ones.
const TOKEN_PATH_PATTERN =
  /(\/(?:membership-cancellation|chores|nominations|pay|lodge-maintenance)\/|\/booking-requests\/(?:verify|respond)\/|\/group-bookings\/join\/verify\/)[A-Za-z0-9_-]+/g;
const ENCODED_TOKEN_PATH_PATTERN =
  /(%2F(?:membership-cancellation|chores|nominations|pay|lodge-maintenance)%2F|%2Fbooking-requests%2F(?:verify|respond)%2F|%2Fgroup-bookings%2Fjoin%2Fverify%2F)[A-Za-z0-9_-]+/gi;

function redactSensitiveTextValue(
  value: string,
  ctx: RedactionContext
): string {
  const redactedJsonCandidate = redactJsonStringCandidate(value, ctx);
  if (redactedJsonCandidate) {
    return redactedJsonCandidate;
  }

  const redactedValue = redactSensitiveQueryString(value)
    .replace(TOKEN_PATH_PATTERN, `$1${REDACTED_SECRET}`)
    .replace(ENCODED_TOKEN_PATH_PATTERN, `$1${REDACTED_SECRET}`)
    .replace(JSON_TEXT_KEY_VALUE_PATTERN, (match, quote: string, key: string) =>
      isSensitiveJsonKey(key)
        ? `${quote}${key}${quote}:"${REDACTED_SECRET}"`
        : match
    )
    .replace(TOKEN_QUERY_VALUE_PATTERN, `$1${REDACTED_SECRET}`)
    .replace(TOKEN_KEY_VALUE_PATTERN, `$1$2${REDACTED_SECRET}`)
    .replace(STRIPE_SECRET_VALUE_PATTERN, REDACTED_SECRET)
    .replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b/gi, `Bearer ${REDACTED_SECRET}`);

  return isSensitiveStringValue(redactedValue) ? REDACTED_SECRET : redactedValue;
}

/**
 * An `Error`, rendered so that the parts a log exists to carry survive.
 *
 * `{name, message, stack}` alone dropped three things that ARE the diagnostic:
 * `cause`, whatever the thrower attached as own enumerable properties (for a
 * `PrismaClientKnownRequestError` that is `code` and `meta` — the whole reason
 * the error is actionable), and `AggregateError.errors`. `cause` and `errors`
 * are non-enumerable own properties, so neither appears in `Object.keys` and
 * each has to be asked for by name.
 *
 * This runs BEFORE the depth check, so an error that happens to sit deep in a
 * payload still reports its message. Only the recursive parts are bounded, and
 * when they are cut they say so.
 */
function redactError(
  value: Error,
  depth: number,
  ctx: RedactionContext
): unknown {
  if (ctx.ancestors.has(value)) {
    ctx.circularHits += 1;
    return CIRCULAR_REFERENCE;
  }

  ctx.ancestors.add(value);
  try {
    const result: Record<string, unknown> = {
      name: value.name,
      message: redactSensitiveTextValue(String(value.message ?? ""), ctx),
    };
    if (value.stack) {
      result.stack = redactSensitiveTextValue(value.stack, ctx);
    }

    const canRecurse = depth < ctx.maxDepth;

    let ownKeys: string[] = [];
    try {
      ownKeys = Object.keys(value);
    } catch {
      result.ownProperties = UNREADABLE_VALUE;
    }

    // The pair rule applies to an error's own properties too: a thrower that
    // attaches the request body it choked on attaches `{ key, value }` with it.
    const normalizedOwnKeys = normalizedKeySet(ownKeys);

    for (const key of ownKeys) {
      if (
        key === "name" ||
        key === "message" ||
        key === "stack" ||
        key === "cause"
      ) {
        continue;
      }
      if (
        isSensitiveJsonKey(key) ||
        isNameValuePairSecret(normalizeJsonKey(key), normalizedOwnKeys)
      ) {
        result[key] = REDACTED_SECRET;
        continue;
      }
      if (!canRecurse) {
        result[key] = TRUNCATED_BRANCH;
        continue;
      }
      try {
        result[key] = redactSensitiveJsonValue(
          (value as unknown as Record<string, unknown>)[key],
          depth + 1,
          ctx
        );
      } catch {
        result[key] = UNREADABLE_VALUE;
      }
    }

    const cause = (value as { cause?: unknown }).cause;
    if (cause !== undefined) {
      result.cause = canRecurse
        ? redactSensitiveJsonValue(cause, depth + 1, ctx)
        : TRUNCATED_BRANCH;
    }

    const aggregated = (value as { errors?: unknown }).errors;
    if (Array.isArray(aggregated)) {
      result.errors = canRecurse
        ? redactSensitiveJsonValue(aggregated, depth + 1, ctx)
        : TRUNCATED_BRANCH;
    }

    return result;
  } finally {
    ctx.ancestors.delete(value);
  }
}

function redactMapEntries(
  value: Map<unknown, unknown>,
  depth: number,
  ctx: RedactionContext
): unknown {
  const entries: unknown[] = [];
  ctx.entries += value.size;
  for (const [entryKey, entryValue] of value.entries()) {
    const redactedKey = redactSensitiveJsonValue(entryKey, depth + 1, ctx);
    const redactedValue =
      typeof entryKey === "string" && isSensitiveJsonKey(entryKey)
        ? REDACTED_SECRET
        : redactSensitiveJsonValue(entryValue, depth + 1, ctx);
    entries.push([redactedKey, redactedValue]);
  }
  return { _type: "Map", size: value.size, entries };
}

function redactPlainObject(
  value: object,
  depth: number,
  ctx: RedactionContext
): unknown {
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    // A Proxy whose `ownKeys` trap throws. Pino calls the log formatter with no
    // try/catch of its own, so anything that escapes here takes the process down
    // — the exact failure this module exists to prevent.
    return UNREADABLE_VALUE;
  }

  ctx.entries += keys.length;
  const normalizedKeys = normalizedKeySet(keys);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (
      isSensitiveJsonKey(key) ||
      isNameValuePairSecret(normalizeJsonKey(key), normalizedKeys)
    ) {
      result[key] = REDACTED_SECRET;
      continue;
    }
    let entryValue: unknown;
    try {
      entryValue = (value as Record<string, unknown>)[key];
    } catch {
      // A throwing getter.
      result[key] = UNREADABLE_VALUE;
      continue;
    }
    result[key] = redactSensitiveJsonValue(entryValue, depth + 1, ctx);
  }
  return result;
}

function redactSensitiveJsonValue(
  value: unknown,
  depth: number,
  ctx: RedactionContext
): unknown {
  if (value instanceof Date) {
    // `toISOString` throws RangeError on an invalid date, which inside pino's
    // formatter is a process-level crash rather than a bad log line.
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "string") {
    return redactSensitiveTextValue(value, ctx);
  }

  // Everything that is not an object or array leaves here, so the depth cap
  // below never truncates a scalar — only the structure wrapped around one.
  if (!value || typeof value !== "object") {
    return value;
  }

  if (value instanceof Error) {
    return redactError(value, depth, ctx);
  }

  if (depth >= ctx.maxDepth || ctx.entries >= ctx.maxEntries) {
    return TRUNCATED_BRANCH;
  }

  if (ctx.ancestors.has(value)) {
    ctx.circularHits += 1;
    return CIRCULAR_REFERENCE;
  }

  const memoisedByDepth = ctx.rendered.get(value);
  const memoised = memoisedByDepth?.get(depth);
  if (memoised) {
    // A memo hit saves the WALK but not the bytes: JSON has no syntax for a
    // reference, so this subtree is serialised again in full. It therefore
    // costs the budget exactly what rendering it cost.
    ctx.entries += memoised.entries;
    return memoised.result;
  }

  const circularHitsBefore = ctx.circularHits;
  const entriesBefore = ctx.entries;
  ctx.ancestors.add(value);
  let result: unknown;
  try {
    if (Array.isArray(value)) {
      ctx.entries += value.length;
      result = value.map((entry) =>
        redactSensitiveJsonValue(entry, depth + 1, ctx)
      );
    } else if (value instanceof Map) {
      result = redactMapEntries(value, depth, ctx);
    } else if (value instanceof Set) {
      ctx.entries += value.size;
      result = {
        _type: "Set",
        size: value.size,
        values: Array.from(value, (entry) =>
          redactSensitiveJsonValue(entry, depth + 1, ctx)
        ),
      };
    } else {
      result = redactPlainObject(value, depth, ctx);
    }
  } finally {
    // Removed on the way out so the guard describes the ANCESTOR PATH, not
    // every object visited: two siblings pointing at one shared object are not
    // a cycle and must both render. See MAX_LOG_REDACTION_DEPTH above.
    ctx.ancestors.delete(value);
  }

  // Only a rendering that never consulted the ancestor set is path-independent
  // and therefore safe to reuse. A subtree containing "[Circular]" means
  // something different depending on where it was reached from.
  if (ctx.circularHits === circularHitsBefore) {
    const byDepth = memoisedByDepth ?? new Map<number, MemoisedSubtree>();
    if (!memoisedByDepth) {
      ctx.rendered.set(value, byDepth);
    }
    byDepth.set(depth, { result, entries: ctx.entries - entriesBefore });
  }

  return result;
}

/**
 * Never throw out of a redactor. Pino calls `formatters.log` and Sentry calls
 * `beforeSend` with no try/catch of their own, so an exception here is an
 * unhandled crash raised from inside a logging call — the failure this module
 * was written to stop. A marker is a bad log line; a throw is a dead process.
 */
function redactSafely<T>(run: () => T, fallback: T): T {
  try {
    return run();
  } catch {
    return fallback;
  }
}

export function redactSensitiveText(value: string): string {
  return redactSafely(
    () => redactSensitiveTextValue(value, createLogContext()),
    REDACTION_FAILED
  );
}

/** The LOG and Sentry path: bounded depth, cycle-safe, never throws. */
export function redactSensitiveJson(value: unknown): unknown {
  return redactSafely(
    () => redactSensitiveJsonValue(value, 0, createLogContext()),
    REDACTION_FAILED
  );
}

/**
 * The STORED-or-DISPLAYED path: the same redaction rules without the log depth
 * cap. Use this for a value that is written to a database column or rendered to
 * an admin as the record itself — `sanitizeForJson` in `src/lib/xero-sync.ts`,
 * the admin Xero payload views, and the operation summaries built from them.
 * Those payloads are re-read and re-persisted by read-modify-write cycles, so a
 * truncation there is permanent and compounds with every pass.
 */
export function redactSensitiveRecord(value: unknown): unknown {
  return redactSafely(
    () => redactSensitiveJsonValue(value, 0, createRecordContext()),
    REDACTION_FAILED
  );
}

export function redactSensitiveQueryParams(value: unknown): unknown {
  return redactSafely(() => {
    const ctx = createLogContext();

    if (typeof value === "string") {
      return redactSensitiveTextValue(value, ctx);
    }

    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return redactSensitiveJsonValue(value, 0, ctx);
    }

    ctx.ancestors.add(value);
    try {
      return Object.fromEntries(
        Object.entries(value).map(([key, entryValue]) => [
          key,
          isSensitiveQueryKey(key)
            ? REDACTED_SECRET
            : redactSensitiveJsonValue(entryValue, 1, ctx),
        ])
      );
    } finally {
      ctx.ancestors.delete(value);
    }
  }, REDACTION_FAILED);
}

/**
 * Pretty-printed for an admin reading a stored payload, so it uses the
 * stored-record limits rather than the log cap: the value on screen is the
 * record, not a line about it.
 */
export function formatRedactedJson(value: unknown): string {
  return redactSafely(
    () => JSON.stringify(redactSensitiveRecord(value ?? null), null, 2),
    REDACTION_FAILED
  );
}
