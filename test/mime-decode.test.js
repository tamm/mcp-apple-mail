import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeMimeWords, decodeQuotedPrintable } from "../index.js";

describe("decodeMimeWords", () => {
  it("decodes Base64 UTF-8", () => {
    assert.equal(decodeMimeWords("=?UTF-8?B?5pel5pys6Kqe?="), "日本語");
  });

  it("decodes Base64 with padding", () => {
    assert.equal(decodeMimeWords("=?UTF-8?B?SGVsbG8=?="), "Hello");
  });

  it("decodes Q-encoded with underscores as spaces", () => {
    assert.equal(decodeMimeWords("=?UTF-8?Q?Hello_World?="), "Hello World");
  });

  it("decodes Q-encoded multi-byte UTF-8", () => {
    assert.equal(decodeMimeWords("=?UTF-8?Q?=C3=A9l=C3=A8ve?="), "élève");
  });

  it("decodes Q-encoded with mixed literal and encoded", () => {
    assert.equal(decodeMimeWords("=?UTF-8?Q?caf=C3=A9?="), "café");
  });

  it("collapses whitespace between adjacent encoded words", () => {
    assert.equal(
      decodeMimeWords("=?UTF-8?B?5pel?= =?UTF-8?B?5pys?="),
      "日本"
    );
  });

  it("collapses multiple spaces between adjacent encoded words", () => {
    assert.equal(
      decodeMimeWords("=?UTF-8?Q?Hello?=   =?UTF-8?Q?World?="),
      "HelloWorld"
    );
  });

  it("preserves plain text around encoded words", () => {
    assert.equal(
      decodeMimeWords("Re: =?UTF-8?Q?caf=C3=A9?= order"),
      "Re: café order"
    );
  });

  it("handles mixed plain and multiple encoded words", () => {
    assert.equal(
      decodeMimeWords("Fwd: =?UTF-8?B?SGVsbG8=?= there"),
      "Fwd: Hello there"
    );
  });

  it("decodes ISO-8859-1 Base64", () => {
    // "café" in ISO-8859-1: 63 61 66 e9
    const encoded = Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString("base64");
    assert.equal(decodeMimeWords(`=?ISO-8859-1?B?${encoded}?=`), "café");
  });

  it("handles lowercase encoding flag b", () => {
    assert.equal(decodeMimeWords("=?UTF-8?b?SGVsbG8=?="), "Hello");
  });

  it("handles lowercase encoding flag q", () => {
    assert.equal(decodeMimeWords("=?UTF-8?q?Hello_World?="), "Hello World");
  });

  it("handles lowercase charset", () => {
    assert.equal(decodeMimeWords("=?utf-8?Q?test?="), "test");
  });

  it("returns plain text unchanged", () => {
    assert.equal(decodeMimeWords("Just a plain subject"), "Just a plain subject");
  });

  it("returns empty string unchanged", () => {
    assert.equal(decodeMimeWords(""), "");
  });

  it("handles malformed encoded word (missing closing)", () => {
    const input = "=?UTF-8?Q?broken";
    assert.equal(decodeMimeWords(input), "=?UTF-8?Q?broken");
  });

  it("handles encoded word with empty text section", () => {
    assert.equal(decodeMimeWords("=?UTF-8?Q??="), "");
  });

  it("decodes Q-encoded with equals sign", () => {
    assert.equal(decodeMimeWords("=?UTF-8?Q?a=3Db?="), "a=b");
  });

  it("decodes multiple separate encoded words with plain text between", () => {
    assert.equal(
      decodeMimeWords("=?UTF-8?Q?Hello?= plain =?UTF-8?Q?World?="),
      "Hello plain World"
    );
  });

  it("handles real-world long subject with emoji", () => {
    // 🎉 in UTF-8 is F0 9F 8E 89
    assert.equal(
      decodeMimeWords("=?UTF-8?Q?=F0=9F=8E=89_Party?="),
      "\u{1F389} Party"
    );
  });

  it("decodes Base64 UTF-8 with multi-byte chars", () => {
    // "über" in UTF-8 base64
    const encoded = Buffer.from("über", "utf-8").toString("base64");
    assert.equal(decodeMimeWords(`=?UTF-8?B?${encoded}?=`), "über");
  });
});

describe("decodeQuotedPrintable", () => {
  it("decodes simple encoded bytes", () => {
    assert.equal(decodeQuotedPrintable("caf=C3=A9"), "café");
  });

  it("removes soft line breaks (LF)", () => {
    assert.equal(decodeQuotedPrintable("hel=\nlo"), "hello");
  });

  it("removes soft line breaks (CRLF)", () => {
    assert.equal(decodeQuotedPrintable("hel=\r\nlo"), "hello");
  });

  it("passes through plain ASCII unchanged", () => {
    assert.equal(decodeQuotedPrintable("Hello World"), "Hello World");
  });

  it("decodes mixed literal and encoded", () => {
    assert.equal(decodeQuotedPrintable("100=25 done"), "100% done");
  });

  it("decodes lowercase hex", () => {
    assert.equal(decodeQuotedPrintable("caf=c3=a9"), "café");
  });

  it("handles multi-byte UTF-8 sequences", () => {
    // "日" is E6 97 A5 in UTF-8
    assert.equal(decodeQuotedPrintable("=E6=97=A5"), "日");
  });

  it("handles equals sign encoding", () => {
    assert.equal(decodeQuotedPrintable("a=3Db"), "a=b");
  });

  it("returns empty string unchanged", () => {
    assert.equal(decodeQuotedPrintable(""), "");
  });

  it("handles soft break mid-encoded-sequence", () => {
    assert.equal(decodeQuotedPrintable("caf=\n=C3=A9"), "café");
  });

  it("handles Windows-style soft breaks in body", () => {
    assert.equal(
      decodeQuotedPrintable("This is a long line that=\r\n continues here"),
      "This is a long line that continues here"
    );
  });

  it("preserves real line breaks (not soft)", () => {
    assert.equal(
      decodeQuotedPrintable("line1\nline2"),
      "line1\nline2"
    );
  });

  it("handles multiple encoded bytes in sequence", () => {
    // "über" -> =C3=BC + ber
    assert.equal(decodeQuotedPrintable("=C3=BCber"), "über");
  });

  it("handles emoji encoding", () => {
    // 🎉 is F0 9F 8E 89
    assert.equal(decodeQuotedPrintable("=F0=9F=8E=89"), "\u{1F389}");
  });
});
