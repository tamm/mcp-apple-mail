import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execSync } from "child_process";

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

function runAppleScript(script) {
  try {
    const result = execSync(
      `osascript << 'APPLESCRIPT_EOF'\n${script}\nAPPLESCRIPT_EOF`,
      {
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
        shell: "/bin/bash",
        timeout: 30000,
      }
    );
    return result.trim();
  } catch (error) {
    const msg = error.message || "";
    if (msg.includes("ETIMEDOUT") || error.killed) {
      throw new Error("AppleScript timed out (>30s). Mail.app may be unresponsive.");
    }
    throw new Error(`AppleScript error: ${msg.slice(0, 200)}`);
  }
}

// --- Message location helper (fast lookup via JXA whose clause) ---

// Gmail virtual folders that JXA can see but AppleScript can't reference
const VIRTUAL_MAILBOXES = new Set([
  "All Mail", "Important", "Starred", "[Gmail]/All Mail",
  "[Gmail]/Important", "[Gmail]/Starred",
]);

function findMessageLocation(emailId) {
  return parseJxa(`
    const mail = Application("Mail");
    const msgId = ${Number(emailId)};
    const virtual = new Set(${JSON.stringify([...VIRTUAL_MAILBOXES])});

    function find() {
      let fallback = null;
      const accounts = mail.accounts();
      // Check INBOX first (most common target for reply/forward)
      for (const acct of accounts) {
        try {
          const inbox = acct.mailboxes.whose({name: "INBOX"})();
          if (inbox.length > 0) {
            const msgs = inbox[0].messages.whose({id: msgId})();
            if (msgs.length > 0) return {account: acct.name(), mailbox: "INBOX"};
          }
        } catch(e) {}
      }
      // Fall back to scanning all mailboxes
      for (const acct of accounts) {
        const boxes = acct.mailboxes();
        for (const box of boxes) {
          try {
            const name = box.name();
            if (name === "INBOX") continue; // Already checked
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
    description: "List accounts and mailboxes with unread counts.",
    inputSchema: { type: "object", properties: {} },
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
        limit: { type: "number", description: "Max results (default 10, max 50)." },
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
];

// --- Tool handlers ---

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      case "list_mailboxes":
        return handleListMailboxes();
      case "search_emails":
        return handleSearchEmails(args);
      case "get_email":
        return handleGetEmail(args);
      case "compose":
        return handleCompose(args);
      case "move_email":
        return handleMoveEmail(args);
      default:
        return err(`Unknown tool: ${name}`);
    }
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

function handleListMailboxes() {
  const data = parseJxa(`
    const mail = Application("Mail");
    const accounts = mail.accounts();
    const result = [];
    for (const acct of accounts) {
      const name = acct.name();
      const boxes = acct.mailboxes();
      for (const box of boxes) {
        try {
          result.push(name + "/" + box.name() + " (" + box.unreadCount() + " unread)");
        } catch(e) {}
      }
    }
    JSON.stringify(result);
  `);
  if (!data || data.length === 0) return ok("No mailboxes found.");
  return ok(data.join("\n"));
}

// --- search_emails ---

function handleSearchEmails(args) {
  const query = args?.query || null;
  const mailboxName = args?.mailbox || "INBOX";
  const accountName = args?.account || null;
  const limit = Math.min(args?.limit || 10, 50);

  const queryStr = query ? escapeForJxa(query) : "null";
  const mailboxStr = escapeForJxa(mailboxName);
  const accountStr = accountName ? escapeForJxa(accountName) : "null";

  // Batch fetch is fast but still needs time for large mailboxes
  const searchTimeout = query ? 60000 : 30000;
  const data = parseJxa(`
    const mail = Application("Mail");
    const query = ${queryStr};
    const mailboxName = ${mailboxStr};
    const accountFilter = ${accountStr};
    const limit = ${limit};

    function getMailboxes() {
      const accounts = mail.accounts();
      const boxes = [];
      for (const acct of accounts) {
        if (accountFilter && acct.name() !== accountFilter) continue;
        const mboxes = acct.mailboxes();
        for (const box of mboxes) {
          try {
            if (box.name() === mailboxName) {
              boxes.push({box: box, account: acct.name()});
            }
          } catch(e) {}
        }
      }
      return boxes;
    }

    const mailboxes = getMailboxes();
    const results = [];

    for (const {box, account} of mailboxes) {
      let msgs;
      try {
        msgs = box.messages;
      } catch(e) { continue; }

      const mboxName = box.name();

      if (query) {
        // Search mode: batch fetch subjects + senders, filter, then get details for matches
        let subjects, senders, ids;
        try {
          ids = msgs.id();
          subjects = msgs.subject();
          senders = msgs.sender();
        } catch(e) { continue; }
        const q = query.toLowerCase();
        const matchIdx = [];
        for (let i = 0; i < ids.length; i++) {
          const s = (subjects[i] || "").toLowerCase();
          const f = (senders[i] || "").toLowerCase();
          if (s.includes(q) || f.includes(q)) matchIdx.push(i);
        }
        // Fetch dates + flags only for matches
        let dates, readArr, flaggedArr;
        try {
          dates = msgs.dateReceived();
          readArr = msgs.readStatus();
          flaggedArr = msgs.flaggedStatus();
        } catch(e) { continue; }
        for (const i of matchIdx) {
          results.push({
            id: ids[i],
            subject: subjects[i] || "(no subject)",
            from: senders[i] || "",
            date: dates[i] ? dates[i].toISOString() : "",
            read: readArr[i],
            flagged: flaggedArr[i],
            mailbox: mboxName,
            account: account
          });
        }
      } else {
        // Recent mode: batch fetch dates + ids, sort, take top N, then get details
        let ids, dates;
        try {
          ids = msgs.id();
          dates = msgs.dateReceived();
        } catch(e) { continue; }
        // Build index pairs and sort by date descending
        const indexed = [];
        for (let i = 0; i < ids.length; i++) {
          indexed.push({i: i, date: dates[i] ? dates[i].getTime() : 0});
        }
        indexed.sort((a, b) => b.date - a.date);
        const topN = indexed.slice(0, limit);
        // Fetch remaining props for just these indices
        let subjects, senders, readArr, flaggedArr;
        try {
          subjects = msgs.subject();
          senders = msgs.sender();
          readArr = msgs.readStatus();
          flaggedArr = msgs.flaggedStatus();
        } catch(e) { continue; }
        for (const {i, date} of topN) {
          results.push({
            id: ids[i],
            subject: subjects[i] || "(no subject)",
            from: senders[i] || "",
            date: dates[i] ? dates[i].toISOString() : "",
            read: readArr[i],
            flagged: flaggedArr[i],
            mailbox: mboxName,
            account: account
          });
        }
      }
    }
    // Final sort across all mailboxes
    results.sort((a, b) => b.date.localeCompare(a.date));
    JSON.stringify(results.slice(0, limit));
  `, { timeout: searchTimeout });

  if (!data || data.length === 0) {
    return ok(query ? `No emails matching "${query}".` : "No emails found.");
  }

  const lines = data.map(
    (e) =>
      `ID:${e.id} | ${e.read ? " " : "●"} ${e.flagged ? "⚑ " : ""}${e.date.slice(0, 10)} | ${e.from} | ${e.subject} [${e.account}/${e.mailbox}]`
  );
  return ok(lines.join("\n"));
}

// --- get_email ---

function handleGetEmail(args) {
  const emailId = args?.email_id;
  if (!emailId) return err("email_id is required.");

  const data = parseJxa(`
    const mail = Application("Mail");
    const msgId = ${Number(emailId)};
    let found = null;

    const accounts = mail.accounts();
    outer:
    for (const acct of accounts) {
      const boxes = acct.mailboxes();
      for (const box of boxes) {
        try {
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
            break outer;
          }
        } catch(e) {}
      }
    }
    JSON.stringify(found);
  `);

  if (!data) return err(`Email ${emailId} not found.`);

  const body = cleanBody(data.body);
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

  // Fast lookup via JXA
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

// --- Exports for testing ---
export {
  stripSignature,
  stripQuotedReplies,
  cleanBody,
  markdownToHtml,
  escapeForAppleScript,
  escapeForJxa,
};

// --- Start server ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("mcp-apple-mail running on stdio");
}

main().catch(console.error);
