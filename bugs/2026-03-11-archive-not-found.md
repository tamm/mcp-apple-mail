# Bug: archive_emails returns "not found" for valid IDs from search_emails

**Filed:** 2026-03-11
**Severity:** High — archive is unreliable for bulk operations
**Component:** `index.js` — `handleArchiveEmails` / `findMessageLocation`

## Symptoms

1. `search_emails` with `unread_only=true, limit=200` returns ~160 email IDs
2. Passing those IDs to `archive_emails` — many come back as "not found"
3. IDs from a smaller search (`limit=20`) of the same mailbox work fine
4. Archiving 20 IDs at once times out (120s). Archiving 3-5 works (17s for 3).

## Observed behaviour

| Test | IDs | Result | Time |
|------|-----|--------|------|
| archive 20 IDs (from limit=20 search) | mixed | AppleScript timeout | 120s |
| archive 5 IDs (from limit=200 search) | 63194, 63216, 63222, 63232, 63251 | 0/5 — all "not found" | 66s |
| archive 3 IDs (from limit=20 search) | 63996, 63987, 63985 | 3/3 success | 17s |

## Root cause analysis

Two separate bugs:

### Bug 1: ID lookup mismatch between search and archive

**search_emails** (`index.js:916-1022`) finds emails via the Envelope Index using two alternative queries:
- Query A (lines 962-977): searches via `labels` table (Gmail virtual mailboxes)
- Query B (lines 988-1002): falls back to direct `mailbox` join (Spam, Trash, Drafts)

**findMessageLocation** (`index.js:179-249`) used by archive runs BOTH queries and then applies preference logic (lines 204-207) that prefers non-virtual mailboxes over virtual ones ("All Mail", "Important", "Starred").

The mismatch: `search_emails` finds an email via the labels/virtual path and returns it. `findMessageLocation` later finds the same ID in both locations, picks the non-virtual one due to preference logic, and that location may not match what Mail.app expects — causing the archive AppleScript to fail with "not found".

**Key code — findMessageLocation preference logic (lines 204-210):**
The function combines results from both queries and preferentially returns non-virtual mailbox locations. If `search_emails` found the email through the labels path but `findMessageLocation` returns a different (non-virtual) mailbox path, the AppleScript `delete` targets the wrong mailbox.

### Bug 2: AppleScript performance — O(n*m) scanning

**handleArchiveEmails** (`index.js:1305-1354`) generates AppleScript that loops through each ID sequentially:

```applescript
repeat with msgId in {id1, id2, ...}
    set msgs to (every message of theBox whose id is msgId)
    if (count of msgs) > 0 then
        delete item 1 of msgs
    end if
end repeat
```

`every message of theBox whose id is msgId` is a linear scan of the entire mailbox for each ID. With 20 IDs in a large inbox, that's 20 full scans. Gmail INBOX via IMAP can have thousands of messages — this is O(n*m) where n = number of IDs and m = mailbox size.

At 3 IDs it takes 17 seconds (~5.5s per email). At 20 IDs that's ~110s, right at the 120s timeout.

## Relevant files

| What | File | Lines |
|------|------|-------|
| search_emails handler | `index.js` | 916-1022 |
| findMessageLocation | `index.js` | 179-249 |
| Virtual mailbox constants | `index.js` | 174-177 |
| archive_emails handler | `index.js` | 1305-1354 |
| runAppleScript (timeout) | `index.js` | 150-169 |
| runSqlite | `index.js` | 775-785 |

## Database

Apple Mail Envelope Index: `~/Library/Mail/V10/MailData/Envelope Index` (SQLite)

Tables: `messages` (ROWID = email ID), `labels` (maps to virtual mailboxes), `mailboxes` (folder URLs), `subjects`, `addresses`

## Suggested fixes

### Bug 1 — ID mismatch
`findMessageLocation` should return the same mailbox path that `search_emails` used to find the email. Options:
- Have `search_emails` return the mailbox location alongside the ID, then pass it through to archive (avoids the re-lookup entirely)
- Remove the virtual/non-virtual preference logic in `findMessageLocation` and just return whichever location actually has the message
- Store the search query type (labels vs direct) with the result and use the same path for lookup

### Bug 2 — AppleScript performance
- Batch into groups of 3-5 IDs per AppleScript call
- Or restructure the AppleScript to avoid per-ID linear scans — e.g. fetch all messages once, filter in-script
- Increase timeout as a band-aid (but the real fix is smaller batches)

## Reproduction

```
1. search_emails with unread_only=true, limit=200
2. Pick IDs from the older results (page 2+)
3. archive_emails with those IDs
4. Observe "not found" for most/all
```
