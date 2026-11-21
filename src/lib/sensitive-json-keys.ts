/** Exact normalized keys redacted from logs and stored diagnostic payloads. */
export const SENSITIVE_JSON_KEYS = new Set([
  "authorization",
  "cookie",
  "setcookie",
  // The AI app connection's internal sign-in header, `x-mcp-principal`
  // (ALP-653). It stands in for the cookie on a loopback call.
  "xmcpprincipal",
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
