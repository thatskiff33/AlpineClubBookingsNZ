import { describe, expect, it } from "vitest";

import {
  emailBodyHtmlToText,
  emailBodyHtmlToValidationText,
  plainTextToEmailBodyHtml,
  renderEmailBodyHtml,
  renderHtmlTemplateString,
  sanitiseEmailBodyHtml,
} from "@/lib/email-body-html";

/**
 * Rich email bodies (fork #38). The policy is the control: everything an
 * admin submits reduces to the allowlist, token VALUES can never inject
 * markup, and the derived text keeps every text-based rule meaningful.
 */

describe("sanitiseEmailBodyHtml", () => {
  it("keeps the editor vocabulary (styles normalised by the sanitiser)", () => {
    expect(
      sanitiseEmailBodyHtml(
        '<p style="text-align: center;"><b>Bold</b> <i>italic</i> <u>underlined</u></p><ul><li>one</li><li>two</li></ul>',
      ),
    ).toBe(
      '<p style="text-align:center"><b>Bold</b> <i>italic</i> <u>underlined</u></p><ul><li>one</li><li>two</li></ul>',
    );
  });

  it("strips scripts, handlers, images, links and colours to their text", () => {
    expect(
      sanitiseEmailBodyHtml(
        '<p onclick="x()"><script>alert(1)</script><a href="https://evil.example">click</a> <span style="color: red">red</span><img src=x onerror=alert(1)></p>',
      ),
    ).toBe("<p>click <span>red</span></p>");
  });

  it("drops disallowed style declarations but keeps allowed text-align", () => {
    expect(
      sanitiseEmailBodyHtml(
        '<div style="text-align: right; font-size: 60px; position: fixed;">x</div>',
      ),
    ).toBe('<div style="text-align:right">x</div>');
  });

  it("keeps alignment on headings and list items too (drift lens 4)", () => {
    // The toolbar offers alignment on whatever block holds the caret; a
    // centred heading must not save successfully and arrive left-aligned.
    expect(
      sanitiseEmailBodyHtml(
        '<h2 style="text-align:center">Booking Confirmed</h2><ul><li style="text-align:right">one</li></ul>',
      ),
    ).toBe(
      '<h2 style="text-align:center">Booking Confirmed</h2><ul><li style="text-align:right">one</li></ul>',
    );
  });

  it("leaves {{token}} markers untouched as text", () => {
    expect(sanitiseEmailBodyHtml("<p>Hi {{firstName}}</p>")).toBe(
      "<p>Hi {{firstName}}</p>",
    );
  });

  it("repairs a token split across formatting tags (review H2) — the whole token formats", () => {
    // A half-selected Ctrl-B: without the repair, extraction JOINS the token
    // (validation approves it) while the render regex cannot see through the
    // tags and drops it silently.
    expect(sanitiseEmailBodyHtml("<p>Hi <b>{{first</b>Name}}</p>")).toBe(
      "<p>Hi <b>{{firstName}}</b></p>",
    );
  });
});

describe("renderHtmlTemplateString", () => {
  it("substitutes tokens with HTML-escaped values", () => {
    expect(
      renderHtmlTemplateString("<p>Hi {{firstName}}</p>", {
        firstName: 'Sam <script>alert(1)</script> & "co"',
      }),
    ).toBe("<p>Hi Sam &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;co&quot;</p>");
  });

  it("keeps a multi-line pre-composed block value's line structure as <br>", () => {
    expect(
      renderHtmlTemplateString("<p>{{paymentOutcome}}</p>", {
        paymentOutcome: "Total Paid: $300.00\nPayment has been processed successfully.",
      }),
    ).toBe(
      "<p>Total Paid: $300.00<br>Payment has been processed successfully.</p>",
    );
  });

  it("renders absent and null values as nothing, like the plain path", () => {
    expect(
      renderHtmlTemplateString("<p>{{missing}}{{empty}}</p>", { empty: null }),
    ).toBe("<p></p>");
  });
});

describe("renderEmailBodyHtml", () => {
  it("stamps the mail-client spacing styles, preserving the author's alignment", () => {
    const html = renderEmailBodyHtml(
      '<p style="text-align:center">Hi</p><ul><li>one</li></ul>',
    );
    expect(html).toContain('style="margin:0 0 12px 0;line-height:1.6;text-align:center"');
    expect(html).toContain('<ul style="margin:0 0 12px 0;padding-left:22px">');
    expect(html).toContain('<li style="margin:0 0 4px 0">one</li>');
  });

  it("is a defence-in-depth pass — markup smuggled past storage still dies here", () => {
    expect(renderEmailBodyHtml('<p><img src=x onerror=alert(1)>ok</p>')).toBe(
      '<p style="margin:0 0 12px 0;line-height:1.6">ok</p>',
    );
  });
});

describe("plainTextToEmailBodyHtml", () => {
  it("upgrades the first block to the heading, the rest to paragraphs, escaped", () => {
    // The plain path renders the first block through heading(); the upgrade
    // preserves that so a no-op re-save keeps its heading (review M5).
    expect(
      plainTextToEmailBodyHtml("Heading\n\nLine one\nLine <two>\n\nBye"),
    ).toBe("<h2>Heading</h2><p>Line one<br>Line &lt;two&gt;</p><p>Bye</p>");
  });

  it("round-trips entity-bearing text losslessly (review M4)", () => {
    const text = 'Tom & Jerry\n\ngear <5kg and "quotes" & more';
    expect(emailBodyHtmlToText(plainTextToEmailBodyHtml(text))).toBe(text);
  });

  it("round-trips: extracting the upgrade returns the original text", () => {
    const text =
      "Booking Confirmed\n\nHi {{firstName}}, your booking is confirmed.\nCheck-in: {{checkIn}}\n\nSee you soon.";
    expect(emailBodyHtmlToText(plainTextToEmailBodyHtml(text))).toBe(text);
  });
});

