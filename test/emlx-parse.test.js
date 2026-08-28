import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseEmlx } from "../index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fix = (name) => join(__dirname, "fixtures", name);

describe("parseEmlx", () => {
  it("parses plain text email", () => {
    const r = parseEmlx(fix("simple.emlx"));
    assert.equal(r.subject, "Hello mate");
    assert.equal(r.from, "alice@example.com");
    assert.equal(r.to, "bob@example.com");
    assert.equal(r.cc, "charlie@example.com");
    assert.equal(r.date, "Mon, 5 Jan 2026 10:00:00 +1100");
    assert.equal(r.body, "G'day Bob, how are things going?");
  });

  it("extracts text from HTML-only email", () => {
    const r = parseEmlx(fix("html-only.emlx"));
    assert.equal(r.subject, "HTML Newsletter");
    assert.equal(r.from, "dave@example.com");
    assert.equal(r.to, "eve@example.com");
    assert.ok(r.body.includes("Welcome to the newsletter"));
    assert.ok(r.body.includes("Cheers"));
  });

  it("prefers plain text in multipart", () => {
    const r = parseEmlx(fix("multipart.emlx"));
    assert.equal(r.subject, "Multipart Message");
    assert.equal(r.from, "frank@example.com");
    assert.equal(r.to, "grace@example.com");
    assert.equal(r.body, "Plain text version here.");
  });

  it("decodes MIME-encoded subject", () => {
    const r = parseEmlx(fix("mime-subject.emlx"));
    assert.equal(r.subject, "Caf\u00e9 menu");
    assert.equal(r.body, "Here is the menu.");
  });

  it("decodes MIME-encoded From header", () => {
    const r = parseEmlx(fix("mime-subject.emlx"));
    assert.ok(r.from.includes("\u5c71\u7530\u592a\u90ce"));
    assert.ok(r.from.includes("taro@example.jp"));
  });

  it("decodes quoted-printable body", () => {
    const r = parseEmlx(fix("qp-body.emlx"));
    assert.equal(r.subject, "QP Test");
    assert.equal(r.body, "Caf\u00e9 is delicious.");
  });

  it("decodes base64 body", () => {
    const r = parseEmlx(fix("base64-body.emlx"));
    assert.equal(r.subject, "Base64 Test");
    assert.equal(r.body, "Base64 decoded content here.");
  });

  it("returns empty cc when not present", () => {
    const r = parseEmlx(fix("html-only.emlx"));
    assert.equal(r.cc, "");
  });

  it("returns date string as-is", () => {
    const r = parseEmlx(fix("qp-body.emlx"));
    assert.equal(r.date, "Fri, 9 Jan 2026 12:00:00 +0000");
  });

  it("returns all expected fields", () => {
    const r = parseEmlx(fix("simple.emlx"));
    const keys = Object.keys(r).sort();
    assert.deepEqual(keys, ["body", "cc", "date", "from", "subject", "to"]);
  });
});
