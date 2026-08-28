import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { shardDirs } from "../index.js";

test("shardDirs enumerates Data/, Data/X and Data/X/Y whatever the digits are", () => {
  const data = mkdtempSync(join(tmpdir(), "shard-"));
  mkdirSync(join(data, "2", "7"), { recursive: true });
  mkdirSync(join(data, "9"), { recursive: true });
  mkdirSync(join(data, "Messages"), { recursive: true });
  const rel = shardDirs(data).map(p => p.slice(data.length)).sort();
  assert.deepEqual(rel, ["", "/2", "/2/7", "/9"]);
});