describe("emailBodyHtmlToText", () => {
  it("keeps block structure as line structure, tokens intact — list items carry the text/plain '- ' marker", () => {
    expect(
      emailBodyHtmlToText(
        "<p>Hi <b>{{firstName}}</b></p><ul><li>one</li><li>two</li></ul><p>Bye</p>",
      ),
    ).toBe("Hi {{firstName}}\n\n- one\n- two\nBye");
  });

  it("the VALIDATION form is identical minus the synthetic list marker", () => {
    // The marker is injected by the extraction, so validation must not read
    // it as an authored sign in front of a sign-carrying token (ultrareview
    // nit) — while every word both rules judge stays present.
    expect(
      emailBodyHtmlToValidationText(
        "<p>Hi <b>{{firstName}}</b></p><ul><li>{{promoSummary}}</li><li>two</li></ul><p>Bye</p>",
      ),
    ).toBe("Hi {{firstName}}\n\n{{promoSummary}}\ntwo\nBye");
  });
});

/**
 * The token-repair strip inside `{{…}}` (#3144).
 *
 * CodeQL flagged the old `span.replace(/<[^<>]*>/g, "")` at high severity as
 * incomplete multi-character sanitization. It was a false positive — the strip
 * never has the last word, because `sanitiseEmailBodyHtml` re-sanitises
 * whenever the repair changed anything — but it was still a hand-rolled tag
 * matcher standing next to a real parser, so the strip now uses the parser.
 *
 * These tests assert the INVARIANT, not the implementation: nothing that can
 * execute ever leaves this function. That is what a future refactor of the
 * repair needs to keep true, whichever way it strips tags.
 */
describe("sanitiseEmailBodyHtml never emits live markup", () => {
  const LIVE_MARKUP = /<script|<svg|<img|<iframe|on[a-z]+\s*=/i;

  // Each of these is shaped to survive a SINGLE pass over `<…>`: the strip
  // removes the inner match and the remaining characters re-form a tag.
  it.each([
    ["nested script that re-forms after one pass", "{{<<script>script>alert(1)<</script>/script>}}"],
    ["tag split by an allowlisted tag", "{{a<scr<b></b>ipt>alert(1)</script>}}"],
    ["angle bracket rejoined across a strip", "{{<<b>script>alert(1)</script>}}"],
    ["event handler on an image", "{{<img src=x onerror=alert(1)>}}"],
    ["event handler on an svg", "{{<svg/onload=alert(1)>}}"],
    ["empty allowlisted tags between the halves", "{{<<i></i>script>alert(1)}}"],
    ["split across two spans", "{{ <scr<span>ipt>alert(1)</scr</span>ipt> }}"],
    ["braces closed between the halves", "{{<}}{{script>alert(1)}}"],
    ["NUL byte inside the tag name", "{{<sc\u0000ript>alert(1)</script>}}"],
    ["pre-escaped entities inside a token", "{{&lt;script&gt;alert(1)&lt;/script&gt;}}"],
    ["pre-escaped entities outside a token", "&lt;script&gt;alert(1)&lt;/script&gt;"],
    ["the real split-token case this repair exists for", "<b>{{first</b>Name}}"],
  ])("neutralises %s", (_name, attack) => {
    expect(sanitiseEmailBodyHtml(attack)).not.toMatch(LIVE_MARKUP);
  });

  it("neutralises every combination of allowlisted tag and hostile payload", () => {
    // A generated corpus rather than a handful of examples: the failure mode
    // this guards against is a payload shape nobody thought to write down.
    const tags = ["b", "strong", "i", "em", "u", "span", "li", "p", "div", "h2", "br"];
    const payloads = [
      "first", "firstName", "a&b", "a<b", "<", ">", "<<", "x</b>y", "&lt;script&gt;",
      "<script>alert(1)</script>", "<img src=x onerror=alert(1)>", "<svg/onload=alert(1)>",
      "<scr<b></b>ipt>", "<<b>script>", "  spaced  ", "", "&amp;", "&nbsp;", "\u00a0", "a\nb",
    ];

    let checked = 0;
    for (const payload of payloads) {
      const inputs = [
        `{{${payload}}}`,
        `text {{${payload}}} text`,
        `<p>{{${payload}}}</p>`,
        `{{${payload}}}{{${payload}}}`,
        `{{{{${payload}}}}}`,
        `{{${payload}`,
        `${payload}}}`,
        ...tags.flatMap((tag) => [
          `<${tag}>{{${payload}</${tag}>rest}}`,
          `{{<${tag}>${payload}</${tag}>}}`,
          `<${tag}>{{${payload}}}</${tag}>`,
        ]),
      ];
      for (const input of inputs) {
        checked += 1;
        expect(sanitiseEmailBodyHtml(input), `live markup from: ${input}`).not.toMatch(LIVE_MARKUP);
      }
    }

    // Guard the guard: a corpus that silently stopped generating would pass
    // this suite while testing nothing.
    expect(checked).toBe(800);
  });

  it("still repairs a token split across tags, which is why the strip exists at all", () => {
    // The security assertions above are all satisfied by returning "", so the
    // repair's actual job has to be pinned here or they are vacuous.
    expect(sanitiseEmailBodyHtml("<b>{{first</b>Name}}")).toBe("<b>{{firstName}}</b>");
  });
});
