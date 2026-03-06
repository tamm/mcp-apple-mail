import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  stripSignature,
  stripQuotedReplies,
  cleanBody,
  markdownToHtml,
  escapeForAppleScript,
  escapeForJxa,
} from "../index.js";

describe("stripSignature", () => {
  it("strips standard -- delimiter", () => {
    const input = "Hello there\n-- \nJohn Doe\nCEO";
    assert.equal(stripSignature(input), "Hello there");
  });

  it("strips Sent from my iPhone", () => {
    const input = "Hey mate\n\nSent from my iPhone";
    assert.equal(stripSignature(input), "Hey mate");
  });

  it("strips Sent from my iPad", () => {
    const input = "Hey mate\n\nSent from my iPad";
    assert.equal(stripSignature(input), "Hey mate");
  });

  it("strips Get Outlook for iOS", () => {
    const input = "Hey mate\n\nGet Outlook for iOS";
    assert.equal(stripSignature(input), "Hey mate");
  });

  it("returns text unchanged when no signature", () => {
    const input = "Just a normal message\nWith two lines";
    assert.equal(stripSignature(input), "Just a normal message\nWith two lines");
  });

  it("returns empty for empty string", () => {
    assert.equal(stripSignature(""), "");
  });
});

describe("stripQuotedReplies", () => {
  it("strips On date wrote pattern", () => {
    const input = "My reply\n\nOn Mon, Jan 1, 2026 at 10:00 AM John wrote:\n> old stuff";
    assert.equal(stripQuotedReplies(input), "My reply");
  });

  it("strips Outlook From/Sent block", () => {
    const input = "My reply\n\nFrom: Someone\nSent: Monday\nTo: Me\n\nOld content";
    assert.equal(stripQuotedReplies(input), "My reply");
  });

  it("strips trailing > quoted lines", () => {
    const input = "My reply\n\n> quoted line 1\n> quoted line 2";
    assert.equal(stripQuotedReplies(input), "My reply");
  });

  it("strips forwarded message delimiter", () => {
    const input = "Check this out\n\n---------- Forwarded message ----------\nFrom: someone";
    assert.equal(stripQuotedReplies(input), "Check this out");
  });

  it("returns text unchanged when no quotes", () => {
    const input = "Just a normal message";
    assert.equal(stripQuotedReplies(input), "Just a normal message");
  });

  it("returns empty for empty string", () => {
    assert.equal(stripQuotedReplies(""), "");
  });
});

describe("cleanBody", () => {
  it("strips both signature and quoted replies", () => {
    const input =
      "My reply\n-- \nJohn\n\nOn Mon, Jan 1, 2026 at 10:00 AM Someone wrote:\n> hi";
    const result = cleanBody(input);
    assert.equal(result, "My reply");
  });
});

describe("markdownToHtml", () => {
  it("converts bold", () => {
    const result = markdownToHtml("**bold text**");
    assert.ok(result.includes("<strong>bold text</strong>"));
  });

  it("converts italic", () => {
    const result = markdownToHtml("*italic text*");
    assert.ok(result.includes("<em>italic text</em>"));
  });

  it("converts h1", () => {
    const result = markdownToHtml("# Heading");
    assert.ok(result.includes("<h1>Heading</h1>"));
  });

  it("converts h2", () => {
    const result = markdownToHtml("## Heading");
    assert.ok(result.includes("<h2>Heading</h2>"));
  });

  it("converts h3", () => {
    const result = markdownToHtml("### Heading");
    assert.ok(result.includes("<h3>Heading</h3>"));
  });

  it("converts list items", () => {
    const result = markdownToHtml("- item one\n- item two");
    assert.ok(result.includes("<li>item one</li>"));
    assert.ok(result.includes("<li>item two</li>"));
    assert.ok(result.includes("<ul>"));
  });

  it("converts links", () => {
    const result = markdownToHtml("[click](https://example.com)");
    assert.ok(result.includes('<a href="https://example.com">click</a>'));
  });

  it("converts inline code", () => {
    const result = markdownToHtml("`some code`");
    assert.ok(result.includes("<code>some code</code>"));
  });

  it("passes plain text through wrapped in p tags", () => {
    const result = markdownToHtml("hello world");
    assert.equal(result, "<p>hello world</p>");
  });
});

describe("escapeForAppleScript", () => {
  it("escapes backslashes", () => {
    assert.equal(escapeForAppleScript("a\\b"), "a\\\\b");
  });

  it("escapes double quotes", () => {
    assert.equal(escapeForAppleScript('say "hi"'), 'say \\"hi\\"');
  });

  it("escapes newlines", () => {
    assert.equal(escapeForAppleScript("line1\nline2"), "line1\\nline2");
  });

  it("escapes carriage returns", () => {
    assert.equal(escapeForAppleScript("line1\rline2"), "line1\\rline2");
  });

  it("returns empty for empty string", () => {
    assert.equal(escapeForAppleScript(""), "");
  });
});

describe("escapeForJxa", () => {
  it("returns JSON.stringify result", () => {
    assert.equal(escapeForJxa("hello"), '"hello"');
  });

  it("escapes special characters via JSON.stringify", () => {
    assert.equal(escapeForJxa('say "hi"'), '"say \\"hi\\""');
  });
});
