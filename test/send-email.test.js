import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, unlinkSync, renameSync, utimesSync, statSync, mkdirSync } from "fs";
import { dirname } from "path";
import {
  loadSendConfig,
  SEND_MIN_INTERVAL_FLOOR,
  SEND_CONFIG_PATH,
  SEND_TIMESTAMP_PATH,
} from "../index.js";

// --- Helpers ---

const configDir = dirname(SEND_CONFIG_PATH);

function ensureConfigDir() {
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
}

function writeConfig(obj) {
  ensureConfigDir();
  writeFileSync(SEND_CONFIG_PATH, JSON.stringify(obj), "utf-8");
}

function writeRawConfig(str) {
  ensureConfigDir();
  writeFileSync(SEND_CONFIG_PATH, str, "utf-8");
}

// --- Backup / restore real config ---

let savedConfig = null;
let configExisted = false;

let savedTimestamp = null;
let timestampExisted = false;

before(() => {
  if (existsSync(SEND_CONFIG_PATH)) {
    configExisted = true;
    savedConfig = readFileSync(SEND_CONFIG_PATH, "utf-8");
  }
  if (existsSync(SEND_TIMESTAMP_PATH)) {
    timestampExisted = true;
    savedTimestamp = readFileSync(SEND_TIMESTAMP_PATH, "utf-8");
  }
});

after(() => {
  // Restore config
  if (configExisted) {
    ensureConfigDir();
    writeFileSync(SEND_CONFIG_PATH, savedConfig, "utf-8");
  } else if (existsSync(SEND_CONFIG_PATH)) {
    unlinkSync(SEND_CONFIG_PATH);
  }
  // Restore timestamp
  if (timestampExisted) {
    ensureConfigDir();
    writeFileSync(SEND_TIMESTAMP_PATH, savedTimestamp, "utf-8");
  } else if (existsSync(SEND_TIMESTAMP_PATH)) {
    unlinkSync(SEND_TIMESTAMP_PATH);
  }
});

// --- loadSendConfig ---

describe("loadSendConfig", () => {
  it("returns null when config file does not exist", () => {
    if (existsSync(SEND_CONFIG_PATH)) unlinkSync(SEND_CONFIG_PATH);
    assert.equal(loadSendConfig(), null);
  });

  it("returns null when enabled is false", () => {
    writeConfig({
      enabled: false,
      from_account: "test",
      allowed_recipients: ["hi@tamm.in"],
      min_interval_seconds: 120,
    });
    assert.equal(loadSendConfig(), null);
  });

  it("returns null when enabled is string 'true' (not boolean)", () => {
    writeConfig({
      enabled: "true",
      from_account: "test",
      allowed_recipients: ["hi@tamm.in"],
      min_interval_seconds: 120,
    });
    assert.equal(loadSendConfig(), null);
  });

  it("returns null when from_account is missing", () => {
    writeConfig({
      enabled: true,
      from_email: "test@example.com",
      allowed_recipients: ["hi@tamm.in"],
      min_interval_seconds: 120,
    });
    assert.equal(loadSendConfig(), null);
  });

  it("returns null when from_email is missing", () => {
    writeConfig({
      enabled: true,
      from_account: "test",
      allowed_recipients: ["hi@tamm.in"],
      min_interval_seconds: 120,
    });
    assert.equal(loadSendConfig(), null);
  });

  it("returns null when allowed_recipients is empty array", () => {
    writeConfig({
      enabled: true,
      from_account: "test",
      from_email: "test@example.com",
      allowed_recipients: [],
      min_interval_seconds: 120,
    });
    assert.equal(loadSendConfig(), null);
  });

  it("returns null when allowed_recipients is not an array", () => {
    writeConfig({
      enabled: true,
      from_account: "test",
      from_email: "test@example.com",
      allowed_recipients: "hi@tamm.in",
      min_interval_seconds: 120,
    });
    assert.equal(loadSendConfig(), null);
  });

  it("returns valid config with correct shape when all fields present", () => {
    writeConfig({
      enabled: true,
      from_account: "test-account",
      from_email: "test@example.com",
      allowed_recipients: ["hi@tamm.in"],
      min_interval_seconds: 300,
    });
    const result = loadSendConfig();
    assert.notEqual(result, null);
    assert.equal(result.from_account, "test-account");
    assert.equal(result.from_email, "test@example.com");
    assert.deepEqual(result.allowed_recipients, ["hi@tamm.in"]);
    assert.equal(result.min_interval_seconds, 300);
    // enabled should NOT be in the returned object (it's stripped)
    assert.equal(result.enabled, undefined);
  });

  it("lowercases allowed_recipients", () => {
    writeConfig({
      enabled: true,
      from_account: "test",
      from_email: "test@example.com",
      allowed_recipients: ["Hi@Tamm.In", "OTHER@EXAMPLE.COM"],
      min_interval_seconds: 120,
    });
    const result = loadSendConfig();
    assert.deepEqual(result.allowed_recipients, ["hi@tamm.in", "other@example.com"]);
  });

  it("lowercases from_email", () => {
    writeConfig({
      enabled: true,
      from_account: "test",
      from_email: "Test@Example.COM",
      allowed_recipients: ["hi@tamm.in"],
      min_interval_seconds: 120,
    });
    const result = loadSendConfig();
    assert.equal(result.from_email, "test@example.com");
  });

  it("respects SEND_MIN_INTERVAL_FLOOR when config value is below it", () => {
    writeConfig({
      enabled: true,
      from_account: "test",
      from_email: "test@example.com",
      allowed_recipients: ["hi@tamm.in"],
      min_interval_seconds: 10,
    });
    const result = loadSendConfig();
    assert.equal(result.min_interval_seconds, SEND_MIN_INTERVAL_FLOOR);
  });

  it("allows min_interval_seconds above the floor", () => {
    writeConfig({
      enabled: true,
      from_account: "test",
      from_email: "test@example.com",
      allowed_recipients: ["hi@tamm.in"],
      min_interval_seconds: 300,
    });
    const result = loadSendConfig();
    assert.equal(result.min_interval_seconds, 300);
  });

  it("returns null for invalid JSON", () => {
    writeRawConfig("{ not valid json !!!");
    assert.equal(loadSendConfig(), null);
  });
});

