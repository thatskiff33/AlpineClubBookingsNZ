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
});
