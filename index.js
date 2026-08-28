import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execSync, exec } from "child_process";
import { marked } from "marked";
import { readFileSync, writeFileSync, unlinkSync, accessSync, readdirSync, existsSync, mkdirSync, statSync, copyFileSync, constants as fsConst } from "fs";
import { join, basename, extname } from "path";
import { tmpdir } from "os";

const server = new Server(
  { name: "mcp-apple-mail", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

// --- JXA execution ---

function runJxa(script, { timeout = 30000 } = {}) {
  try {
    const result = execSync(
      `osascript -l JavaScript << 'JXA_EOF'\n${script}\nJXA_EOF`,
      {
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
        shell: "/bin/bash",
        timeout,
      }
    );
    return result.trim();
  } catch (error) {
    const msg = error.message || "";
    if (msg.includes("ETIMEDOUT") || error.killed) {
      throw new Error("JXA timed out (>30s). Mail.app may be unresponsive.");
    }
    if (msg.includes("-1728")) {
      throw new Error("Object not found (-1728). The email may have been deleted or moved.");
    }
    if (msg.includes("-1712")) {
      throw new Error("Mail.app is busy with a dialog (-1712). Dismiss it and retry.");
    }
    if (msg.includes("not running") || msg.includes("-600")) {
      throw new Error("Mail.app is not running. Open it and retry.");
    }
    const execMatch = msg.match(/execution error: (.+?) \(-?\d+\)/);
    if (execMatch) {
      throw new Error(`JXA error: ${execMatch[1]}`);
    }
    throw new Error(`JXA error: ${msg.slice(0, 200)}`);
  }
}

function parseJxa(script, opts) {
  const raw = runJxa(script, opts);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// --- Text cleaning ---

function stripSignature(text) {
  if (!text) return "";
  // Standard sig delimiter: "-- " on its own line
  const sigIdx = text.search(/\n-- \n/);
  if (sigIdx !== -1) text = text.slice(0, sigIdx);
  // Common mobile/app signatures
  const mobilePatterns = [
    /\n\s*Sent from my iPhone\s*$/i,
    /\n\s*Sent from my iPad\s*$/i,
    /\n\s*Sent from my Galaxy\s*$/i,
    /\n\s*Get Outlook for iOS\s*$/i,
    /\n\s*Get Outlook for Android\s*$/i,
    /\n\s*Sent from Mail for Windows\s*$/i,
  ];
  for (const pat of mobilePatterns) {
    text = text.replace(pat, "");
  }
  return text.trim();
}

function stripQuotedReplies(text) {
  if (!text) return "";
  // "On <date> <name> wrote:" pattern
  const onWroteIdx = text.search(/\nOn .+wrote:\s*\n/i);
  if (onWroteIdx !== -1) return text.slice(0, onWroteIdx).trim();
  // Outlook-style "From: ... Sent: ..." block
  const outlookIdx = text.search(/\nFrom: .+\nSent: /i);
  if (outlookIdx !== -1) return text.slice(0, outlookIdx).trim();
  // Gmail-style "---------- Forwarded message ----------"
  const fwdIdx = text.search(/\n-{5,}\s*Forwarded message\s*-{5,}/i);
  if (fwdIdx !== -1) return text.slice(0, fwdIdx).trim();
  // Trailing "> " quoted lines (only if they're at the end)
  const lines = text.split("\n");
  let lastContentLine = lines.length - 1;
  while (lastContentLine >= 0 && /^\s*>/.test(lines[lastContentLine])) {
    lastContentLine--;
  }
  // Only strip if we found quoted lines at the end
  if (lastContentLine < lines.length - 1) {
    // Also remove the blank line before quotes
    while (lastContentLine >= 0 && lines[lastContentLine].trim() === "") {
      lastContentLine--;
    }
    return lines.slice(0, lastContentLine + 1).join("\n").trim();
  }
  return text.trim();
}

function cleanBody(text) {
  return stripQuotedReplies(stripSignature(text));
}

// --- Markdown to HTML ---

function markdownToHtml(text) {
  const html = marked.parse(text, { async: false });
  return `<div style="font-family: Helvetica, -apple-system, sans-serif;">${html}</div>`;
}

// --- AppleScript for write ops (JXA's Mail.app write support is flaky) ---

function runAppleScript(script, { timeout = 30000 } = {}) {
  try {
    const result = execSync(
      `osascript << 'APPLESCRIPT_EOF'\n${script}\nAPPLESCRIPT_EOF`,
      {
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
        shell: "/bin/bash",
        timeout,
      }
    );
    return result.trim();
  } catch (error) {
    const msg = error.message || "";
    if (msg.includes("ETIMEDOUT") || error.killed) {
      throw new Error(`AppleScript timed out (>${timeout / 1000}s). Mail.app may be unresponsive.`);
    }
    throw new Error(`AppleScript error: ${msg.slice(0, 200)}`);
  }
}

// --- Message location helper (SQLite fast path, JXA fallback) ---

// Gmail virtual folders that JXA can see but AppleScript can't reference
const VIRTUAL_MAILBOXES = new Set([
  "All Mail", "Important", "Starred", "[Gmail]/All Mail",
  "[Gmail]/Important", "[Gmail]/Starred",
]);

function findMessageLocation(emailId) {
  // Try SQLite first (~1ms vs ~2.8s for JXA scan)
  try {
    const id = Number(emailId);
    // Check labels table first (Gmail virtual folders like INBOX)
    const labelRows = parseSqlite(`
      SELECT mb.url FROM labels l
      JOIN mailboxes mb ON mb.ROWID = l.mailbox_id
      WHERE l.message_id = ${id}
    `);
    // Also check direct mailbox
    const directRows = parseSqlite(`
      SELECT mb.url FROM messages m
      JOIN mailboxes mb ON mb.ROWID = m.mailbox
      WHERE m.ROWID = ${id}
    `);

    const allUrls = [...labelRows, ...directRows].map(r => r.url);
    // Prefer non-virtual mailbox (INBOX > All Mail)
    let best = null;
    let fallback = null;
    for (const url of allUrls) {
      const mbox = mailboxFromUrl(url);
      const account = accountFromUrl(url);
      const mboxPath = mailboxPathFromUrl(url) || [mbox];
      const loc = { account, mailbox: mbox, mailboxPath: mboxPath };
      if (!VIRTUAL_MAILBOXES.has(mbox)) {
        best = loc;
        break;
      }
      if (!fallback) fallback = loc;
    }
    if (best || fallback) return best || fallback;
  } catch (e) {}

  // JXA fallback if SQLite fails
  return parseJxa(`
    const mail = Application("Mail");
    const msgId = ${Number(emailId)};
    const virtual = new Set(${JSON.stringify([...VIRTUAL_MAILBOXES])});

    function searchBoxes(boxes, path) {
      for (const box of boxes) {
        try {
          const name = box.name();
          const curPath = path.concat([name]);
          const msgs = box.messages.whose({id: msgId})();
          if (msgs.length > 0) return {name, path: curPath};
          // Search nested mailboxes (e.g. [Gmail]/All Mail)
          const nested = box.mailboxes();
          if (nested.length > 0) {
            const found = searchBoxes(nested, curPath);
            if (found) return found;
          }
        } catch(e) {}
      }
      return null;
    }

    function find() {
      let fallback = null;
      const accounts = mail.accounts();
      // Check INBOX first (most common)
      for (const acct of accounts) {
        try {
          const inbox = acct.mailboxes.whose({name: "INBOX"})();
          if (inbox.length > 0) {
            const msgs = inbox[0].messages.whose({id: msgId})();
            if (msgs.length > 0) return {account: acct.name(), mailbox: "INBOX", mailboxPath: ["INBOX"]};
          }
        } catch(e) {}
      }
      // Search all mailboxes including nested
      for (const acct of accounts) {
        const found = searchBoxes(acct.mailboxes(), []);
        if (found) {
          const loc = {account: acct.name(), mailbox: found.name, mailboxPath: found.path};
          if (!virtual.has(found.name)) return loc;
          if (!fallback) fallback = loc;
        }
      }
      return fallback;
    }
    JSON.stringify(find());
  `);
}

// --- Escape helpers ---

function escapeForAppleScript(str) {
  if (!str) return "";
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

function escapeForJxa(str) {
  // Use JSON.stringify for safe JXA string injection
  return JSON.stringify(str);
}

// --- Tool definitions ---

const TOOLS = [
  {
    name: "list_mailboxes",
    description: "List accounts and mailboxes. Optionally include unread counts (slower).",
    inputSchema: {
      type: "object",
      properties: {
        include_counts: { type: "boolean", description: "Include unread counts per mailbox. Slower due to aggregate query." },
      },
    },
  },
  {
    name: "search_emails",
    description: "Search or list emails by subject/sender.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search subject/sender. Omit for recent." },
        mailbox: { type: "string", description: "Mailbox (default: INBOX)." },
        account: { type: "string", description: "Account. Omit for all." },
        limit: { type: "number", description: "Max results (default 10)." },
        unread_only: { type: "boolean", description: "Only return unread emails." },
        sort: { type: "string", enum: ["desc", "asc"], description: "Sort by date: desc (default) or asc (oldest first)." },
        after: { type: "string", description: "Only emails after this date (YYYY-MM-DD)." },
        before: { type: "string", description: "Only emails before this date (YYYY-MM-DD)." },
      },
    },
  },
  {
    name: "get_email",
    description: "Get full email by ID with cleaned body.",
    inputSchema: {
      type: "object",
      properties: {
        email_id: { type: "number", description: "Email ID from search_emails." },
      },
      required: ["email_id"],
    },
  },
  {
    name: "compose",
    description: "Open a draft in Mail.app for new emails, replies, or forwards. This server is draft-only — it cannot send. The user reviews and sends manually. Body is markdown.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["new", "reply", "forward"] },
        to: { type: "string", description: "Recipient (new)." },
        subject: { type: "string", description: "Subject (new)." },
        body: { type: "string", description: "Markdown body." },
        cc: { type: "string" },
        email_id: { type: "number", description: "Email ID (reply/forward)." },
        reply_all: { type: "boolean", description: "Reply all." },
        from: { type: "string", description: "Sender email (new). Sets the From address; Mail.app applies that account's default signature." },
        attachments: { type: "array", items: { type: "string" }, description: "Absolute file paths to attach. To attach files from another email, run download_attachment first and pass the saved paths." },
      },
      required: ["mode", "body"],
    },
  },
  {
    name: "draft_reply",
    description: "Open a populated reply (or reply-all) window in Mail.app for an email: correct recipients, In-Reply-To threading, quoted original, your body on top, optional attachments. Body is verified by readback before returning. NEVER sends — the human reviews and hits Send. Body is markdown.",
    inputSchema: {
      type: "object",
      properties: {
        email_id: { type: "number", description: "Email ID from search_emails." },
        body: { type: "string", description: "Markdown body placed above the quoted original." },
        reply_all: { type: "boolean", description: "Reply to all recipients (default false)." },
        attachments: { type: "array", items: { type: "string" }, description: "Absolute file paths to attach. Use download_attachment to pull files out of another email first." },
      },
      required: ["email_id", "body"],
    },
  },
  {
    name: "move_email",
    description: "Move email to a mailbox.",
    inputSchema: {
      type: "object",
      properties: {
        email_id: { type: "number", description: "Email ID." },
        destination: { type: "string", description: "Target mailbox." },
        account: { type: "string", description: "Account for destination mailbox." },
      },
      required: ["email_id", "destination"],
    },
  },
  {
    name: "archive_emails",
    description: "Archive emails (remove from INBOX). Gmail: keeps in All Mail. Takes multiple IDs.",
    inputSchema: {
      type: "object",
      properties: {
        email_ids: {
          type: "array",
          items: { type: "number" },
          description: "Array of email IDs to archive.",
        },
        account: { type: "string", description: "Account (default: auto-detect)." },
      },
      required: ["email_ids"],
    },
  },
  {
    name: "index_now",
    description: "Trigger a full FTS5 index pass immediately. Use before search_body when you need complete results.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "search_body",
    description: "Full-text body search using FTS5 index. Index builds incrementally as emails are read. Returns relevance-ranked results.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms for body/subject/sender." },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "download_attachment",
    description: "Download attachment(s) from an email. Use get_email to see filenames.",
    inputSchema: {
      type: "object",
      properties: {
        email_id: { type: "number", description: "Email ID." },
        attachment_name: { type: "string", description: "Filename (omit for all)." },
        destination: { type: "string", description: "Save directory (default: /tmp/mail-attachments/)." },
      },
      required: ["email_id"],
    },
  },
];

