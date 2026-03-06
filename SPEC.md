# mcp-apple-mail

Lean MCP server for Apple Mail on macOS. Read, search, compose, and organise emails via Mail.app.

## Tools

| Tool | Params | Returns |
|------|--------|---------|
| `list_mailboxes` | (none) | Account/mailbox names with unread counts |
| `search_emails` | `query?`, `mailbox?` (default INBOX), `account?`, `limit?` (default 10, max 50) | One-line summaries: ID, date, sender, subject, read/flagged status |
| `get_email` | `email_id` | Headers + cleaned body (signatures and quoted replies stripped) |
| `compose` | `mode` (new/reply/forward), `body` (markdown), `to?`, `subject?`, `cc?`, `email_id?`, `reply_all?` | Opens compose window in Mail.app with draft |
| `move_email` | `email_id`, `destination`, `account?` | Confirmation message |

## Design Decisions

**Lean by design.** MCP tool descriptions and response payloads are kept minimal. Every token in a tool definition or result costs context window budget in the calling LLM. Short descriptions, compact one-line result formats, no unnecessary metadata.

**JXA for reads, AppleScript for writes.** JXA (JavaScript for Automation) is used for read operations because it returns structured JSON natively. AppleScript is used for compose/reply/forward/move because JXA's Mail.app write support is unreliable -- reply and forward operations silently fail or produce corrupt messages in JXA.

**Signature and quote stripping.** `get_email` strips email signatures (`-- ` delimiter, mobile app signatures) and quoted reply chains (`On ... wrote:`, Outlook `From:/Sent:` blocks, `>` quote lines). This keeps the returned body to just the actual message content, saving tokens and reducing noise for the LLM.

**Markdown body input.** `compose` accepts markdown and converts to basic HTML. This lets the LLM write natural markdown without needing to construct HTML.

## Known Limitations

- macOS only (uses `osascript` for JXA and AppleScript)
- Mail.app must be running and configured with at least one account
- Search is subject/sender only (no full-text body search -- Mail.app scripting limitation)
- Compose opens a visible draft window; does not send automatically (by design, human-in-the-loop)
- Attachments not supported
- HTML emails are read as plain text (Mail.app `content` property returns plaintext extraction)
- Large mailboxes with thousands of messages may be slow to search (iterates messages via scripting bridge)

## Install

```bash
cd ~/dev/mcp-apple-mail
npm install
```

Add to Claude Code:

```bash
claude mcp add apple-mail node ~/dev/mcp-apple-mail/index.js
```

## Prerequisites

- macOS with Mail.app configured (at least one account)
- Node.js 18+
- Automation permissions: Terminal/Claude Code must have permission to control Mail.app (System Settings > Privacy & Security > Automation)
