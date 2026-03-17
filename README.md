# mcp-apple-mail

![macOS only](https://img.shields.io/badge/platform-macOS-blue)
![Node.js 18+](https://img.shields.io/badge/node-18%2B-green)
![MIT License](https://img.shields.io/badge/license-MIT-yellow)

Lean MCP server for Apple Mail on macOS. Read, search, compose, and organise emails via Mail.app.

Works with Gmail, iCloud, and standard IMAP accounts -- any account configured in Mail.app.

## Why This One?

Most Mail.app MCP servers shell out to AppleScript for everything. That's slow -- a simple INBOX search takes ~4 seconds via JXA.

This server reads Mail.app's SQLite database (`Envelope Index`) directly for searches (~50ms) and reads `.emlx` files for message bodies (~1ms). It only falls back to JXA/AppleScript for write operations (compose, move) where there's no alternative.

| Operation | Method | Speed |
|-----------|--------|-------|
| Search emails | SQLite direct read | ~50ms |
| Get message body | `.emlx` file read | ~1ms |
| Search (fallback) | JXA batch fetch | ~4s |
| Compose / move | AppleScript | ~2s |

## Tools

| Tool | Params | Returns |
|------|--------|---------|
| `list_mailboxes` | (none) | Account/mailbox names with unread counts |
| `search_emails` | `query?`, `mailbox?` (default INBOX), `account?`, `limit?` (default 10, max 50) | One-line summaries: ID, date, sender, subject, read/flagged status |
| `get_email` | `email_id` | Headers + cleaned body (signatures and quoted replies stripped) + attachment list |
| `search_body` | `query`, `limit?` (default 20) | Relevance-ranked full-text results with body snippets; includes index coverage status |
| `compose` | `mode` (new/reply/forward), `body` (markdown), `to?`, `subject?`, `cc?`, `email_id?`, `reply_all?` | Opens compose window in Mail.app with draft |
| `move_email` | `email_id`, `destination`, `account?` | Confirmation message |
| `archive_emails` | `email_ids` (array), `account?` | Archive summary (Gmail: removes INBOX label) |
| `download_attachment` | `email_id`, `attachment_name?`, `destination?` | Saves attachment(s) to disk (default `/tmp/mail-attachments/`) |

## Install

```bash
git clone https://github.com/tamm/mcp-apple-mail.git
cd mcp-apple-mail
npm install
```

Add to Claude Code:

```bash
claude mcp add apple-mail -- node /path/to/mcp-apple-mail/index.js
```

Or add to `.mcp.json` in your project:

```json
{
  "mcpServers": {
    "apple-mail": {
      "command": "node",
      "args": ["/path/to/mcp-apple-mail/index.js"]
    }
  }
}
```

## Prerequisites

- macOS with Mail.app configured (at least one account)
- Node.js 18+
- Automation permissions: Terminal/Claude Code must have permission to control Mail.app (System Settings > Privacy & Security > Automation)
- Accessibility permission for compose operations (System Settings > Privacy & Security > Accessibility)

## Design Decisions

**Lean by design.** MCP tool descriptions and response payloads are kept minimal. Every token in a tool definition or result costs context window budget in the calling LLM. Short descriptions, compact one-line result formats, no unnecessary metadata.

**SQLite + emlx for reads.** `search_emails` queries Mail.app's `Envelope Index` SQLite database directly. `get_email` reads `.emlx` files from disk. SQLite ROWIDs match JXA's `message.id()`, so IDs are interchangeable between fast and slow paths.

**JXA batch fetch as fallback.** `search_emails` uses JXA batch property access (`msgs.subject()` returns all subjects in one IPC call) instead of per-message iteration. Results are sorted by date descending in JS to handle Gmail IMAP's unreliable message ordering.

**AppleScript + clipboard paste for writes.** Compose/reply/forward use AppleScript to open the window, then clipboard paste for the body: `textutil` converts HTML to RTF, `pbcopy` copies it, System Events pastes with Cmd+V. This is the only way to get rendered HTML into Mail.app -- the `content` property only accepts plain text.

**Signature and quote stripping.** `get_email` strips email signatures (`-- ` delimiter, mobile app signatures) and quoted reply chains (`On ... wrote:`, Outlook `From:/Sent:` blocks, `>` quote lines). This keeps the returned body to just the actual message content, saving tokens.

**FTS5 body index.** `search_body` uses a local SQLite FTS5 database (`~/.mcp-apple-mail/body-index.db`). It builds incrementally: every `get_email` call indexes that message immediately; a background queue drains the full mailbox at ~7,200 emails/hour without hammering disk. The index persists across restarts and reports coverage (`N% complete — X/Y indexed`) on every result so callers know whether to trust completeness.

**Markdown body input.** `compose` accepts markdown and converts to basic HTML. This lets the LLM write natural markdown without needing to construct HTML.

## Known Limitations

- macOS only (uses `osascript` for JXA and AppleScript)
- Mail.app must be running and configured with at least one account
- `search_emails` searches subject/sender only; use `search_body` for full-text (index builds incrementally in the background)
- Compose opens a visible draft window; does not send automatically (by design, human-in-the-loop)
- HTML emails are read as plain text (Mail.app `content` property returns plaintext extraction)

## Acknowledgements

This server was built independently but draws inspiration from two earlier projects in this space:

- [imdinu/apple-mail-mcp](https://github.com/imdinu/apple-mail-mcp) — performance-focused Python server; its FTS5 body search approach validated the direction taken here
- [patrickfreyer/apple-mail-mcp](https://github.com/patrickfreyer/apple-mail-mcp) — broad feature coverage including batch operations and companion Claude Code skills

The decision to go deep on SQLite/emlx direct reads rather than scripting everything through JXA grew out of prior work on an Outlook MCP integration, where studying the problem space made the Apple Mail performance opportunity obvious.

## License

MIT -- see [LICENSE](LICENSE).