// --- Tool handlers ---

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const t0 = Date.now();
  try {
    let result;
    switch (name) {
      case "list_mailboxes":
        result = handleListMailboxes(args); break;
      case "search_emails":
        result = handleSearchEmails(args); break;
      case "get_email":
        result = handleGetEmail(args); break;
      case "compose":
        result = handleCompose(args); break;
      case "draft_reply":
        result = handleCompose({ ...args, mode: "reply" }); break;
      case "move_email":
        result = handleMoveEmail(args); break;
      case "archive_emails":
        result = handleArchiveEmails(args); break;
      case "index_now":
        result = handleIndexNow(args); break;
      case "search_body":
        result = handleSearchBody(args); break;
      case "download_attachment":
        result = handleDownloadAttachment(args); break;
      default:
        return err(`Unknown tool: ${name}`);
    }
    const ms = Date.now() - t0;
    if (result.content?.[0]?.text) {
      result.content[0].text += `\n\n⏱ ${ms}ms`;
    }
    return result;
  } catch (error) {
    return err(error.message);
  }
});

function ok(text) {
  return { content: [{ type: "text", text }] };
}

function err(text) {
  return { content: [{ type: "text", text: `Error: ${text}` }], isError: true };
}

// --- list_mailboxes ---

function handleListMailboxes(args) {
  const rows = parseSqlite(`SELECT ROWID, url FROM mailboxes ORDER BY url`);
  if (!rows || rows.length === 0) return ok("No mailboxes found.");

  let unreadMap = {};
  if (args?.include_counts) {
    const counts = parseSqlite(`
      SELECT mb_id, COUNT(*) as unread FROM (
        SELECT l.mailbox_id as mb_id FROM labels l JOIN messages m ON m.ROWID = l.message_id WHERE m.read = 0
        UNION ALL
        SELECT m.mailbox as mb_id FROM messages m WHERE m.read = 0
      ) GROUP BY mb_id
    `);
    for (const c of counts) unreadMap[c.mb_id] = c.unread;
  }

  const lines = rows.map(r => {
    const account = accountFromUrl(r.url);
    const mailbox = mailboxFromUrl(r.url);
    if (args?.include_counts) {
      const unread = unreadMap[r.ROWID] || 0;
      return `${account}/${mailbox} (${unread} unread)`;
    }
    return `${account}/${mailbox}`;
  });
  return ok(lines.join("\n"));
}

// --- search_emails ---

// --- search_emails (SQLite direct read) ---

const ENVELOPE_DB = `${process.env.HOME}/Library/Mail/V10/MailData/Envelope Index`;
const MAIL_V10_DIR = `${process.env.HOME}/Library/Mail/V10`;

// --- .emlx direct file read ---

// Discover the internal UUID used inside .mbox dirs (same across all accounts)
let internalUuid = null;
function discoverInternalUuid() {
  try {
    const accountDirs = readdirSync(MAIL_V10_DIR).filter(d => /^[A-F0-9]{8}-/.test(d));
    for (const acctDir of accountDirs) {
      const mboxes = readdirSync(`${MAIL_V10_DIR}/${acctDir}`).filter(d => d.endsWith(".mbox"));
      for (const mbox of mboxes) {
        const entries = readdirSync(`${MAIL_V10_DIR}/${acctDir}/${mbox}`).filter(d => /^[A-F0-9]{8}-/.test(d));
        if (entries.length > 0) { internalUuid = entries[0]; return; }
      }
    }
  } catch {}
}

