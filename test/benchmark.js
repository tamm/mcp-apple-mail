#!/usr/bin/env node
// Run: node test/benchmark.js
// Starts the MCP server via stdio and times each tool call.
// Not part of `npm test` — run manually to check performance.

import { execSync } from "child_process";
import { createRequire } from "module";
import { spawn } from "child_process";
import { createInterface } from "readline";

const server = spawn("node", ["index.js"], {
  stdio: ["pipe", "pipe", "pipe"],
  cwd: new URL("..", import.meta.url).pathname,
});

let reqId = 0;
const pending = new Map();

const rl = createInterface({ input: server.stdout });
rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  } catch {}
});

function call(method, params) {
  return new Promise((resolve) => {
    const id = ++reqId;
    pending.set(id, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} }) + "\n");
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function bench(label, tool, args) {
  const t0 = Date.now();
  const resp = await call("tools/call", { name: tool, arguments: args });
  const elapsed = Date.now() - t0;
  const text = resp.result?.content?.[0]?.text || "";
  const isErr = resp.result?.isError || false;
  const idLines = text.split("\n").filter((l) => l.startsWith("ID:"));
  const status = isErr ? "FAIL" : "PASS";
  console.log(
    `${label.padEnd(42)} ${String(elapsed).padStart(6)}ms  ${String(idLines.length).padStart(4)} results  ${status}`
  );
  return { label, elapsed, count: idLines.length, status };
}

async function main() {
  await call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "benchmark", version: "1.0" },
  });
  await call("notifications/initialized");
  await sleep(3000); // let caches warm

  const results = [];
  const run = async (label, tool, args) => results.push(await bench(label, tool, args));

  console.log(`${"Test".padEnd(42)} ${"Time".padStart(8)}  ${"Count".padStart(12)}  Status`);
  console.log("-".repeat(77));

  // Metadata search
  await run("list_mailboxes", "list_mailboxes", {});
  await run("list_mailboxes +counts", "list_mailboxes", { include_counts: true });
  await run("search INBOX (10)", "search_emails", {});
  await run("search INBOX (50)", "search_emails", { limit: 50 });
  await run("search INBOX (200)", "search_emails", { limit: 200 });
  await run("search INBOX (500)", "search_emails", { limit: 500 });
  await run("search query 'github'", "search_emails", { query: "github" });
  await run("search query 'github' limit 50", "search_emails", { query: "github", limit: 50 });
  await run("search Sent Mail", "search_emails", { mailbox: "Sent Mail" });
  await run("search Trash", "search_emails", { mailbox: "Trash" });
  await run("search Spam", "search_emails", { mailbox: "Spam" });
  await run("search unread only", "search_emails", { unread_only: true });
  await run("search sort=asc (oldest)", "search_emails", { sort: "asc", limit: 5 });
  await run("search after 2026-03-01", "search_emails", { after: "2026-03-01" });
  await run("search before 2025-01-01 asc", "search_emails", { before: "2025-01-01", sort: "asc", limit: 5 });
  await run("search date range Feb 2026", "search_emails", { after: "2026-02-01", before: "2026-02-28" });

  // Get email
  await run("get_email (63945)", "get_email", { email_id: 63945 });
  await run("get_email (63934)", "get_email", { email_id: 63934 });
  await run("get_email (63183)", "get_email", { email_id: 63183 });

  // Body search
  await sleep(3000); // let backfill index some emails
  await run("search_body 'workflow'", "search_body", { query: "workflow" });
  await run("search_body 'marathon'", "search_body", { query: "marathon" });
  await run("search_body 'invoice'", "search_body", { query: "invoice" });

  // Index stats
  const statsResp = await call("tools/call", { name: "search_body", arguments: { query: "xyzzy_nomatch" } });
  const statsText = statsResp.result?.content?.[0]?.text || "";
  const idxMatch = statsText.match(/Index: (.+)/);
  console.log(`\nFTS5 index: ${idxMatch ? idxMatch[1] : "N/A"}`);

  // Summary
  const fails = results.filter((r) => r.status === "FAIL");
  const avgSearch = results
    .filter((r) => r.label.startsWith("search ") && r.status === "PASS")
    .reduce((sum, r, _, a) => sum + r.elapsed / a.length, 0);
  console.log(`\n${results.length} tests, ${fails.length} failures`);
  console.log(`Average metadata search: ${Math.round(avgSearch)}ms`);

  server.kill();
  process.exit(fails.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  server.kill();
  process.exit(1);
});
