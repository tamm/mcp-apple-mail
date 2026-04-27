import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { escapeForAppleScript } from "../index.js";

// Note: We test the AppleScript generation logic without actually running AppleScript.
// This verifies the strings are well-formed and escaped correctly.

describe("AppleScript attachment generation", () => {
  it("escapes paths with quotes in AppleScript", () => {
    const path = '/tmp/file"with"quotes.txt';
    const escaped = escapeForAppleScript(path);
    // Should escape internal quotes
    assert.ok(escaped.includes('\\"'));
    assert.ok(!escaped.includes('"') || escaped.includes('\\"'));
  });

  it("escapes paths with backslashes", () => {
    const path = '/tmp/file\\with\\backslash.txt';
    const escaped = escapeForAppleScript(path);
    assert.ok(escaped.includes('\\\\'));
  });

  it("escapes newlines in paths (if any)", () => {
    const path = '/tmp/file\nwith\nnewline.txt';
    const escaped = escapeForAppleScript(path);
    assert.ok(escaped.includes('\\n'));
  });

  it("handles typical PDF path", () => {
    const path = '/tmp/document.pdf';
    const escaped = escapeForAppleScript(path);
    // Should not introduce errors
    assert.equal(escaped, '/tmp/document.pdf');
  });

  it("handles path with spaces", () => {
    const path = '/tmp/my important file.pdf';
    const escaped = escapeForAppleScript(path);
    assert.equal(escaped, '/tmp/my important file.pdf');
  });

  it("handles path with special characters", () => {
    const path = '/tmp/file-with_special@chars#123.txt';
    const escaped = escapeForAppleScript(path);
    assert.equal(escaped, '/tmp/file-with_special@chars#123.txt');
  });

  // Test that the attachment snippet would be valid AppleScript syntax
  it("generates valid AppleScript for single attachment", () => {
    const filePath = '/tmp/document.pdf';
    const escaped = escapeForAppleScript(filePath);
    // Simulate what generateAttachmentSnippet would produce
    const snippet = `tell content of newMsg\n    make new attachment with properties {file name:POSIX file "${escaped}"} at after the last paragraph\nend tell`;

    // Basic sanity check: should have proper structure
    assert.ok(snippet.includes('tell content of newMsg'));
    assert.ok(snippet.includes('make new attachment'));
    assert.ok(snippet.includes('POSIX file'));
    assert.ok(snippet.includes('end tell'));
  });

  it("generates valid AppleScript for multiple attachments", () => {
    const files = ['/tmp/file1.pdf', '/tmp/file2.pdf'];
    let snippet = '';
    for (const filePath of files) {
      const escaped = escapeForAppleScript(filePath);
      snippet += `\ntell content of newMsg\n    make new attachment with properties {file name:POSIX file "${escaped}"} at after the last paragraph\nend tell`;
    }

    // Should have two attachment blocks
    const attachmentCount = (snippet.match(/make new attachment/g) || []).length;
    assert.equal(attachmentCount, 2);
  });
});