// Mail shards a mailbox's Data dir as Data/, Data/X/ or Data/X/Y/ (X, Y single digits,
// Y observed up to 7). Enumerate what exists rather than guessing the ranges.
function shardDirs(dataDir) {
  const out = [dataDir];
  let lvl1 = [];
  try { lvl1 = readdirSync(dataDir).filter(d => /^\d+$/.test(d)).map(d => `${dataDir}/${d}`); } catch { return out; }
  for (const a of lvl1) {
    out.push(a);
    try { for (const b of readdirSync(a)) if (/^\d+$/.test(b)) out.push(`${a}/${b}`); } catch {}
  }
  return out;
}

// Data dir for the mailbox a message physically lives in (Gmail: All Mail, not the label mailbox).
function messageDataDir(emailId) {
  if (!internalUuid) discoverInternalUuid();
  if (!internalUuid) return null;
  const rows = parseSqlite(`SELECT mb.url FROM messages m JOIN mailboxes mb ON mb.ROWID = m.mailbox WHERE m.ROWID = ${Number(emailId)}`);
  if (!rows.length) return null;
  const acctUuid = accountUuidFromUrl(rows[0].url);
  const mboxSegs = mboxPathFromUrl(rows[0].url);
  if (!acctUuid || !mboxSegs) return null;
  return `${MAIL_V10_DIR}/${acctUuid}/${mboxSegs.join("/")}/${internalUuid}/Data`;
}

function accountUuidFromUrl(url) {
  const m = url.match(/^[a-z]+:\/\/([A-F0-9-]+)\//i);
  return m ? m[1] : null;
}

// Map mailbox URL to .mbox filesystem path segments
// e.g. imap://UUID/%5BGmail%5D/All%20Mail -> ["[Gmail].mbox", "All Mail.mbox"]
function mboxPathFromUrl(url) {
  const m = url.match(/^[a-z]+:\/\/[A-F0-9-]+\/(.+)$/i);
  if (!m) return null;
  return m[1].split("/").map(s => decodeURIComponent(s) + ".mbox");
}

function findEmlxPath(emailId) {
  const dataDir = messageDataDir(emailId);
  if (!dataDir) return null;
  const id = Number(emailId);
  // .partial.emlx = body present, attachments not fully downloaded. Still readable.
  for (const dir of shardDirs(dataDir)) {
    for (const name of [`${id}.emlx`, `${id}.partial.emlx`]) {
      const path = `${dir}/Messages/${name}`;
      if (existsSync(path)) return path;
    }
  }
  return null;
}

function parseEmlx(filePath) {
  const buf = readFileSync(filePath);
  // First line is byte count of the RFC822 message
  const newline = buf.indexOf(0x0A); // \n
  const byteCount = parseInt(buf.slice(0, newline).toString("utf-8"), 10);
  // Slice by bytes, then decode to string
  const rfc822 = buf.slice(newline + 1, newline + 1 + byteCount).toString("utf-8");

  // Split headers from body
  const headerEnd = rfc822.indexOf("\r\n\r\n");
  const headerEndAlt = rfc822.indexOf("\n\n");
  let headers, body;
  if (headerEnd !== -1 && (headerEndAlt === -1 || headerEnd < headerEndAlt)) {
    headers = rfc822.slice(0, headerEnd);
    body = rfc822.slice(headerEnd + 4);
  } else if (headerEndAlt !== -1) {
    headers = rfc822.slice(0, headerEndAlt);
    body = rfc822.slice(headerEndAlt + 2);
  } else {
    headers = rfc822;
    body = "";
  }

  // Parse headers (unfold continuation lines)
  const unfolded = headers.replace(/\r?\n[ \t]+/g, " ");
  const getHeader = (name) => {
    const re = new RegExp(`^${name}:\\s*(.*)$`, "im");
    const m = unfolded.match(re);
    return m ? m[1].trim() : "";
  };

  const subject = decodeMimeWords(getHeader("Subject"));
  const from = decodeMimeWords(getHeader("From"));
  const to = decodeMimeWords(getHeader("To"));
  const cc = decodeMimeWords(getHeader("Cc") || getHeader("CC"));
  const date = getHeader("Date");
  const contentType = getHeader("Content-Type");
  const contentTransferEncoding = getHeader("Content-Transfer-Encoding");

  // Decode body
  let decodedBody = body;
  if (/quoted-printable/i.test(contentTransferEncoding)) {
    decodedBody = decodeQuotedPrintable(decodedBody);
  } else if (/base64/i.test(contentTransferEncoding)) {
    try {
      decodedBody = Buffer.from(decodedBody.replace(/\s/g, ""), "base64").toString("utf-8");
    } catch {}
  }

  // If HTML, extract text
  if (/text\/html/i.test(contentType)) {
    decodedBody = htmlToText(decodedBody);
  }

  // Handle multipart
  if (/multipart/i.test(contentType)) {
    decodedBody = extractTextFromMultipart(body, contentType);
  }

  return { subject, from, to, cc, date, body: decodedBody };
}

function decodeMimeWords(str) {
  // Decode =?charset?encoding?text?= sequences in headers
  // Also collapse whitespace between adjacent encoded words
  return str
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?([^?]+)\?([BQbq])\?([^?]*)\?=/g, (_, charset, enc, text) => {
      if (enc.toUpperCase() === "B") {
        return Buffer.from(text, "base64").toString(charset.toLowerCase() === "utf-8" ? "utf-8" : "latin1");
      }
      // Q encoding — collect bytes then decode as buffer for proper multi-byte
      const bytes = [];
      for (let i = 0; i < text.length; i++) {
        if (text[i] === "_") { bytes.push(0x20); }
        else if (text[i] === "=" && i + 2 < text.length) {
          bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
          i += 2;
        } else { bytes.push(text.charCodeAt(i)); }
      }
      return Buffer.from(bytes).toString("utf-8");
    });
}

function decodeQuotedPrintable(str) {
  // Remove soft line breaks first, then decode byte sequences via Buffer for proper UTF-8
  const stripped = str.replace(/=\r?\n/g, "");
  const bytes = [];
  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i] === "=" && i + 2 < stripped.length && /[0-9A-Fa-f]{2}/.test(stripped.slice(i + 1, i + 3))) {
      bytes.push(parseInt(stripped.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      // Push UTF-8 bytes of the literal character
      const code = stripped.charCodeAt(i);
      if (code < 0x80) bytes.push(code);
      else {
        // Multi-byte literal chars — encode to buffer and spread
        const b = Buffer.from(stripped[i], "utf-8");
        for (let j = 0; j < b.length; j++) bytes.push(b[j]);
      }
    }
  }
  return Buffer.from(bytes).toString("utf-8");
}

function htmlToText(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractTextFromMultipart(body, contentType) {
  const boundaryMatch = contentType.match(/boundary="?([^";\s]+)"?/i);
  if (!boundaryMatch) return body;
  const boundary = boundaryMatch[1];
  const parts = body.split("--" + boundary);

  // Prefer text/plain, fall back to text/html
  let plainText = null;
  let htmlText = null;
  for (const part of parts) {
    if (part.startsWith("--")) continue; // closing boundary
    const partHeaderEnd = part.indexOf("\r\n\r\n");
    const partHeaderEndAlt = part.indexOf("\n\n");
    let partHeaders, partBody;
    if (partHeaderEnd !== -1 && (partHeaderEndAlt === -1 || partHeaderEnd < partHeaderEndAlt)) {
      partHeaders = part.slice(0, partHeaderEnd);
      partBody = part.slice(partHeaderEnd + 4);
    } else if (partHeaderEndAlt !== -1) {
      partHeaders = part.slice(0, partHeaderEndAlt);
      partBody = part.slice(partHeaderEndAlt + 2);
    } else continue;

    const cte = partHeaders.match(/Content-Transfer-Encoding:\s*(\S+)/i);
    if (cte && /quoted-printable/i.test(cte[1])) {
      partBody = decodeQuotedPrintable(partBody);
    } else if (cte && /base64/i.test(cte[1])) {
      try { partBody = Buffer.from(partBody.replace(/\s/g, ""), "base64").toString("utf-8"); } catch {}
    }

    // Unfold continuation lines for header matching
    const unfoldedPH = partHeaders.replace(/\r?\n[ \t]+/g, " ");

    if (/text\/plain/i.test(unfoldedPH)) {
      plainText = partBody.trim();
    } else if (/text\/html/i.test(unfoldedPH)) {
      htmlText = htmlToText(partBody).trim();
    } else if (/multipart/i.test(unfoldedPH)) {
      // Nested multipart — recurse with unfolded Content-Type
      const nestedCt = unfoldedPH.match(/Content-Type:\s*(.+)/i);
      if (nestedCt) {
        const nested = extractTextFromMultipart(partBody, nestedCt[1]);
        if (nested) plainText = nested;
      }
    }
  }
  return plainText || htmlText || body;
}

