import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { quoteBlock, extractHtmlPart, shardDirs, parseEmlx } from "../index.js";

test("quoteBlock uses the original HTML verbatim inside a cite blockquote", () => {
  const q = quoteBlock({ date: "Thu, 28 Aug 2026 07:16:17 +0000", from: "Nicklas <n@x.se>", body: "plain", html: "<p>Hej <b>du</b></p>" });
  assert.match(q.attribution, /^On .*2026.*, Nicklas <n@x.se> wrote:$/);
  assert.ok(q.html.includes('<blockquote type="cite">'));
  assert.ok(q.html.includes("<p>Hej <b>du</b></p>"));
  assert.ok(q.html.includes("Nicklas &lt;n@x.se&gt; wrote:"));
});

test("quoteBlock falls back to escaped text lines when there is no HTML part", () => {
  const q = quoteBlock({ date: "garbage", from: "a@b", body: "line1\n<tag>" });
  assert.ok(q.html.includes("line1<br>&lt;tag&gt;"));
  assert.equal(q.attribution, "On garbage, a@b wrote:");
});

test("extractHtmlPart finds nested text/html and decodes quoted-printable", () => {
  const body = [
    "--outer", "Content-Type: multipart/alternative; boundary=inner", "",
    "--inner", "Content-Type: text/plain", "", "hi", 
    "--inner", "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: quoted-printable", "", "<p>h=C3=A5</p>",
    "--inner--", "--outer--", "",
  ].join("\r\n");
  assert.equal(extractHtmlPart(body, 'multipart/mixed; boundary="outer"'), "<p>hå</p>\r\n");
  assert.equal(extractHtmlPart("x", "text/plain"), null);
});

test("parseEmlx exposes the raw html part", () => {
  const dir = mkdtempSync(join(tmpdir(), "emlx-"));
  const rfc = "Subject: s\r\nContent-Type: text/html\r\n\r\n<p>Hej</p>";
  const f = join(dir, "1.emlx");
  writeFileSync(f, `${Buffer.byteLength(rfc)}\n${rfc}`);
  const d = parseEmlx(f);
  assert.equal(d.html, "<p>Hej</p>");
  assert.equal(d.body, "Hej");
});

test("shardDirs enumerates Data/, Data/X and Data/X/Y whatever the digits are", () => {
  const data = mkdtempSync(join(tmpdir(), "shard-"));
  mkdirSync(join(data, "2", "7"), { recursive: true });
  mkdirSync(join(data, "9"), { recursive: true });
  mkdirSync(join(data, "Messages"), { recursive: true });
  const rel = shardDirs(data).map(p => p.slice(data.length)).sort();
  assert.deepEqual(rel, ["", "/2", "/2/7", "/9"]);
});
