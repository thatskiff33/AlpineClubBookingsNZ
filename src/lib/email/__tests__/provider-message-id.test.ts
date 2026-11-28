import { describe, expect, it } from "vitest";

import {
  MAX_PROVIDER_MESSAGE_ID_LENGTH,
  mailServiceForDeliveryMode,
  sentEmailIdsFromResult,
  type MailService,
} from "@/lib/email/provider-message-id";

const providerMessageIdFromSendResult = (service: MailService | null, result: { messageId?: unknown; response?: unknown }) =>
  sentEmailIdsFromResult(service, result).providerMessageId;

// #5469: which id the mail server gave an email, read from its reply to the
// send. SES answers `250 Ok <MessageID>` (AWS, "Amazon SES SMTP issues").
describe("the mail server's id for a sent email (#5469)", () => {
  it("MUTATION: only the configured SES mode is a recognised mail service", () => {
    expect(mailServiceForDeliveryMode("aws-ses")).toBe("aws-ses");
    expect(mailServiceForDeliveryMode("smtp-relay")).toBeNull();
    expect(mailServiceForDeliveryMode("local-capture")).toBeNull();
    expect(mailServiceForDeliveryMode("invalid")).toBeNull();
  });

  it("MUTATION: reads SES's id from its reply to an accepted message", () => {
    expect(
      providerMessageIdFromSendResult("aws-ses", { response: "250 Ok 0100018c5f2a3b4c-1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d-000000\r\n" }),
    ).toBe("0100018c5f2a3b4c-1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d-000000");
  });

  it.each([
    ["another server's reply shape", "250 2.0.0 Ok: queued as 4ABC123"],
    ["a refusal", "554 Message rejected: Email address is not verified."],
    ["a bare acceptance", "250 Ok"],
    ["an id with extra words", "250 Ok 0100-abc-000000 and more"],
    ["an id that is not hex groups", "250 Ok not-an-id"],
    ["an id with markup", "250 Ok 0100-abc<script>-000000"],
  ])("MUTATION: yields no id for %s from SES", (_label, response) => {
    expect(providerMessageIdFromSendResult("aws-ses", { response })).toBeNull();
  });

  it("MUTATION: stores the id lower-cased, as SES's notifications write it", () => {
    expect(providerMessageIdFromSendResult("aws-ses", { response: "250 Ok 0100ABC-DEF-000000" })).toBe("0100abc-def-000000");
  });

  it("MUTATION: stores nothing for an id longer than the cap, so the row's write cannot fail on it", () => {
    const longest = `0100-${"a".repeat(MAX_PROVIDER_MESSAGE_ID_LENGTH - 5)}`;
    expect(providerMessageIdFromSendResult("aws-ses", { response: `250 Ok ${longest}` })).toBe(longest);
    expect(providerMessageIdFromSendResult("aws-ses", { response: `250 Ok ${longest}a` })).toBeNull();
    expect(providerMessageIdFromSendResult("aws-ses", { response: `250 Ok 0100-${"a".repeat(100_000)}` })).toBeNull();
  });

  it("MUTATION: yields no id for a server the app does not recognise, whatever its reply", () => {
    expect(providerMessageIdFromSendResult(null, { response: "250 Ok 0100-abc-000000" })).toBeNull();
  });

  it("keeps the mail library's Message-ID beside the server's id", () => {
    expect(sentEmailIdsFromResult("aws-ses", { messageId: "<m@club.example.test>", response: "250 Ok 0100-a-000000" })).toEqual({
      messageId: "<m@club.example.test>",
      providerMessageId: "0100-a-000000",
    });
    expect(sentEmailIdsFromResult(null, { messageId: "" })).toEqual({ messageId: null, providerMessageId: null });
  });

  it("yields no id when the send result has no reply", () => {
    expect(providerMessageIdFromSendResult("aws-ses", {})).toBeNull();
    expect(providerMessageIdFromSendResult("aws-ses", { response: 250 })).toBeNull();
  });
});