// Map account UUIDs from mailbox URLs to human-readable names
// Eagerly cached at startup, SWR on subsequent calls
let accountNameCache = {};

function fetchAccountNames() {
  const fresh = {};
  try {
    const data = parseJxa(`
      var mail = Application("Mail");
      var accts = mail.accounts();
      var result = [];
      for (var i = 0; i < accts.length; i++) {
        result.push({id: accts[i].id(), name: accts[i].name()});
      }
      JSON.stringify(result);
    `);
    if (data) for (const a of data) fresh[a.id] = a.name;
  } catch (e) {}
  return fresh;
}

function refreshAccountNamesAsync() {
  // Fire-and-forget background refresh
  import("child_process").then(({ exec }) => {
    exec(
      `osascript -l JavaScript -e 'var m=Application("Mail");var a=m.accounts();var r=[];for(var i=0;i<a.length;i++)r.push(JSON.stringify({id:a[i].id(),name:a[i].name()}));r.join("\\n")'`,
      { timeout: 10000 },
      (err, stdout) => {
        if (err || !stdout) return;
        const fresh = {};
        for (const line of stdout.trim().split("\n")) {
          try {
            const o = JSON.parse(line);
            fresh[o.id] = o.name;
          } catch {}
        }
        if (Object.keys(fresh).length > 0) accountNameCache = fresh;
      }
    );
  });
}

let lastRefresh = 0;
function getAccountNames() {
  // Empty cache (Mail not running at startup, or imported for tests): fetch synchronously.
  if (Object.keys(accountNameCache).length === 0) accountNameCache = fetchAccountNames();
  // SWR: refresh at most once per 60s
  const now = Date.now();
  if (now - lastRefresh > 60000) {
    lastRefresh = now;
    refreshAccountNamesAsync();
  }
  return accountNameCache;
}

// Warm cache at startup (blocking, once) — guarded for testability
function warmCaches() {
  discoverInternalUuid();
  accountNameCache = fetchAccountNames();
}

