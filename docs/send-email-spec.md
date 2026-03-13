# Feature Spec: Restricted Auto-Send

## Problem

The MCP server can draft emails but cannot send them. We want to allow
the MCP consumer to send emails autonomously, but with extreme safety
constraints to prevent accidental or malicious sends.

## Design Principles

1. Off by default. The tool is invisible unless explicitly activated.
2. Activation requires a local config file that is NOT in git.
3. The config file path is outside the repo (~/.mcp-apple-mail/send-config.json).
4. The tool does not appear in ListTools unless config exists and is valid.
5. Hardcoded rate limit that cannot be overridden by config.
6. Allowlist-only recipients. Any recipient not on the list = hard reject.
7. Single sender account. Only the configured account can send.

## Config File

Location: `~/.mcp-apple-mail/send-config.json`

```json
{
  "enabled": true,
  "from_account": "your-sender-account",
  "from_email": "sender@example.com",
  "allowed_recipients": ["hi@tamm.in"],
  "min_interval_seconds": 120
}
```

- `enabled` must be `true` (not truthy — strictly `true`)
- `from_account` — Mail.app account name (must match exactly)
- `from_email` — sender email address (avoids JXA lookup at send time)
- `allowed_recipients` — array of lowercase email addresses
- `min_interval_seconds` — minimum gap between sends (floor: 120s hardcoded,
  config can only increase, never decrease)

## Tool: send_email

Only registered in ListTools when config is valid.

### Input Schema

```json
{
  "to": "hi@tamm.in",
  "subject": "Test email",
  "body": "Markdown body text"
}
```

- `to` — single recipient (no CC, no BCC, no multiple recipients)
- `subject` — required
- `body` — markdown, converted to HTML same as compose

### Validation (server-side, non-bypassable)

1. Config file must exist and parse as valid JSON
2. `enabled` must be strictly `true`
3. `to` must be in `allowed_recipients` (case-insensitive match)
4. Rate limit: check timestamp file `~/.mcp-apple-mail/last-send-ts`
   - If file exists and (now - mtime) < max(120, min_interval_seconds): reject
   - Touch file after successful send
5. `from_account` must match a real Mail.app account

### Hardcoded Safety Constants (in source code)

- `SEND_MIN_INTERVAL_FLOOR = 120` — seconds, cannot be configured lower
- `SEND_MAX_RECIPIENTS = 1` — only one recipient per call
- `SEND_CONFIG_PATH = ~/.mcp-apple-mail/send-config.json`
- `SEND_TIMESTAMP_PATH = ~/.mcp-apple-mail/last-send-ts`

### Implementation

Uses AppleScript to:
1. Create outgoing message with subject, HTML body
2. Set sender to from_account's email address
3. Add single to-recipient
4. Send the message (not just make visible — actually send)

### Error Messages

- Config missing: "send_email is not available on this machine"
- Recipient not allowed: "Recipient not in allowlist"
- Rate limited: "Rate limited. Next send available in Xs"
- Account not found: "Sender account not found in Mail.app"

## What Does NOT Go Into Git

- Any actual email addresses other than hi@tamm.in (the public contact)
- The send-config.json file itself
- The last-send-ts file

## Testing Strategy

- Unit tests for validation logic (allowlist matching, rate limit math, config parsing)
- Use hi@tamm.in as the test email in committed test fixtures
- Integration test: manual only (requires Mail.app + config file on machine)
- The test suite must NOT attempt to actually send email

## Multi-Machine Behaviour

Machine A (has config file): send_email tool visible, functional
Machine B (no config file): send_email tool does not exist in ListTools

Same git checkout, different behaviour based on local state only.