// --- Rate limit logic ---

describe("rate limit timestamp file", () => {
  before(() => {
    // Ensure a valid config so we can reason about rate limits
    writeConfig({
      enabled: true,
      from_account: "test",
      from_email: "test@example.com",
      allowed_recipients: ["hi@tamm.in"],
      min_interval_seconds: 120,
    });
  });

  it("recent timestamp file indicates active rate limit", () => {
    ensureConfigDir();
    writeFileSync(SEND_TIMESTAMP_PATH, "ts", "utf-8");
    // mtime is now — elapsed ~0s, well under 120s floor
    const stat = statSync(SEND_TIMESTAMP_PATH);
    const elapsed = (Date.now() - stat.mtimeMs) / 1000;
    assert.ok(elapsed < SEND_MIN_INTERVAL_FLOOR, "elapsed should be less than floor");
  });

  it("old timestamp file indicates no rate limit", () => {
    ensureConfigDir();
    writeFileSync(SEND_TIMESTAMP_PATH, "ts", "utf-8");
    // Set mtime to 10 minutes ago
    const past = new Date(Date.now() - 600_000);
    utimesSync(SEND_TIMESTAMP_PATH, past, past);
    const stat = statSync(SEND_TIMESTAMP_PATH);
    const elapsed = (Date.now() - stat.mtimeMs) / 1000;
    assert.ok(elapsed >= SEND_MIN_INTERVAL_FLOOR, "elapsed should exceed floor");
  });

  it("no timestamp file means no rate limit", () => {
    if (existsSync(SEND_TIMESTAMP_PATH)) unlinkSync(SEND_TIMESTAMP_PATH);
    assert.equal(existsSync(SEND_TIMESTAMP_PATH), false);
    // No file = no rate limit (nothing to check mtime of)
  });
});

// --- Recipient validation ---

describe("recipient allowlist matching", () => {
  it("case-insensitive match: config has hi@tamm.in, Hi@Tamm.In matches", () => {
    writeConfig({
      enabled: true,
      from_account: "test",
      from_email: "test@example.com",
      allowed_recipients: ["hi@tamm.in"],
      min_interval_seconds: 120,
    });
    const config = loadSendConfig();
    // handleSendEmail lowercases the input `to` before checking config.allowed_recipients
    const to = "Hi@Tamm.In".toLowerCase().trim();
    assert.ok(config.allowed_recipients.includes(to));
  });

  it("disallowed recipient does not match", () => {
    writeConfig({
      enabled: true,
      from_account: "test",
      from_email: "test@example.com",
      allowed_recipients: ["hi@tamm.in"],
      min_interval_seconds: 120,
    });
    const config = loadSendConfig();
    const to = "other@example.com".toLowerCase().trim();
    assert.equal(config.allowed_recipients.includes(to), false);
  });
});

// --- Constants ---

describe("safety constants", () => {
  it("SEND_MIN_INTERVAL_FLOOR is 120 seconds", () => {
    assert.equal(SEND_MIN_INTERVAL_FLOOR, 120);
  });

  it("SEND_CONFIG_PATH ends with .mcp-apple-mail/send-config.json", () => {
    assert.ok(SEND_CONFIG_PATH.endsWith(".mcp-apple-mail/send-config.json"));
  });

  it("SEND_TIMESTAMP_PATH ends with .mcp-apple-mail/last-send-ts", () => {
    assert.ok(SEND_TIMESTAMP_PATH.endsWith(".mcp-apple-mail/last-send-ts"));
  });
});