function accountFromUrl(url) {
  // imap://UUID/... or local://UUID/...
  const m = url.match(/^[a-z]+:\/\/([A-F0-9-]+)\//i);
  if (!m) return "Local";
  const names = getAccountNames();
  return names[m[1]] || m[1];
}

function mailboxFromUrl(url) {
  // Last path segment, URL-decoded
  const parts = url.split("/");
  return decodeURIComponent(parts[parts.length - 1]);
}

// Return all mailbox path segments from a URL (e.g. ["[Gmail]", "All Mail"])
// Needed because JXA/AppleScript require traversing nested mailboxes
function mailboxPathFromUrl(url) {
  const m = url.match(/^[a-z]+:\/\/[A-F0-9-]+\/(.+)$/i);
  if (!m) return null;
  return m[1].split("/").map(s => decodeURIComponent(s));
}

// Generate JXA expression to resolve a (possibly nested) mailbox from path segments
// e.g. ["[Gmail]", "All Mail"] -> acct.mailboxes.whose({name:"[Gmail]"})[0].mailboxes.whose({name:"All Mail"})[0]
function jxaMailboxExpr(acctVar, pathSegments) {
  let expr = acctVar;
  for (const seg of pathSegments) {
    expr += `.mailboxes.whose({name:${JSON.stringify(seg)}})()[0]`;
  }
  return expr;
}

// Generate AppleScript expression to resolve a (possibly nested) mailbox
// e.g. ["[Gmail]", "All Mail"] -> mailbox "All Mail" of mailbox "[Gmail]" of account "acctName"
function asMailboxExpr(acctName, pathSegments) {
  let expr = `account "${escapeForAppleScript(acctName)}"`;
  for (const seg of pathSegments) {
    expr = `mailbox "${escapeForAppleScript(seg)}" of ${expr}`;
  }
  return expr;
}

function runSqlite(query) {
  const q = query.replace(/\s+/g, " ").trim();
  try {
    return execSync(
      `sqlite3 -json ${JSON.stringify(ENVELOPE_DB)} ${JSON.stringify(q)}`,
      { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 10000 }
    ).trim();
  } catch (error) {
    throw new Error(`SQLite error: ${(error.message || "").slice(0, 200)}`);
  }
}

function parseSqlite(query) {
  const raw = runSqlite(query);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

// --- FTS5 body search index (incremental, built on read) ---

const FTS_DIR = join(process.env.HOME || "", ".mcp-apple-mail");
const FTS_DB = join(FTS_DIR, "body-index.db");

function ensureFtsDb() {
  if (!existsSync(FTS_DIR)) mkdirSync(FTS_DIR, { recursive: true });
  runFts(`CREATE TABLE IF NOT EXISTS indexed (id INTEGER PRIMARY KEY, ts INTEGER)`);
  // Use a content-less FTS5 table — we only need to search, not retrieve body from the index.
  // We store a snippet-sized body_snippet for search result previews.
  runFts(`CREATE TABLE IF NOT EXISTS bodies (id INTEGER PRIMARY KEY, subject TEXT, sender TEXT, body TEXT)`);
  runFts(`CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(subject, sender, body, content='bodies', content_rowid='id')`);
  // Triggers to keep FTS in sync with bodies table
  runFts(`CREATE TRIGGER IF NOT EXISTS bodies_ai AFTER INSERT ON bodies BEGIN INSERT INTO fts(rowid, subject, sender, body) VALUES (new.id, new.subject, new.sender, new.body); END`);
  runFts(`CREATE TRIGGER IF NOT EXISTS bodies_ad AFTER DELETE ON bodies BEGIN INSERT INTO fts(fts, rowid, subject, sender, body) VALUES ('delete', old.id, old.subject, old.sender, old.body); END`);
}

function runFts(query) {
  const q = query.replace(/\s+/g, " ").trim();
  try {
    return execSync(
      `sqlite3 -cmd ".timeout 5000" ${JSON.stringify(FTS_DB)} ${JSON.stringify(q)}`,
      { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 10000 }
    ).trim();
  } catch (error) {
    throw new Error(`FTS error: ${(error.message || "").slice(0, 200)}`);
  }
}

function parseFts(query) {
  const q = query.replace(/\s+/g, " ").trim();
  try {
    const raw = execSync(
      `sqlite3 -json -cmd ".timeout 5000" ${JSON.stringify(FTS_DB)} ${JSON.stringify(q)}`,
      { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 10000 }
    ).trim();
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function sqlStr(s, max = 50000) {
  // NUL bytes (seen in real subjects) truncate the SQL file when sqlite3 reads it.
  return "'" + String(s || "").replace(/\0/g, "").slice(0, max).replace(/'/g, "''") + "'";
}

// Insert a batch of parsed emails into the FTS db in one sqlite3 process, one transaction.
// SQL goes through a file: bodies are far too big for argv.
function indexBatch(rows) {
  if (!rows.length) return;
  const ts = Math.floor(Date.now() / 1000);
  const sql = ["BEGIN;"];
  for (const r of rows) {
    sql.push(`INSERT OR REPLACE INTO bodies (id, subject, sender, body) VALUES (${Number(r.id)}, ${sqlStr(r.subject, 1000)}, ${sqlStr(r.sender, 1000)}, ${sqlStr(r.body)});`);
    sql.push(`INSERT OR REPLACE INTO indexed (id, ts) VALUES (${Number(r.id)}, ${ts});`);
  }
  sql.push("COMMIT;");
  const f = join(tmpdir(), `mcp-mail-fts-${process.pid}-${Date.now()}.sql`);
  writeFileSync(f, sql.join("\n"));
  try {
    execSync(`sqlite3 -cmd ".timeout 5000" ${JSON.stringify(FTS_DB)} < ${JSON.stringify(f)}`, { encoding: "utf-8", timeout: 60000, shell: "/bin/bash" });
  } finally {
    try { unlinkSync(f); } catch {}
  }
}

function indexEmail(emailId, subject, sender, bodyText) {
  try { indexBatch([{ id: emailId, subject, sender, body: bodyText }]); } catch {}
}

// Message ids not yet in the FTS index, newest first. The two databases are separate files,
// so the diff is done here, not in SQL.
function unindexedIds() {
  const all = parseSqlite(`SELECT ROWID as id FROM messages ORDER BY date_received DESC`).map(r => r.id);
  const done = new Set(parseFts(`SELECT id FROM indexed`).map(r => r.id));
  return all.filter(id => !done.has(id));
}

// --- Background indexing ---
// Index up to `limit` unindexed emails, in batches of 200 per sqlite3 process.
// Returns how many were indexed. Synchronous; callers bound it with `limit`.
function runIndexPass(limit = Infinity) {
  let n = 0;
  try {
    const ids = unindexedIds().slice(0, limit);
    for (let i = 0; i < ids.length; i += 200) {
      const rows = [];
      for (const id of ids.slice(i, i + 200)) {
        try {
          const p = findEmlxPath(id);
          // No file on disk (not downloaded yet): record as indexed with empty body so we stop retrying it.
          const d = p ? parseEmlx(p) : { subject: "", from: "", body: "" };
          rows.push({ id, subject: d.subject, sender: d.from, body: d.body });
        } catch {}
      }
      indexBatch(rows);
      n += rows.length;
    }
  } catch (e) {
    console.error(`index pass failed: ${e.message}`);
  }
  return n;
}

function handleIndexNow(args) {
  const limit = Number(args?.limit) || 5000;
  const n = runIndexPass(limit);
  const stats = ftsIndexStats();
  return ok(`Indexed ${n.toLocaleString()} emails this pass. ${ftsStatusLine(stats)}${stats.pending ? " Call index_now again to continue." : ""}`);
}

// Background: small batches on a timer so the server starts at once and stays responsive.
function startBackfill() {
  try { ensureFtsDb(); } catch (e) { console.error(`FTS init failed: ${e.message}`); return; }
  const tick = () => {
    const n = runIndexPass(200);
    setTimeout(tick, n ? 250 : 30000).unref(); // drain fast, then poll every 30s for new mail
  };
  setTimeout(tick, 1000).unref();
}

function ftsIndexStats() {
  try {
    const indexed = parseFts(`SELECT COUNT(*) as n FROM indexed`);
    const total = parseSqlite(`SELECT COUNT(*) as n FROM messages`);
    const i = indexed[0]?.n || 0, t = total[0]?.n || 0;
    return { indexed: i, total: t, pending: Math.max(0, t - i) };
  } catch {
    return { indexed: 0, total: 0, pending: 0 };
  }
}

function ftsStatusLine(stats) {
  const { indexed, total, pending } = stats;
  if (!total) return "Index: empty";
  const pct = Math.round((indexed / total) * 100);
  if (pending === 0) return `Index: complete (${indexed.toLocaleString()} emails)`;
  return `Index: ${pct}% complete — ${indexed.toLocaleString()}/${total.toLocaleString()} indexed, ${pending.toLocaleString()} queued. Results may be incomplete.`;
}

function handleSearchEmails(args) {
  const query = args?.query || null;
  const mailboxName = args?.mailbox || "INBOX";
  const accountName = args?.account || null;
  const limit = args?.limit || 10;
  const sortDir = args?.sort === "asc" ? "ASC" : "DESC";

  // Resolve mailbox filter: match by last URL segment (URL-encoded in the DB)
  const encodedMbox = encodeURIComponent(mailboxName).replace(/'/g, "''");
  const escapedQuery = query ? query.replace(/'/g, "''") : "";

  // Account filter: resolve name to UUID if provided
  let accountUuidFilter = null;
  if (accountName) {
    const names = getAccountNames();
    for (const [uuid, name] of Object.entries(names)) {
      if (name === accountName) { accountUuidFilter = uuid; break; }
    }
  }

  const accountClauseLabel = accountUuidFilter
    ? `AND mb_label.url LIKE '%${accountUuidFilter}%'`
    : "";
  const accountClauseDirect = accountUuidFilter
    ? `AND mb.url LIKE '%${accountUuidFilter}%'`
    : "";

  // Messages live in the "source" mailbox (e.g. All Mail for Gmail).
  // The labels table maps them to virtual mailboxes (INBOX, Sent, etc.).
  // For source mailboxes (Spam, Trash, Drafts) messages are stored directly.
  const searchClause = query
    ? `AND (s.subject LIKE '%${escapedQuery}%' OR a.address LIKE '%${escapedQuery}%' OR a.comment LIKE '%${escapedQuery}%')`
    : "";
  const unreadClause = args?.unread_only ? "AND m.read = 0" : "";

  // Date filters: Envelope Index stores date_received as Unix timestamp (seconds)
  let dateClause = "";
  if (args?.after) {
    const ts = Math.floor(new Date(args.after).getTime() / 1000);
    if (!isNaN(ts)) dateClause += ` AND m.date_received >= ${ts}`;
  }
  if (args?.before) {
    const ts = Math.floor(new Date(args.before + "T23:59:59").getTime() / 1000);
    if (!isNaN(ts)) dateClause += ` AND m.date_received <= ${ts}`;
  }

  const sql = `
    SELECT m.ROWID as id, COALESCE(m.subject_prefix, '') || s.subject as subject, a.address as sender_addr, a.comment as sender_name,
           m.date_received, m.read, m.flagged, mb_label.url as mailbox_url
    FROM messages m
    JOIN labels l ON l.message_id = m.ROWID
    JOIN mailboxes mb_label ON mb_label.ROWID = l.mailbox_id
    JOIN subjects s ON s.ROWID = m.subject
    JOIN addresses a ON a.ROWID = m.sender
    WHERE mb_label.url LIKE '%/${encodedMbox}'
      ${accountClauseLabel}
      ${searchClause}
      ${unreadClause}
      ${dateClause}
    ORDER BY m.date_received ${sortDir}
    LIMIT ${limit};
  `;

  let data;
  try {
    data = parseSqlite(sql);
  } catch (e) {
    data = [];
  }

  if (!data || data.length === 0) {
    // Try direct mailbox match (for Spam, Trash, Drafts which store messages directly)
    const directSql = `
      SELECT m.ROWID as id, COALESCE(m.subject_prefix, '') || s.subject as subject, a.address as sender_addr, a.comment as sender_name,
             m.date_received, m.read, m.flagged, mb.url as mailbox_url
      FROM messages m
      JOIN mailboxes mb ON mb.ROWID = m.mailbox
      JOIN subjects s ON s.ROWID = m.subject
      JOIN addresses a ON a.ROWID = m.sender
      WHERE mb.url LIKE '%/${encodedMbox}'
        ${accountClauseDirect}
        ${searchClause}
        ${unreadClause}
        ${dateClause}
      ORDER BY m.date_received ${sortDir}
      LIMIT ${limit};
    `;
    data = parseSqlite(directSql);
  }

  if (!data || data.length === 0) {
    return ok(query ? `No emails matching "${query}".` : "No emails found.");
  }

  // Batch check which messages have attachments
  const ids = data.map(e => e.id);
  const attSet = new Set();
  if (ids.length) {
    try {
      const attRows = parseSqlite(`SELECT DISTINCT message FROM attachments WHERE message IN (${ids.join(",")})`);
      for (const r of attRows) attSet.add(r.message);
    } catch {}
  }

  const lines = data.map((e) => {
    const date = e.date_received
      ? new Date(e.date_received * 1000).toISOString().slice(0, 10)
      : "";
    const from = e.sender_name && e.sender_addr
      ? `${e.sender_name} <${e.sender_addr}>`
      : e.sender_name || e.sender_addr || "";
    const account = accountFromUrl(e.mailbox_url || "");
    const mailbox = mailboxFromUrl(e.mailbox_url || "");
    const att = attSet.has(e.id) ? "📎 " : "";
    return `ID:${e.id} | ${e.read ? " " : "●"} ${e.flagged ? "⚑ " : ""}${att}${date} | ${from} | ${e.subject || "(no subject)"} [${account}/${mailbox}]`;
  });
  return ok(lines.join("\n"));
}

// --- get_email ---

function handleGetEmail(args) {
  const emailId = args?.email_id;
  if (!emailId) return err("email_id is required.");

  // Try direct .emlx file read first (~1ms vs ~3s JXA)
  const emlxPath = findEmlxPath(emailId);
  if (emlxPath) {
    try {
      const data = parseEmlx(emlxPath);
      // Get read/flagged status from SQLite
      const meta = parseSqlite(`SELECT read, flagged FROM messages WHERE ROWID = ${Number(emailId)}`);
      const isRead = meta.length > 0 ? !!meta[0].read : false;
      const isFlagged = meta.length > 0 ? !!meta[0].flagged : false;

      const body = cleanBody(data.body);

      // Index body text for FTS5 search (fire-and-forget)
      try { indexEmail(emailId, data.subject, data.from, data.body); } catch {}

      const parts = [
        `Subject: ${data.subject || "(no subject)"}`,
        `From: ${data.from}`,
        `To: ${data.to}`,
      ];
      if (data.cc) parts.push(`CC: ${data.cc}`);
      parts.push(`Date: ${data.date}`);
      parts.push(`Read: ${isRead} | Flagged: ${isFlagged}`);
      const attInfo = getAttachmentInfo(emailId);
      if (attInfo.length) parts.push(formatAttachmentList(attInfo));
      parts.push("");
      parts.push(body);
      return ok(parts.join("\n"));
    } catch (e) {
      console.error(`emlx parse failed for ${emailId}: ${e.message}`);
      // Fall through to JXA
    }
  }

  // JXA fallback if .emlx not found or parse failed
  const loc = findMessageLocation(emailId);
  if (!loc) return err(`Email ${emailId} not found.`);

  const data = parseJxa(`
    const mail = Application("Mail");
    const msgId = ${Number(emailId)};
    let found = null;
    try {
      const acct = mail.accounts.whose({name: ${escapeForJxa(loc.account)}})()[0];
      const box = ${jxaMailboxExpr("acct", loc.mailboxPath || [loc.mailbox])};
      const msgs = box.messages.whose({id: msgId})();
      if (msgs.length > 0) {
        const m = msgs[0];
        found = {
          id: m.id(),
          subject: m.subject() || "(no subject)",
          from: m.sender() || "",
          to: m.toRecipients().map(r => { try { return r.address() } catch(e) { return "" } }).filter(Boolean).join(", "),
          cc: m.ccRecipients().map(r => { try { return r.address() } catch(e) { return "" } }).filter(Boolean).join(", "),
          date: m.dateReceived().toISOString(),
          read: m.readStatus(),
          flagged: m.flaggedStatus(),
          body: m.content() || ""
        };
      }
    } catch(e) {}
    JSON.stringify(found);
  `);

  if (!data) return err(`Email ${emailId} not found.`);

  const body = cleanBody(data.body);

  // Index body text for FTS5 search (fire-and-forget)
  try { indexEmail(emailId, data.subject, data.from, data.body); } catch {}

  const parts = [
    `Subject: ${data.subject}`,
    `From: ${data.from}`,
    `To: ${data.to}`,
  ];
  if (data.cc) parts.push(`CC: ${data.cc}`);
  parts.push(`Date: ${data.date}`);
  parts.push(`Read: ${data.read} | Flagged: ${data.flagged}`);
  const attInfo = getAttachmentInfo(emailId);
  if (attInfo.length) parts.push(formatAttachmentList(attInfo));
  parts.push("");
  parts.push(body);

  return ok(parts.join("\n"));
}

// --- search_body ---

function handleSearchBody(args) {
  const query = args?.query;
  if (!query) return err("query is required.");
  const limit = args?.limit || 20;

  const escapedQuery = query.replace(/'/g, "''").replace(/"/g, '""');

  // FTS5 MATCH query with BM25 ranking
  const results = parseFts(`
    SELECT b.id, b.subject, b.sender, snippet(fts, 2, '>>>', '<<<', '...', 40) as snippet,
           rank
    FROM fts
    JOIN bodies b ON b.id = fts.rowid
    WHERE fts MATCH '"${escapedQuery}"'
    ORDER BY rank
    LIMIT ${limit}
  `);

  if (!results || results.length === 0) {
    // Also try unquoted for multi-word queries
    const results2 = parseFts(`
      SELECT b.id, b.subject, b.sender, snippet(fts, 2, '>>>', '<<<', '...', 40) as snippet,
             rank
      FROM fts
      JOIN bodies b ON b.id = fts.rowid
      WHERE fts MATCH '${escapedQuery}'
      ORDER BY rank
      LIMIT ${limit}
    `);
    if (!results2 || results2.length === 0) {
      const stats = ftsIndexStats();
      return ok(`No results for "${query}". ${ftsStatusLine(stats)}`);
    }
    return formatBodyResults(results2, query);
  }
  return formatBodyResults(results, query);
}

function formatBodyResults(results, query) {
  const stats = ftsIndexStats();
  // Get dates from Envelope Index for these message IDs
  const ids = results.map(r => r.id).join(",");
  let dateMap = {};
  try {
    const dates = parseSqlite(`SELECT ROWID as id, date_received FROM messages WHERE ROWID IN (${ids})`);
    for (const d of dates) dateMap[d.id] = d.date_received;
  } catch {}

  const lines = results.map(r => {
    const date = dateMap[r.id]
      ? new Date(dateMap[r.id] * 1000).toISOString().slice(0, 10)
      : "";
    const snippet = (r.snippet || "").replace(/\n/g, " ").trim();
    return `ID:${r.id} | ${date} | ${r.sender || ""} | ${r.subject || "(no subject)"}\n  ${snippet}`;
  });
  lines.push(`\n${ftsStatusLine(stats)}`);
  return ok(lines.join("\n"));
}

// --- compose ---
//
// DRAFT ONLY. Nothing in this section may send. Every path ends with an open
// compose window that the human reviews and sends (or bins) themselves.
//
// Mail.app scripting facts (verified 2026-08-28 with screenshots + saved .emlx):
// - On a reply/forward window, `set content` and paragraph inserts REPLACE the
//   whole body: signature and Mail's quoted original are gone. `make new
//   attachment` lands at the top. So replies use the GUI path instead: put the
//   body (RTF) on the clipboard, paste at the caret, then paste file URLs. That
//   keeps Mail's native signature + cite-bar quote and orders things body →
//   attachments → signature → quote, exactly like a hand-written reply.
// - The paste needs the window frontmost for ~1s; focus is handed back to the
//   previous app afterwards. Pasting before the body finishes loading is
//   silently dropped, so we wait for Mail's attribution line to appear.
// - `content`/`attachments` readback on a reply window never reflect the GUI.
//   Verification reads the body text through Accessibility instead.
// - New messages (no quote/signature to lose) still use `set content`.

function htmlToRtfFile(htmlBody) {
  const rtfPath = join(tmpdir(), `mcp-mail-body-${Date.now()}-${process.pid}.rtf`);
  const rtf = execSync(
    `textutil -stdin -format html -inputencoding UTF-8 -convert rtf -stdout`,
    { input: Buffer.from(htmlBody, "utf8"), timeout: 10000 }
  );
  writeFileSync(rtfPath, rtf);
  return rtfPath;
}

// AppleScript: set RTF body on msgVar, retry until readback contains `marker`.
function asSetBodyVerified(msgVar, rtfPath, marker) {
  return `
    set bodyOk to false
    repeat 20 times
        set content of ${msgVar} to (read POSIX file "${escapeForAppleScript(rtfPath)}" as «class RTF »)
        delay 0.5
        if (content of ${msgVar}) contains "${escapeForAppleScript(marker)}" then
            set bodyOk to true
            exit repeat
        end if
    end repeat
    if not bodyOk then return "Error: body did not stick after 20 tries (Mail.app busy?)"`;
}

function asAttach(msgVar, paths) {
  if (!paths.length) return "";
  const lines = paths.map(p =>
    `        make new attachment with properties {file name:POSIX file "${escapeForAppleScript(p)}"} at after the last paragraph`
  );
  return `\n    tell content of ${msgVar}\n${lines.join("\n")}\n    end tell`;
}

function clipboardText() {
  try { return execSync("pbpaste", { encoding: "utf-8", timeout: 3000 }); } catch { return null; }
}
function setClipboardText(text) {
  try { execSync("pbcopy", { input: text, timeout: 3000 }); } catch {}
}

function resolveAttachments(list) {
  const paths = (list || []).map(p => String(p).replace(/^~(?=\/)/, process.env.HOME));
  for (const p of paths) {
    if (!existsSync(p) || !statSync(p).isFile()) throw new Error(`Attachment not found: ${p}`);
  }
  return paths;
}

function handleCompose(args) {
  const mode = args?.mode;
  const body = args?.body || "";
  const attachments = resolveAttachments(args?.attachments);
  let rtfPath = null;
  try {
    if (mode === "new") {
      const subject = args?.subject || "";
      const to = args?.to || "";
      const cc = args?.cc || "";
      const from = args?.from || "";
      let script = `tell application "Mail"
    set newMsg to make new outgoing message with properties {subject:"${escapeForAppleScript(subject)}", visible:true}`;
      if (to) script += `\n    tell newMsg\n        make new to recipient at end of to recipients with properties {address:"${escapeForAppleScript(to)}"}\n    end tell`;
      if (cc) script += `\n    tell newMsg\n        make new cc recipient at end of cc recipients with properties {address:"${escapeForAppleScript(cc)}"}\n    end tell`;
      if (from) script += `\n    tell newMsg\n        set sender to "${escapeForAppleScript(from)}"\n    end tell`;
      if (body.trim()) {
        rtfPath = htmlToRtfFile(markdownToHtml(body));
        // Marker: first non-empty line of the markdown, stripped of emphasis chars.
        const marker = body.split(/\r?\n/).map(l => l.replace(/[*_#`>]/g, "").trim()).find(Boolean).slice(0, 40);
        script += asSetBodyVerified("newMsg", rtfPath, marker);
      }
      script += asAttach("newMsg", attachments);
      script += `\n    return "ok"\nend tell`;
      const result = runAppleScript(script);
      if (result.startsWith("Error:")) return err(result.slice(7));
      return ok(`Draft opened: "${subject}"${attachments.length ? ` with ${attachments.length} attachment(s)` : ""}. Body verified. Not sent — review in Mail.app.`);
    }

    if (mode === "reply" || mode === "forward") {
      const emailId = Number(args?.email_id);
      if (!emailId) return err("email_id required for reply/forward.");
      const replyAll = !!args?.reply_all;
      const loc = findMessageLocation(emailId);
      if (!loc) return err(`Email ${emailId} not found.`);
      if (!body.trim()) return err("body required.");

      const action = mode === "reply"
        ? (replyAll ? "reply msg with opening window and reply to all" : "reply msg with opening window")
        : "forward msg with opening window";
      const sourceExpr = asMailboxExpr(loc.account, loc.mailboxPath || [loc.mailbox]);
      rtfPath = htmlToRtfFile(markdownToHtml(body));
      const firstLine = body.split(/\r?\n/).map(l => l.replace(/[*_#`>]/g, "").trim()).find(Boolean).slice(0, 40);
      const savedClip = clipboardText();

      // 1. Open the window, wait for Mail to fill in signature + quote, paste the body at the caret.
      const open = runAppleScript(`
set prevApp to (path to frontmost application as text)
tell application "Mail"
    set targetBox to ${sourceExpr}
    set msgs to (every message of targetBox whose id is ${emailId})
    if (count of msgs) is 0 then return "Error: Email ${emailId} not found."
    set msg to item 1 of msgs
    set replyMsg to (${action})
    set the clipboard to (read POSIX file "${escapeForAppleScript(rtfPath)}" as «class RTF »)
    set AppleScript's text item delimiters to ", "
    set recips to "|" & ((address of every to recipient of replyMsg) as text) & "|" & ((address of every cc recipient of replyMsg) as text)
end tell
-- the body (signature + quote) fills in asynchronously; a paste before that is dropped
delay 1.5
tell application "Mail" to activate
tell application "System Events" to tell process "Mail"
    set frontmost to true
    delay 0.4
    keystroke "v" using command down
    delay 0.4
end tell
return prevApp & recips`, { timeout: 60000 });
      if (open.startsWith("Error:")) return err(open.slice(7));
      const [prevApp, to, cc] = open.split("|");

      // 2. Files: one at a time — file URL on the clipboard, ⌘V, wait for Mail to finish inserting
      //    (pasting several at once drops some; keystrokes during the insert lose attachments).
      for (const p of attachments) {
        runJxa(`ObjC.import("AppKit");
          var pb = $.NSPasteboard.generalPasteboard; pb.clearContents;
          pb.writeObjects($([$.NSURL.fileURLWithPath(${JSON.stringify(p)})]));`);
        runAppleScript(`tell application "System Events" to tell process "Mail" to keystroke "v" using command down`);
        execSync(`sleep ${(0.8 + statSync(p).size / 4e6).toFixed(1)}`); // ponytail: size-based wait; poll Mail's "Message Size" label if this proves flaky
      }

      // 3. Verify: select all, copy, read the clipboard — the editor's real text, ~0.5s.
      //    Then caret to the top so the window shows the body, and give focus back.
      runAppleScript(`tell application "System Events" to tell process "Mail"
    keystroke "a" using command down
    delay 0.2
    keystroke "c" using command down
    delay 0.3
    key code 126 using command down
end tell`);
      const all = clipboardText() || "";
      const title = runAppleScript(`tell application "System Events" to tell process "Mail" to get name of window 1`);
      runAppleScript(`tell application "${escapeForAppleScript(prevApp)}" to activate`);
      if (savedClip !== null) setClipboardText(savedClip);

      const hasBody = all.includes(firstLine);
      const hasQuote = /wrote:|skrev|Forwarded message|Begin forwarded/i.test(all);
      if (!hasBody) return err(`Body not found in the ${mode} window after paste (window "${title}"). Draft left open for inspection.`);
      return ok([
        `${mode === "reply" ? (replyAll ? "Reply-all" : "Reply") : "Forward"} draft opened for email ${emailId}. Body verified on screen${hasQuote ? ", Mail's quoted original intact" : " (quote not detected — check the window)"}.`,
        `To: ${to || "(none)"}`,
        cc ? `Cc: ${cc}` : null,
        attachments.length ? `Attached: ${attachments.map(p => basename(p)).join(", ")}` : null,
        "Not sent — the human reviews and sends from Mail.app.",
      ].filter(Boolean).join("\n"));
    }

    return err(`Invalid mode: ${mode}. Use "new", "reply", or "forward".`);
  } finally {
    if (rtfPath) try { unlinkSync(rtfPath); } catch {}
  }
}

// --- move_email ---

function handleMoveEmail(args) {
  const emailId = args?.email_id;
  const destination = args?.destination;
  const accountName = args?.account || null;

  if (!emailId || !destination) return err("email_id and destination required.");

  const loc = findMessageLocation(emailId);
  if (!loc) return err(`Email ${emailId} not found.`);

  const destAccount = accountName || loc.account;

  // Parse destination as path segments (e.g. "[Gmail]/Trash" -> ["[Gmail]", "Trash"])
  const destPath = destination.includes("/") ? destination.split("/") : [destination];
  const sourceExpr = asMailboxExpr(loc.account, loc.mailboxPath || [loc.mailbox]);
  const destExpr = asMailboxExpr(destAccount, destPath);

  const script = `tell application "Mail"
    set targetBox to ${sourceExpr}
    set msgs to (every message of targetBox whose id is ${Number(emailId)})
    if (count of msgs) is 0 then return "Error: Email ${emailId} not found."
    set targetMsg to item 1 of msgs
    set destBox to missing value
    try
        set destBox to ${destExpr}
    end try
    if destBox is missing value then return "Error: Mailbox '${escapeForAppleScript(destination)}' not found."
    move targetMsg to destBox
    return "Moved email ${emailId} to ${escapeForAppleScript(destination)}."
end tell`;

  const result = runAppleScript(script);
  if (result.startsWith("Error:")) return err(result.slice(7));
  return ok(result);
}

// --- archive_emails ---

function handleArchiveEmails(args) {
  const emailIds = args?.email_ids;
  if (!emailIds || emailIds.length === 0) return err("email_ids required.");

  // Find which account/mailbox each message is in via SQLite
  const byMailbox = {};
  const notFound = [];
  for (const id of emailIds) {
    const loc = findMessageLocation(Number(id));
    if (!loc) {
      notFound.push(id);
      continue;
    }
    const key = `${loc.account}|||${loc.mailbox}`;
    if (!byMailbox[key]) byMailbox[key] = { account: loc.account, mailbox: loc.mailbox, mailboxPath: loc.mailboxPath || [loc.mailbox], ids: [] };
    byMailbox[key].ids.push(Number(id));
  }

  let archived = 0;
  const errors = [];

  for (const { account, mailbox, mailboxPath, ids } of Object.values(byMailbox)) {
    // Build JXA to find the archive mailbox, searching both top-level and nested (Gmail [Gmail]/All Mail)
    const archiveCandidates = [
      ["All Mail"],           // top-level
      ["[Gmail]", "All Mail"],// Gmail nested
      ["Archive"],            // top-level
      ["All Messages"],       // top-level
      ["[Gmail]", "All Messages"], // Gmail nested variant
    ];
    // Generate JXA search code for each candidate
    const candidateChecks = archiveCandidates.map(path => {
      const expr = jxaMailboxExpr("acct", path);
      // Call .name() to verify the mailbox is real — dead specifiers throw here
      return `if (!archiveBox) { try { var c = ${expr}; c.name(); archiveBox = c; } catch(e) {} }`;
    }).join("\n      ");

    const sourceBoxExpr = jxaMailboxExpr("acct", mailboxPath);

    const script = `
      var mail = Application("Mail");
      var acct = mail.accounts.whose({name: ${JSON.stringify(account)}})()[0];
      var box = ${sourceBoxExpr};

      // Find the archive mailbox (search nested mailboxes for Gmail)
      var archiveBox = null;
      ${candidateChecks}

      if (!archiveBox) { throw new Error("No archive mailbox found for account " + ${JSON.stringify(account)}); }

      var count = 0;
      ${JSON.stringify(ids)}.forEach(function(id) {
        try {
          var msg = box.messages.byId(id);
          mail.move(msg, {to: archiveBox});
          count++;
        } catch(e) {}
      });
      count;
    `;

    try {
      const count = parseInt(runJxa(script, { timeout: 120000 }), 10) || 0;
      archived += count;
    } catch (e) {
      errors.push(`${account}/${mailbox}: ${e.message}`);
    }
  }

  const parts = [`Archived ${archived} of ${emailIds.length} emails.`];
  if (notFound.length > 0) parts.push(`Not found: ${notFound.join(", ")}`);
  if (errors.length > 0) parts.push(`Errors: ${errors.join("; ")}`);
  return ok(parts.join("\n"));
}

// --- attachments ---

function getAttachmentInfo(emailId) {
  const id = Number(emailId);
  return parseSqlite(`SELECT attachment_id, name FROM attachments WHERE message = ${id}`);
}

function findAttachmentDir(emailId) {
  const dataDir = messageDataDir(emailId);
  if (!dataDir) return null;
  for (const dir of shardDirs(dataDir)) {
    const att = `${dir}/Attachments/${Number(emailId)}`;
    if (existsSync(att)) return att;
  }
  return null;
}

function formatAttachmentList(attachments) {
  if (!attachments.length) return "";
  const lines = [`Attachments (${attachments.length}):`];
  for (const att of attachments) {
    lines.push(`  - ${att.name}`);
  }
  return "\n" + lines.join("\n");
}

function uniquePath(dir, emailId, filename) {
  const ext = extname(filename);
  const base = basename(filename, ext);
  const prefix = `${emailId}_${base}`;
  let candidate = join(dir, `${prefix}${ext}`);
  if (!existsSync(candidate)) return candidate;
  let n = 1;
  while (true) {
    candidate = join(dir, `${prefix}_${n}${ext}`);
    if (!existsSync(candidate)) return candidate;
    n++;
  }
}

function handleDownloadAttachment(args) {
  const emailId = args?.email_id;
  if (!emailId) return err("email_id is required.");

  const attachmentName = args?.attachment_name || null;
  const saveDir = args?.destination || "/tmp/mail-attachments";

  const attachments = getAttachmentInfo(emailId);
  if (!attachments.length) return err(`Email ${emailId} has no attachments.`);

  const attDir = findAttachmentDir(emailId);
  if (!attDir) return err(`Attachment files not found on disk for email ${emailId}. The email may not be fully downloaded.`);

  // Filter to requested attachment if specified
  const toDownload = attachmentName
    ? attachments.filter(a => a.name === attachmentName)
    : attachments;

  if (!toDownload.length) {
    const available = attachments.map(a => a.name).join(", ");
    return err(`Attachment "${attachmentName}" not found. Available: ${available}`);
  }

  mkdirSync(saveDir, { recursive: true });

  const output = [];
  for (const att of toDownload) {
    // Attachment files live at {attDir}/{attachment_id}/{filename}
    const srcDir = join(attDir, att.attachment_id);
    if (!existsSync(srcDir)) {
      output.push(`Skipped: ${att.name} (not on disk)`);
      continue;
    }
    // Find the actual file in the attachment_id subdirectory
    const files = readdirSync(srcDir).filter(f => !f.startsWith("."));
    if (!files.length) {
      output.push(`Skipped: ${att.name} (empty directory)`);
      continue;
    }
    const srcFile = join(srcDir, files[0]);
    const destFile = uniquePath(saveDir, emailId, att.name);
    copyFileSync(srcFile, destFile);
    const size = statSync(destFile).size;
    output.push(`Saved: ${destFile} (${size} bytes)`);
  }

  return ok(output.join("\n"));
}

// --- Exports for testing ---
export {
  stripSignature,
  stripQuotedReplies,
  cleanBody,
  markdownToHtml,
  escapeForAppleScript,
  escapeForJxa,
  decodeMimeWords,
  decodeQuotedPrintable,
  htmlToText,
  extractTextFromMultipart,
  parseEmlx,
  handleCompose,
  handleIndexNow,
  ftsIndexStats,
  findEmlxPath,
  findAttachmentDir,
  shardDirs,
  accountUuidFromUrl,
  mailboxFromUrl,
  mboxPathFromUrl,
};

// --- Start server ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("mcp-apple-mail running on stdio");
}

// Only run server + warm caches when executed directly, not when imported for testing
const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^\//, ""));
if (isDirectRun) {
  warmCaches();
  startBackfill();
  main().catch(console.error);
}
