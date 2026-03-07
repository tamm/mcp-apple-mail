import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mailboxFromUrl,
  accountUuidFromUrl,
  mboxPathFromUrl,
  markdownToHtml,
} from "../index.js";

describe("mailboxFromUrl", () => {
  it("extracts INBOX from imap URL", () => {
    assert.equal(
      mailboxFromUrl("imap://A1B2C3D4-E5F6-7890-ABCD-EF1234567890/INBOX"),
      "INBOX"
    );
  });

  it("URL-decodes Gmail All Mail", () => {
    assert.equal(
      mailboxFromUrl("imap://A1B2C3D4-E5F6-7890-ABCD-EF1234567890/%5BGmail%5D/All%20Mail"),
      "All Mail"
    );
  });

  it("URL-decodes Sent Messages", () => {
    assert.equal(
      mailboxFromUrl("imap://A1B2C3D4-E5F6-7890-ABCD-EF1234567890/Sent%20Messages"),
      "Sent Messages"
    );
  });

  it("handles local:// scheme", () => {
    assert.equal(
      mailboxFromUrl("local://A1B2C3D4-E5F6-7890-ABCD-EF1234567890/Drafts"),
      "Drafts"
    );
  });
});

describe("accountUuidFromUrl", () => {
  it("extracts UUID from standard imap URL", () => {
    assert.equal(
      accountUuidFromUrl("imap://A1B2C3D4-E5F6-7890-ABCD-EF1234567890/INBOX"),
      "A1B2C3D4-E5F6-7890-ABCD-EF1234567890"
    );
  });

  it("extracts UUID from local:// scheme", () => {
    assert.equal(
      accountUuidFromUrl("local://DEADBEEF-1234-5678-9ABC-DEF012345678/Drafts"),
      "DEADBEEF-1234-5678-9ABC-DEF012345678"
    );
  });

  it("returns null for URL with no UUID match", () => {
    assert.equal(accountUuidFromUrl("not-a-valid-url"), null);
  });

  it("returns null for empty string", () => {
    assert.equal(accountUuidFromUrl(""), null);
  });

  it("handles lowercase hex in UUID", () => {
    assert.equal(
      accountUuidFromUrl("imap://a1b2c3d4-e5f6-7890-abcd-ef1234567890/INBOX"),
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
    );
  });
});

describe("mboxPathFromUrl", () => {
  it("maps simple INBOX path", () => {
    assert.deepEqual(
      mboxPathFromUrl("imap://A1B2C3D4-E5F6-7890-ABCD-EF1234567890/INBOX"),
      ["INBOX.mbox"]
    );
  });

  it("maps Gmail nested path with URL decoding", () => {
    assert.deepEqual(
      mboxPathFromUrl("imap://A1B2C3D4-E5F6-7890-ABCD-EF1234567890/%5BGmail%5D/All%20Mail"),
      ["[Gmail].mbox", "All Mail.mbox"]
    );
  });

  it("maps Sent Messages", () => {
    assert.deepEqual(
      mboxPathFromUrl("imap://A1B2C3D4-E5F6-7890-ABCD-EF1234567890/Sent%20Messages"),
      ["Sent Messages.mbox"]
    );
  });

  it("returns null when no path segments", () => {
    assert.equal(
      mboxPathFromUrl("imap://A1B2C3D4-E5F6-7890-ABCD-EF1234567890/"),
      null
    );
  });

  it("returns null for invalid URL", () => {
    assert.equal(mboxPathFromUrl("not-a-url"), null);
  });
});

describe("markdownToHtml (extended)", () => {
  it("converts numbered lists to li elements", () => {
    const r = markdownToHtml("1. first\n2. second\n3. third");
    assert.ok(r.includes("<li>first</li>"));
    assert.ok(r.includes("<li>second</li>"));
    assert.ok(r.includes("<li>third</li>"));
    assert.ok(r.includes("<ul>"));
  });

  it("combines bold and italic", () => {
    const r = markdownToHtml("***bold and italic***");
    assert.ok(r.includes("<strong>") || r.includes("<em>"));
  });

  it("escapes HTML entities", () => {
    const r = markdownToHtml("x < y & a > b");
    assert.ok(r.includes("&lt;"));
    assert.ok(r.includes("&amp;"));
    assert.ok(r.includes("&gt;"));
    assert.ok(!r.includes(" < "));
    assert.ok(!r.includes(" > "));
  });

  it("handles empty input", () => {
    const r = markdownToHtml("");
    assert.ok(r.includes("font-family"));
  });

  it("splits multiple paragraphs", () => {
    const r = markdownToHtml("First para\n\nSecond para");
    assert.ok(r.includes("<p>First para</p>"));
    assert.ok(r.includes("<p>Second para</p>"));
  });

  it("does not convert underscores inside words", () => {
    const r = markdownToHtml("some_variable_name");
    assert.ok(!r.includes("<em>"));
    assert.ok(r.includes("some_variable_name"));
  });
});
