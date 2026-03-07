import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { htmlToText } from "../index.js";

describe("htmlToText", () => {
  it("strips simple HTML tags", () => {
    assert.equal(htmlToText("<b>bold</b> and <i>italic</i>"), "bold and italic");
  });

  it("converts <br> to newline", () => {
    assert.equal(htmlToText("line1<br>line2"), "line1\nline2");
  });

  it("converts <br /> to newline", () => {
    assert.equal(htmlToText("line1<br />line2"), "line1\nline2");
  });

  it("converts <br/> to newline", () => {
    assert.equal(htmlToText("line1<br/>line2"), "line1\nline2");
  });

  it("converts </p> to double newline", () => {
    assert.equal(htmlToText("<p>para1</p><p>para2</p>"), "para1\n\npara2");
  });

  it("converts </div> to newline", () => {
    assert.equal(htmlToText("<div>block1</div><div>block2</div>"), "block1\nblock2");
  });

  it("converts </tr> to newline", () => {
    assert.equal(htmlToText("<tr><td>a</td></tr><tr><td>b</td></tr>"), "a\nb");
  });

  it("converts </li> to newline", () => {
    assert.equal(htmlToText("<ul><li>one</li><li>two</li></ul>"), "one\ntwo");
  });

  it("decodes &amp;", () => {
    assert.equal(htmlToText("A &amp; B"), "A & B");
  });

  it("decodes &lt; and &gt;", () => {
    assert.equal(htmlToText("&lt;tag&gt;"), "<tag>");
  });

  it("decodes &quot;", () => {
    assert.equal(htmlToText("&quot;hello&quot;"), '"hello"');
  });

  it("decodes &#39;", () => {
    assert.equal(htmlToText("it&#39;s"), "it's");
  });

  it("decodes &nbsp; to space", () => {
    assert.equal(htmlToText("hello&nbsp;world"), "hello world");
  });

  it("removes <style> blocks", () => {
    assert.equal(
      htmlToText('<style type="text/css">body{color:red}</style>Hello'),
      "Hello"
    );
  });

  it("removes <script> blocks", () => {
    assert.equal(
      htmlToText("<script>alert('xss')</script>Safe text"),
      "Safe text"
    );
  });

  it("collapses 3+ consecutive newlines to 2", () => {
    assert.equal(
      htmlToText("<p>a</p><p></p><p>b</p>"),
      "a\n\nb"
    );
  });

  it("trims leading and trailing whitespace", () => {
    assert.equal(htmlToText("  <p>hello</p>  "), "hello");
  });

  it("handles a real-world HTML email snippet", () => {
    const html = `
      <html>
      <head><style>.foo{color:blue}</style></head>
      <body>
        <div>Hi Alice,</div>
        <br>
        <p>Just following up on our conversation.</p>
        <p>Here&apos;s the link: <a href="https://example.com">click&nbsp;here</a></p>
        <div>Cheers,<br>Bob</div>
      </body>
      </html>
    `;
    const result = htmlToText(html);
    assert.ok(result.includes("Hi Alice,"));
    assert.ok(result.includes("Just following up on our conversation."));
    assert.ok(result.includes("click here"));
    assert.ok(result.includes("Cheers,"));
    assert.ok(!result.includes("<div>"));
    assert.ok(!result.includes("<style>"));
    assert.ok(!result.includes(".foo{color:blue}"));
  });

  it("handles empty string", () => {
    assert.equal(htmlToText(""), "");
  });

  it("handles plain text with no HTML", () => {
    assert.equal(htmlToText("just plain text"), "just plain text");
  });
});
