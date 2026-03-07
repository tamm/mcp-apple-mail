import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execSync, exec } from "child_process";
import { readFileSync, accessSync, readdirSync, existsSync, mkdirSync, constants as fsConst } from "fs";
import { join } from "path";

const server = new Server(
  { name: "mcp-apple-mail", version: "1.0.0" },
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
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__(.+?)__/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  html = html.replace(/(?<!\w)_(.+?)_(?!\w)/g, "<em>$1</em>");
  html = html.replace(/`(.+?)`/g, "<code>$1</code>");
  html = html.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  html = html.replace(/^[\-\*] (.+)$/gm, "<li>$1</li>");
  html = html.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");
  html = html.replace(/((?:<li>.*<\/li>(?:\n|$))+)/g, (match) => {
    return "<ul>" + match.trim().replace(/\n/g, "") + "</ul>";
  });
  html = html.replace(/\n\n+/g, "</p><p>");
  html = html.replace(/\n/g, "<br>");
  html = "<p>" + html + "</p>";
  html = html.replace(/<p><\/p>/g, "");
  html = html.replace(/<p>(<h[1-3]>)/g, "$1");
  html = html.replace(/(<\/h[1-3]>)<\/p>/g, "$1");
  html = html.replace(/<p>(<ul>)/g, "$1");
  html = html.replace(/(<\/ul>)<\/p>/g, "$1");
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
      const loc = { account, mailbox: mbox };
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

    function find() {
      let fallback = null;
      const accounts = mail.accounts();
      for (const acct of accounts) {
        try {
          const inbox = acct.mailboxes.whose({name: "INBOX"})();
          if (inbox.length > 0) {
            const msgs = inbox[0].messages.whose({id: msgId})();
            if (msgs.length > 0) return {account: acct.name(), mailbox: "INBOX"};
          }
        } catch(e) {}
      }
      for (const acct of accounts) {
        const boxes = acct.mailboxes();
        for (const box of boxes) {
          try {
            const name = box.name();
            if (name === "INBOX") continue;
            const msgs = box.messages.whose({id: msgId})();
            if (msgs.length > 0) {
              const loc = {account: acct.name(), mailbox: name};
              if (!virtual.has(name)) return loc;
              if (!fallback) fallback = loc;
            }
          } catch(e) {}
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
    description: "Draft new email, reply, or forward. Body is markdown.",
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
      },
      required: ["mode", "body"],
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
];

// --- Tool handlers ---

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

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
      case "move_email":
        result = handleMoveEmail(args); break;
      case "archive_emails":
        result = handleArchiveEmails(args); break;
      case "search_body":
        result = handleSearchBody(args); break;
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

// Shard dirs: Data/X/Y/Messages where X=0-9, Y=1-6
const SHARD_PAIRS = [];
for (let x = 0; x <= 9; x++) for (let y = 1; y <= 6; y++) SHARD_PAIRS.push(`${x}/${y}`);

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
  if (!internalUuid) return null;
  const id = Number(emailId);

  // Get the mailbox URL where the file physically lives
  // For Gmail, that's All Mail (messages.mailbox), not the label mailbox
  const rows = parseSqlite(`SELECT mb.url FROM messages m JOIN mailboxes mb ON mb.ROWID = m.mailbox WHERE m.ROWID = ${id}`);
  if (!rows.length) return null;

  const url = rows[0].url;
  const acctUuid = accountUuidFromUrl(url);
  const mboxSegs = mboxPathFromUrl(url);
  if (!acctUuid || !mboxSegs) return null;

  const mboxDir = `${MAIL_V10_DIR}/${acctUuid}/${mboxSegs.join("/")}/${internalUuid}/Data`;

  // Brute-force shard dirs (<1ms on SSD)
  for (const shard of SHARD_PAIRS) {
    const path = `${mboxDir}/${shard}/Messages/${id}.emlx`;
    try {
      accessSync(path, fsConst.R_OK);
      return path;
    } catch {}
  }
  // Also check un-sharded Messages dir
  const flatPath = `${mboxDir}/Messages/${id}.emlx`;
  try {
    accessSync(flatPath, fsConst.R_OK);
    return flatPath;
  } catch {}

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
      `sqlite3 ${JSON.stringify(FTS_DB)} ${JSON.stringify(q)}`,
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
      `sqlite3 -json ${JSON.stringify(FTS_DB)} ${JSON.stringify(q)}`,
      { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 10000 }
    ).trim();
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function isIndexed(emailId) {
  const rows = parseFts(`SELECT 1 FROM indexed WHERE id = ${Number(emailId)} LIMIT 1`);
  return rows.length > 0;
}

function indexEmail(emailId, subject, sender, bodyText) {
  const id = Number(emailId);
  if (isIndexed(id)) return;
  // Truncate body to 50k chars to keep index size reasonable
  const body = (bodyText || "").slice(0, 50000).replace(/'/g, "''");
  const subj = (subject || "").replace(/'/g, "''");
  const from = (sender || "").replace(/'/g, "''");
  try {
    runFts(`INSERT OR REPLACE INTO bodies (id, subject, sender, body) VALUES (${id}, '${subj}', '${from}', '${body}')`);
    runFts(`INSERT OR REPLACE INTO indexed (id, ts) VALUES (${id}, ${Math.floor(Date.now() / 1000)})`);
  } catch {}
}

// --- Background indexing queue ---
//
// Strategy: seed a queue table with all known message IDs (newest-first priority),
// then drain it one email per tick. New emails are detected each tick and enqueued.
// Passive get_email calls mark items done immediately, so hot emails are always indexed.
// Resilient: skips missing .emlx files, resumes across restarts, never blocks the server.

function ensureQueue() {
  runFts(`CREATE TABLE IF NOT EXISTS queue (
    id INTEGER PRIMARY KEY,
    priority INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending'
  )`);
  runFts(`CREATE INDEX IF NOT EXISTS queue_status ON queue(status, priority DESC)`);
}

function seedQueue() {
  // Only seed if queue is completely empty (first run or wiped)
  const existing = parseFts(`SELECT COUNT(*) as n FROM queue`);
  if ((existing[0]?.n || 0) > 0) return;

  try {
    const ids = parseSqlite(`SELECT ROWID as id, date_received FROM messages ORDER BY date_received DESC`);
    if (!ids.length) return;

    // Batch insert in chunks of 500 to avoid huge SQL strings
    const CHUNK = 500;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const vals = chunk.map((r, j) => `(${r.id}, ${ids.length - i - j})`).join(",");
      runFts(`INSERT OR IGNORE INTO queue (id, priority) VALUES ${vals}`);
    }
  } catch {}
}

function enqueueNewEmails() {
  // Find IDs above our current max queue ID — these are emails that arrived since last seed
  try {
    const maxKnown = parseFts(`SELECT MAX(id) as m FROM queue`);
    const since = maxKnown[0]?.m || 0;
    if (!since) return;
    const newIds = parseSqlite(`SELECT ROWID as id FROM messages WHERE ROWID > ${since} ORDER BY ROWID ASC`);
    if (!newIds.length) return;
    const vals = newIds.map(r => `(${r.id}, 999999, 'pending')`).join(",");
    runFts(`INSERT OR IGNORE INTO queue (id, priority, status) VALUES ${vals}`);
  } catch {}
}

function markQueueDone(id) {
  try { runFts(`UPDATE queue SET status = 'done' WHERE id = ${Number(id)}`); } catch {}
}

let drainBusy = false;

function drainOne() {
  if (drainBusy) return;
  drainBusy = true;
  try {
    // Check for new emails each tick (cheap — only looks at IDs above our max known)
    enqueueNewEmails();

    const rows = parseFts(`SELECT id FROM queue WHERE status = 'pending' ORDER BY priority DESC LIMIT 1`);
    if (!rows.length) return;

    const id = rows[0].id;
    try {
      const emlxPath = findEmlxPath(id);
      if (emlxPath) {
        const data = parseEmlx(emlxPath);
        indexEmail(id, data.subject, data.from, data.body);
      }
      // Mark done whether we indexed or not (missing file = skip permanently)
      markQueueDone(id);
    } catch {
      markQueueDone(id); // Don't retry broken emails
    }
  } catch {} finally {
    drainBusy = false;
  }
}

let drainTimer = null;
function startBackfill() {
  ensureFtsDb();
  ensureQueue();
  // Seed queue after a short delay so server starts fast
  setTimeout(() => {
    seedQueue();
    drainOne();
    // 500ms per email = ~7200/hr, gentle but not glacial
    drainTimer = setInterval(drainOne, 500);
  }, 3000);
}

function ftsIndexStats() {
  try {
    const indexed = parseFts(`SELECT COUNT(*) as n FROM indexed`);
    const total = parseSqlite(`SELECT COUNT(*) as n FROM messages`);
    const pending = parseFts(`SELECT COUNT(*) as n FROM queue WHERE status = 'pending'`);
    return {
      indexed: indexed[0]?.n || 0,
      total: total[0]?.n || 0,
      pending: pending[0]?.n || 0,
    };
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

  const lines = data.map((e) => {
    const date = e.date_received
      ? new Date(e.date_received * 1000).toISOString().slice(0, 10)
      : "";
    const from = e.sender_name && e.sender_addr
      ? `${e.sender_name} <${e.sender_addr}>`
      : e.sender_name || e.sender_addr || "";
    const account = accountFromUrl(e.mailbox_url || "");
    const mailbox = mailboxFromUrl(e.mailbox_url || "");
    return `ID:${e.id} | ${e.read ? " " : "●"} ${e.flagged ? "⚑ " : ""}${date} | ${from} | ${e.subject || "(no subject)"} [${account}/${mailbox}]`;
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
      try { indexEmail(emailId, data.subject, data.from, data.body); markQueueDone(emailId); } catch {}

      const parts = [
        `Subject: ${data.subject || "(no subject)"}`,
        `From: ${data.from}`,
        `To: ${data.to}`,
      ];
      if (data.cc) parts.push(`CC: ${data.cc}`);
      parts.push(`Date: ${data.date}`);
      parts.push(`Read: ${isRead} | Flagged: ${isFlagged}`);
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
      const box = acct.mailboxes.whose({name: ${escapeForJxa(loc.mailbox)}})()[0];
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
  try { indexEmail(emailId, data.subject, data.from, data.body); markQueueDone(emailId); } catch {}

  const parts = [
    `Subject: ${data.subject}`,
    `From: ${data.from}`,
    `To: ${data.to}`,
  ];
  if (data.cc) parts.push(`CC: ${data.cc}`);
  parts.push(`Date: ${data.date}`);
  parts.push(`Read: ${data.read} | Flagged: ${data.flagged}`);
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

// Paste HTML body into Mail.app compose window via clipboard
// Mail.app body is a WebView: window > group 1 > group 1 > scroll area 1
function pasteHtmlBody(htmlBody) {
  execSync(
    `echo ${JSON.stringify(htmlBody)} | textutil -stdin -format html -inputencoding UTF-8 -convert rtf -stdout | pbcopy`,
    { shell: "/bin/bash", timeout: 10000 }
  );
  runAppleScript(`tell application "Mail"
    activate
end tell
delay 0.3
tell application "System Events"
    tell process "Mail"
        tell front window
            tell group 1
                tell group 1
                    tell scroll area 1
                        set focused to true
                        click
                    end tell
                end tell
            end tell
        end tell
        delay 0.3
        keystroke "v" using command down
    end tell
end tell`);
}

function handleCompose(args) {
  const mode = args?.mode;
  const body = args?.body || "";
  const htmlBody = markdownToHtml(body);

  if (mode === "new") {
    const subject = args?.subject || "";
    const to = args?.to || "";
    const cc = args?.cc || "";

    let script = `tell application "Mail"
    set newMsg to make new outgoing message with properties {subject:"${escapeForAppleScript(subject)}", content:"", visible:true}`;

    if (to) {
      script += `\n    tell newMsg\n        make new to recipient at end of to recipients with properties {address:"${escapeForAppleScript(to)}"}\n    end tell`;
    }
    if (cc) {
      script += `\n    tell newMsg\n        make new cc recipient at end of cc recipients with properties {address:"${escapeForAppleScript(cc)}"}\n    end tell`;
    }
    script += `\n    activate\nend tell`;
    runAppleScript(script);

    if (body.trim()) {
      try { pasteHtmlBody(htmlBody); } catch (e) { /* window open, paste failed — still usable */ }
    }
    return ok(`Draft created: ${subject}`);
  }

  if (mode === "reply" || mode === "forward") {
    const emailId = args?.email_id;
    if (!emailId) return err("email_id required for reply/forward.");
    const replyAll = args?.reply_all || false;

    const loc = findMessageLocation(emailId);
    if (!loc) return err(`Email ${emailId} not found.`);

    const action =
      mode === "reply"
        ? replyAll
          ? "reply msg with opening window and reply to all"
          : "reply msg with opening window"
        : "forward msg with opening window";

    const script = `tell application "Mail"
    set targetBox to mailbox "${escapeForAppleScript(loc.mailbox)}" of account "${escapeForAppleScript(loc.account)}"
    set msgs to (every message of targetBox whose id is ${Number(emailId)})
    if (count of msgs) is 0 then return "Error: Email ${emailId} not found."
    set msg to item 1 of msgs
    ${action}
    activate
    return "ok"
end tell`;

    const result = runAppleScript(script);
    if (result.startsWith("Error:")) return err(result.slice(7));

    if (body.trim()) {
      try { pasteHtmlBody(htmlBody); } catch (e) { /* window open, paste failed — still usable */ }
    }
    return ok(`${mode === "reply" ? "Reply" : "Forward"} draft created for email ${emailId}.`);
  }

  return err(`Invalid mode: ${mode}. Use "new", "reply", or "forward".`);
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

  const script = `tell application "Mail"
    set targetBox to mailbox "${escapeForAppleScript(loc.mailbox)}" of account "${escapeForAppleScript(loc.account)}"
    set msgs to (every message of targetBox whose id is ${Number(emailId)})
    if (count of msgs) is 0 then return "Error: Email ${emailId} not found."
    set targetMsg to item 1 of msgs
    set destBox to missing value
    try
        set destBox to mailbox "${escapeForAppleScript(destination)}" of account "${escapeForAppleScript(destAccount)}"
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
    if (!byMailbox[key]) byMailbox[key] = { account: loc.account, mailbox: loc.mailbox, ids: [] };
    byMailbox[key].ids.push(Number(id));
  }

  let archived = 0;
  const errors = [];

  for (const { account, mailbox, ids } of Object.values(byMailbox)) {
    // Build AppleScript ID list
    const idList = ids.join(", ");
    const script = `tell application "Mail"
    set theBox to mailbox "${escapeForAppleScript(mailbox)}" of account "${escapeForAppleScript(account)}"
    set archived to 0
    repeat with msgId in {${idList}}
        set msgs to (every message of theBox whose id is msgId)
        if (count of msgs) > 0 then
            delete item 1 of msgs
            set archived to archived + 1
        end if
    end repeat
    return archived
end tell`;

    try {
      const count = parseInt(runAppleScript(script, { timeout: 120000 }), 10) || 0;
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
