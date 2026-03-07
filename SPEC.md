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

**JXA batch fetch for reads.** `search_emails` uses JXA batch property access (`msgs.subject()` returns all subjects in one IPC call) instead of per-message iteration. Results are sorted by date descending in JS to handle Gmail IMAP's unreliable message ordering. `findMessageLocation` checks INBOX first and skips Gmail virtual folders (All Mail, Important, Starred) that JXA can see but AppleScript can't reference.

**AppleScript + clipboard paste for writes.** Compose/reply/forward use AppleScript to open the window, then clipboard paste for the body: `textutil` converts HTML to RTF, `pbcopy` copies it, System Events clicks the body WebView (`window > group 1 > group 1 > scroll area 1`) and pastes with Cmd+V. This is the only way to get rendered HTML into Mail.app — the `content` property only accepts plain text.

**Signature and quote stripping.** `get_email` strips email signatures (`-- ` delimiter, mobile app signatures) and quoted reply chains (`On ... wrote:`, Outlook `From:/Sent:` blocks, `>` quote lines). This keeps the returned body to just the actual message content, saving tokens and reducing noise for the LLM.

**Markdown body input.** `compose` accepts markdown and converts to basic HTML. This lets the LLM write natural markdown without needing to construct HTML.

## Known Limitations

- macOS only (uses `osascript` for JXA and AppleScript)
- Mail.app must be running and configured with at least one account
- Search is subject/sender only (no full-text body search -- Mail.app scripting limitation)
- Compose opens a visible draft window; does not send automatically (by design, human-in-the-loop)
- Attachments not supported
- HTML emails are read as plain text (Mail.app `content` property returns plaintext extraction)
- Compose requires Accessibility permission for System Events (System Settings > Privacy & Security > Accessibility)

## Install

```bash
cd ~/dev/mcp-apple-mail
npm install
```

Add to Claude Code:

```bash
claude mcp add apple-mail -- node ~/dev/mcp-apple-mail/index.js
```

## Prerequisites

- macOS with Mail.app configured (at least one account)
- Node.js 18+
- Automation permissions: Terminal/Claude Code must have permission to control Mail.app (System Settings > Privacy & Security > Automation)
