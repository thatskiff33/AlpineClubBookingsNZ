import { describe, expect, it } from "vitest";

import { htmlToPlainText } from "@/lib/email-text";

describe("review regression: HTML-to-text sanitization", () => {
  it("strips malformed script blocks with loose closing tags", () => {
    const text = htmlToPlainText(
      'Hello<script type="text/javascript">alert("x")</script >World'
    );

    expect(text).not.toContain('alert("x")');
    expect(text).not.toContain("<script");
    expect(text).toContain("Hello");
    expect(text).toContain("World");
  });

  it("does not leave dangling malformed script prefixes in the output", () => {
    const text = htmlToPlainText("Hello <script alert(1) World");

    expect(text).not.toContain("<script");
    expect(text).toContain("Hello");
    expect(text).toContain("World");
  });

  it("does not decode entity-encoded script tags into tag-shaped text", () => {
    const text = htmlToPlainText(
      "Intro &lt;script&gt;alert(1)&lt;/script&gt; Outro"
    );

    expect(text).not.toContain("<script>");
    expect(text).not.toContain("</script>");
    expect(text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("keeps double-escaped script tags escaped after plain-text conversion", () => {
    const text = htmlToPlainText(
      "Intro &amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt; Outro"
    );

    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("preserves anchor hrefs without trusting nested tag markup", () => {
    const text = htmlToPlainText(
      '<p>Open <a href="https://example.test/reset?token=abc"><strong>Reset</strong></a></p>'
    );

    expect(text).toBe("Open Reset: https://example.test/reset?token=abc");
  });
});
