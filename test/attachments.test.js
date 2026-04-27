import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, mkdirSync, rmdirSync, existsSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  validateAttachments,
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_MAX_SIZE_BYTES,
} from "../index.js";

// --- Test fixtures ---

const testDir = join(tmpdir(), "mcp-mail-attachment-tests");

function ensureTestDir() {
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
}

function cleanupTestDir() {
  try {
    const files = require("fs").readdirSync(testDir);
    for (const file of files) {
      const path = join(testDir, file);
      try {
        if (require("fs").lstatSync(path).isSymbolicLink()) {
          unlinkSync(path);
        } else {
          unlinkSync(path);
        }
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

// --- Tests ---

describe("validateAttachments", () => {
  after(() => {
    cleanupTestDir();
  });

  it("returns null for undefined attachments", () => {
    assert.equal(validateAttachments(undefined), null);
  });

  it("returns null for empty array", () => {
    assert.equal(validateAttachments([]), null);
  });

  it("returns null for null", () => {
    assert.equal(validateAttachments(null), null);
  });

  it("returns error string for non-array input", () => {
    const result = validateAttachments("not-an-array");
    assert.equal(typeof result, "string");
    assert.ok(result.includes("array"));
  });

  it("rejects too many attachments", () => {
    const files = [];
    for (let i = 0; i <= ATTACHMENT_MAX_COUNT; i++) {
      files.push(createTestFile(`file-${i}.txt`));
    }
    const result = validateAttachments(files);
    assert.equal(typeof result, "string");
    assert.ok(result.includes("Too many attachments"));
  });

  it("accepts exactly max count attachments", () => {
    const files = [];
    for (let i = 0; i < ATTACHMENT_MAX_COUNT; i++) {
      files.push(createTestFile(`max-file-${i}.txt`));
    }
    const result = validateAttachments(files);
    assert.ok(Array.isArray(result));
    assert.equal(result.length, ATTACHMENT_MAX_COUNT);
  });

  it("rejects non-string in attachments array", () => {
    const result = validateAttachments([123, "/path/to/file"]);
    assert.equal(typeof result, "string");
    assert.ok(result.includes("non-empty string path"));
  });

  it("rejects relative paths", () => {
    const result = validateAttachments(["relative/path/file.txt"]);
    assert.equal(typeof result, "string");
    assert.ok(result.includes("must be absolute"));
  });

  it("rejects paths with ..", () => {
    const result = validateAttachments(["/etc/../../../etc/passwd"]);
    assert.equal(typeof result, "string");
    assert.ok(result.includes("contains .."));
  });

  it("rejects non-existent files", () => {
    const result = validateAttachments(["/nonexistent/file/path/that/does/not/exist.txt"]);
    assert.equal(typeof result, "string");
    assert.ok(result.includes("not found"));
  });

  it("rejects directories (not files)", () => {
    ensureTestDir();
    const result = validateAttachments([testDir]);
    assert.equal(typeof result, "string");
    assert.ok(result.includes("regular file"));
  });

  it("rejects files larger than max size", () => {
    const largePath = createTestFile("large-file.bin", ATTACHMENT_MAX_SIZE_BYTES + 1024);
    const result = validateAttachments([largePath]);
    assert.equal(typeof result, "string");
    assert.ok(result.includes("too large"));
  });

  it("accepts files exactly at max size", () => {
    const maxPath = createTestFile("max-size.bin", ATTACHMENT_MAX_SIZE_BYTES);
    const result = validateAttachments([maxPath]);
    assert.ok(Array.isArray(result));
    assert.deepEqual(result, [maxPath]);
  });

  it("accepts files below max size", () => {
    const smallPath = createTestFile("small-file.txt", 1024);
    const result = validateAttachments([smallPath]);
    assert.ok(Array.isArray(result));
    assert.deepEqual(result, [smallPath]);
  });

  it("accepts multiple valid files", () => {
    const file1 = createTestFile("multi-1.txt", 512);
    const file2 = createTestFile("multi-2.txt", 1024);
    const file3 = createTestFile("multi-3.txt", 2048);
    const result = validateAttachments([file1, file2, file3]);
    assert.ok(Array.isArray(result));
    assert.deepEqual(result, [file1, file2, file3]);
  });

  it("rejects mixed valid and invalid files (stops at first error)", () => {
    const validFile = createTestFile("valid.txt", 512);
    const result = validateAttachments([validFile, "/nonexistent/file.txt"]);
    assert.equal(typeof result, "string");
    assert.ok(result.includes("not found"));
  });

  it("rejects empty string path", () => {
    const result = validateAttachments([""]);
    assert.equal(typeof result, "string");
    assert.ok(result.includes("non-empty string"));
  });

  it("rejects symlinks (not regular files)", () => {
    ensureTestDir();
    const targetPath = createTestFile("symlink-target.txt", 512);
    const linkPath = join(testDir, "test-symlink");
    try {
      symlinkSync(targetPath, linkPath);
      const result = validateAttachments([linkPath]);
      assert.equal(typeof result, "string");
      assert.ok(result.includes("regular file"));
    } finally {
      try { unlinkSync(linkPath); } catch (e) {}
    }
  });

  it("handles paths with special characters in names", () => {
    const specialPath = createTestFile("file with spaces & chars.txt", 512);
    const result = validateAttachments([specialPath]);
    assert.ok(Array.isArray(result));
    assert.deepEqual(result, [specialPath]);
  });
});

// --- Constants validation ---

describe("attachment constants", () => {
  it("ATTACHMENT_MAX_COUNT is a reasonable number", () => {
    assert.ok(ATTACHMENT_MAX_COUNT > 0);
    assert.ok(ATTACHMENT_MAX_COUNT <= 100);
    assert.equal(ATTACHMENT_MAX_COUNT, 10);
  });

  it("ATTACHMENT_MAX_SIZE_BYTES is 25 MB", () => {
    assert.equal(ATTACHMENT_MAX_SIZE_BYTES, 25 * 1024 * 1024);
  });
});
