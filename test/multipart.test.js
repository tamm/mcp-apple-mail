import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractTextFromMultipart } from "../index.js";

describe("extractTextFromMultipart", () => {
  it("prefers text/plain when both plain and html parts exist", () => {
    const body = [
      "--boundary123",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Hello plain",
      "--boundary123",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<b>Hello html</b>",
      "--boundary123--",
    ].join("\r\n");
    const ct = 'multipart/alternative; boundary="boundary123"';
    assert.equal(extractTextFromMultipart(body, ct), "Hello plain");
  });

  it("falls back to htmlToText when only HTML part exists", () => {
    const body = [
      "--myboundary",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>Hello from HTML</p>",
      "--myboundary--",
    ].join("\r\n");
    const ct = "multipart/alternative; boundary=myboundary";
    assert.equal(extractTextFromMultipart(body, ct), "Hello from HTML");
  });

  it("handles nested multipart/alternative inside multipart/mixed", () => {
    const inner = [
      "--inner",
      "Content-Type: text/plain",
      "",
      "Nested plain text",
      "--inner",
      "Content-Type: text/html",
      "",
      "<b>Nested html</b>",
      "--inner--",
    ].join("\r\n");
    const body = [
      "--outer",
      "Content-Type: multipart/alternative; boundary=inner",
      "",
      inner,
      "--outer",
      "Content-Type: application/pdf",
      "Content-Disposition: attachment",
      "",
      "binary-data-here",
      "--outer--",
    ].join("\r\n");
    const ct = "multipart/mixed; boundary=outer";
    assert.equal(extractTextFromMultipart(body, ct), "Nested plain text");
  });

  it("handles boundary with quotes", () => {
    const body = [
      "--abc",
      "Content-Type: text/plain",
      "",
      "Quoted boundary",
      "--abc--",
    ].join("\r\n");
    const ct = 'multipart/mixed; boundary="abc"';
    assert.equal(extractTextFromMultipart(body, ct), "Quoted boundary");
  });

  it("handles boundary without quotes", () => {
    const body = [
      "--abc",
      "Content-Type: text/plain",
      "",
      "Unquoted boundary",
      "--abc--",
    ].join("\r\n");
    const ct = "multipart/mixed; boundary=abc";
    assert.equal(extractTextFromMultipart(body, ct), "Unquoted boundary");
  });

  it("decodes base64 encoded part", () => {
    const encoded = Buffer.from("Base64 decoded text").toString("base64");
    const body = [
      "--b64bound",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      encoded,
      "--b64bound--",
    ].join("\r\n");
    const ct = "multipart/mixed; boundary=b64bound";
    assert.equal(extractTextFromMultipart(body, ct), "Base64 decoded text");
  });

  it("decodes quoted-printable encoded part", () => {
    const body = [
      "--qpbound",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Hello =C3=A9l=C3=A8ve",
      "--qpbound--",
    ].join("\r\n");
    const ct = "multipart/mixed; boundary=qpbound";
    // =C3=A9 = e-acute, =C3=A8 = e-grave
    assert.equal(extractTextFromMultipart(body, ct), "Hello \u00e9l\u00e8ve");
  });

  it("does not treat closing boundary as a part", () => {
    const body = [
      "--bound",
      "Content-Type: text/plain",
      "",
      "Real content",
      "--bound--",
      "Trailing junk after closing boundary",
    ].join("\r\n");
    const ct = "multipart/mixed; boundary=bound";
    assert.equal(extractTextFromMultipart(body, ct), "Real content");
  });

  it("returns body unchanged when no boundary found", () => {
    const body = "Just raw text";
    const ct = "multipart/mixed";
    assert.equal(extractTextFromMultipart(body, ct), "Just raw text");
  });

  it("handles LF line endings (no CR)", () => {
    const body = [
      "--lfbound",
      "Content-Type: text/plain",
      "",
      "LF only content",
      "--lfbound--",
    ].join("\n");
    const ct = "multipart/mixed; boundary=lfbound";
    assert.equal(extractTextFromMultipart(body, ct), "LF only content");
  });

  it("handles boundary with special characters", () => {
    const boundary = "----=_Part_123_456.789";
    const body = [
      `--${boundary}`,
      "Content-Type: text/plain",
      "",
      "Special boundary chars",
      `--${boundary}--`,
    ].join("\r\n");
    const ct = `multipart/mixed; boundary="${boundary}"`;
    assert.equal(extractTextFromMultipart(body, ct), "Special boundary chars");
  });

  it("returns body when parts have no text content types", () => {
    const body = [
      "--imgbound",
      "Content-Type: image/png",
      "Content-Disposition: attachment",
      "",
      "binary-png-data",
      "--imgbound--",
    ].join("\r\n");
    const ct = "multipart/mixed; boundary=imgbound";
    // No text/plain or text/html, falls back to body
    const result = extractTextFromMultipart(body, ct);
    assert.equal(result, body);
  });
});
