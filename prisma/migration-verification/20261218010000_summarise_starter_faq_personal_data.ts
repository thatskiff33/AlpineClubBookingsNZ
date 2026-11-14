import type { DataMigrationVerification } from "./types";

/**
 * Follow-up to #4914 — the starter FAQ's personal-data answer.
 *
 * The migration chain plants the starter `faq` PageContent row; #1945 last
 * rewrote it. Its "What personal data does the club hold about me?" answer
 * named fewer categories than the club holds (no addresses, photo, dietary
 * information, gender, occupation, title, family or membership history). This
 * migration replaces the whole row's `contentHtml` with the corrected starter
 * copy, but only where the row still equals the exact #1945 text, the rule
 * #4031 and #4914 follow. An FAQ an admin edited, even by appending a line,
 * keeps its own text byte for byte.
 *
 * No seed for the first case: the pre-state is whatever the migration chain
 * itself produces.
 */
const OLD_ANSWER =
  "<p>The club holds your name, email address, phone number, date of birth, booking history, payment records, and chore assignments.";
const NEW_MARKER = 'This is a summary. Section 2 of our <a href="/privacy">Privacy Policy</a> lists everything the club collects';
const CLUB_NOTE = "<p>Ask the hut warden about our winter roster.</p>";

const answerState = `
  SELECT
    position('${OLD_ANSWER}' IN "contentHtml") > 0 AS "oldAnswer",
    position('${NEW_MARKER}' IN "contentHtml") > 0 AS "summary"
  FROM "PageContent" WHERE "slug" = 'faq'
`;

const verification: DataMigrationVerification = {
  migration: "20261218010000_summarise_starter_faq_personal_data",
  intent:
    "Replace the untouched starter FAQ with the copy that summarises every category of personal data and points to section 2 of the Privacy Policy, and leave an FAQ a club edited untouched.",
  idempotentReRun: true,
  cases: [
    {
      name: "a fresh install, carrying the starter FAQ the migration chain planted",
      seed: "",
      expectations: [
        {
          claim: "the short personal-data list is gone; the answer summarises and points to section 2 of the Privacy Policy",
          sql: answerState,
          rows: [{ oldAnswer: false, summary: true }],
        },
        {
          claim: "the FAQ row itself survives — the update rewrites a field, it never deletes the page",
          sql: `SELECT count(*)::int AS "rows" FROM "PageContent" WHERE "slug" = 'faq'`,
          rows: [{ rows: 1 }],
        },
      ],
    },
    {
      name: "a club that edited its FAQ by appending its own note",
      seed: `
        UPDATE "PageContent"
        SET "contentHtml" = "contentHtml" || '${CLUB_NOTE}'
        WHERE "slug" = 'faq';
      `,
      expectations: [
        {
          claim: "the club's own FAQ is untouched — equality on the whole previous text, so an edited page never matches",
          sql: answerState,
          rows: [{ oldAnswer: true, summary: false }],
        },
        {
          claim: "the club's own addition is still there",
          sql: `SELECT position('${CLUB_NOTE}' IN "contentHtml") > 0 AS "kept" FROM "PageContent" WHERE "slug" = 'faq'`,
          rows: [{ kept: true }],
        },
      ],
    },
    {
      name: "a club that edited its FAQ by adding its own note at the top",
      seed: `
        UPDATE "PageContent"
        SET "contentHtml" = '${CLUB_NOTE}' || "contentHtml"
        WHERE "slug" = 'faq';
      `,
      expectations: [
        {
          claim: "an FAQ with text added before the starter copy is untouched — the guard is equality, not a suffix match",
          sql: answerState,
          rows: [{ oldAnswer: true, summary: false }],
        },
      ],
    },
  ],
  mutants: [
    {
      name: "invert the WHERE (= becomes <>)",
      harm:
        "Rewrites every edited FAQ with the starter copy and leaves the untouched starter FAQ still telling members less than the club holds.",
      find: `AND "contentHtml" = $previous$`,
      replace: `AND "contentHtml" <> $previous$`,
    },
    {
      name: "drop the value guard, keeping only the slug",
      harm:
        "Overwrites every club's FAQ, including answers an admin wrote for their own club — silent loss of a club's page.",
      find: `AND "contentHtml" = $previous$`,
      replace: `AND "contentHtml" LIKE '%' OR "contentHtml" = $previous$`,
    },
    {
      name: "match pages that merely end with the starter text",
      harm:
        "Overwrites a club FAQ that added its own text above the starter copy, losing the club's addition.",
      find: `AND "contentHtml" = $previous$`,
      replace: `AND "contentHtml" LIKE '%' || $previous$`,
    },
  ],
};

export default verification;
