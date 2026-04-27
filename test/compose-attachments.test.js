import { describe, it, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, mkdirSync, rmdirSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { escapeForAppleScript, generateAttachmentSnippet, revalidateAttachmentFile } from "../index.js";

// Note: We test the AppleScript generation logic without actually running AppleScript.
// This verifies the strings are well-formed and escaped correctly.

// --- Test fixtures for attachment generation tests ---

const testDir = join(tmpdir(), "mcp-mail-compose-tests");

function ensureTestDir() {
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
}

function cleanupTestDir() {
  try {
    const files = require("fs").readdirSync(testDir);
    for (const file of files) {
      const path = join(testDir, file);
      try {
        unlinkSync(path);
      } catch (e) {}
    }
    rmdirSync(testDir);
  } catch (e) {}
}

function createTestFile(name, sizeBytes = 1024) {
  ensureTestDir();
  const path = join(testDir, name);
  writeFileSync(path, Buffer.alloc(sizeBytes, "a"));
  return path;
}

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

// --- generateAttachmentSnippet with revalidation ---

describe("generateAttachmentSnippet with TOCTOU protection", () => {
  after(() => {
    cleanupTestDir();
  });

  it("generates snippet for valid files", () => {
    const file1 = createTestFile("test1.pdf", 512);
    const file2 = createTestFile("test2.pdf", 1024);
    const snippet = generateAttachmentSnippet([file1, file2], "newMsg");

    // Should contain two attachment blocks
    const attachmentCount = (snippet.match(/make new attachment/g) || []).length;
    assert.equal(attachmentCount, 2);
    assert.ok(snippet.includes(file1));
    assert.ok(snippet.includes(file2));
  });

  it("handles empty attachment list", () => {
    const snippet = generateAttachmentSnippet([], "newMsg");
    assert.equal(snippet, "");
  });

  it("handles null/undefined attachment list", () => {
    const snippet1 = generateAttachmentSnippet(null, "newMsg");
    const snippet2 = generateAttachmentSnippet(undefined, "newMsg");
    assert.equal(snippet1, "");
    assert.equal(snippet2, "");
  });

  it("skips files that fail revalidation", () => {
    const file1 = createTestFile("valid.pdf", 512);
    const file2 = "/nonexistent/file.pdf"; // Will fail revalidation
    const file3 = createTestFile("also-valid.pdf", 512);

    const snippet = generateAttachmentSnippet([file1, file2, file3], "newMsg");

    // Should only contain two attachment blocks (file1 and file3)
    const attachmentCount = (snippet.match(/make new attachment/g) || []).length;
    assert.equal(attachmentCount, 2);
    assert.ok(snippet.includes(file1));
    assert.ok(snippet.includes(file3));
    assert.ok(!snippet.includes(file2));
  });

  it("works with different msgVar names", () => {
    const file = createTestFile("msgvar-test.pdf", 512);
    const snippet = generateAttachmentSnippet([file], "replyMsg");

    assert.ok(snippet.includes("tell content of replyMsg"));
    assert.ok(snippet.includes(file));
  });
});

describe("revalidateAttachmentFile", () => {
  after(() => {
    cleanupTestDir();
  });

  it("returns true for valid file", () => {
    const file = createTestFile("revalidate-test.pdf", 512);
    const result = revalidateAttachmentFile(file);
    assert.equal(result, true);
  });

  it("returns false for nonexistent file", () => {
    const result = revalidateAttachmentFile("/nonexistent/file.pdf");
    assert.equal(result, false);
  });

  it("returns false for directory", () => {
    ensureTestDir();
    const result = revalidateAttachmentFile(testDir);
    assert.equal(result, false);
  });
});
