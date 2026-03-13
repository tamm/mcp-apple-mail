# Apple Mail Signature Playbook

## How Mail stores signatures

| File | Purpose |
|------|---------|
| `~/Library/Mail/V10/MailData/Signatures/AllSignatures.plist` | Name, UUID, IsRich flag for every signature |
| `~/Library/Mail/V10/MailData/Signatures/AccountsMap.plist` | Maps account UUIDs → signature UUID arrays |
| `~/Library/Mail/V10/MailData/Signatures/<UUID>.mailsignature` | Actual HTML content |
| `~/Library/Mail/V10/MailData/SyncedFilesInfo.plist` | iCloud sync tracking — Mail restores from iCloud if entry exists |
| `~/Library/Containers/com.apple.mail/Data/Library/Preferences/com.apple.mail.plist` | Mail prefs — `SignaturesSelected` maps account → active sig UUID |

## The rules that matter

1. **Remove iCloud tracking entries — this is the key step.** `SyncedFilesInfo.plist` tracks files that iCloud manages. Both the `.mailsignature` file AND `AllSignatures.plist` have entries. Delete both and Mail stops restoring from iCloud on launch.

2. **Lock both files with `chflags uchg`.** Confirmed required for `AllSignatures.plist` (name/rename changes don't stick without it). Also lock the sig file for extra protection.

3. **Clone headers from an existing working sig.** Use build `3826.400.131.1.5` with no `Message-Id` header. Mail treats files with this older build number as externally managed.

4. **Mail must be quit when you write.** Write and lock while Mail is closed, then open.

5. **Set `SignatureIsRich: true` in AllSignatures.plist.**

## Full procedure: create or update a signature

```bash
# 1. Quit Mail
osascript -e 'tell application "Mail" to quit' && sleep 4

# 2. Unlock AllSignatures.plist if previously locked
chflags nouchg ~/Library/Mail/V10/MailData/Signatures/AllSignatures.plist

# 3. Remove iCloud tracking for the sig file and AllSignatures.plist
/usr/libexec/PlistBuddy -c "Delete :'Signatures/<UUID>.mailsignature'" \
  ~/Library/Mail/V10/MailData/SyncedFilesInfo.plist 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Delete :'Signatures/AllSignatures.plist'" \
  ~/Library/Mail/V10/MailData/SyncedFilesInfo.plist 2>/dev/null || true

# 4. Clone content from working sig, substituting your values
WORKING=~/Library/Mail/V10/MailData/Signatures/<WORKING-UUID>.mailsignature
sed \
  -e 's|old-logo.png|new-logo.png|g' \
  -e 's|color:#f48031|color:#55A6FC|g' \
  -e 's|old@email.com|new@email.com|g' \
  "$WORKING" > ~/Library/Mail/V10/MailData/Signatures/<NEW-UUID>.mailsignature

# 5. Set SignatureIsRich true
# Find the 0-based index of your sig in AllSignatures.plist first:
# cat ~/Library/Mail/V10/MailData/Signatures/AllSignatures.plist | grep -n "SignatureUniqueId" -A1
/usr/libexec/PlistBuddy -c "Set :INDEX:SignatureIsRich true" \
  ~/Library/Mail/V10/MailData/Signatures/AllSignatures.plist

# 6. Lock both files
chflags uchg ~/Library/Mail/V10/MailData/Signatures/<NEW-UUID>.mailsignature
chflags uchg ~/Library/Mail/V10/MailData/Signatures/AllSignatures.plist

# 7. Open Mail
open -a Mail
```

To unlock for editing later (must quit Mail first):
```bash
chflags nouchg ~/Library/Mail/V10/MailData/Signatures/<UUID>.mailsignature
chflags nouchg ~/Library/Mail/V10/MailData/Signatures/AllSignatures.plist
```

## Creating a new signature (bootstrapping the UUID)

Mail only writes a `.mailsignature` file to disk after you view it in Preferences.

1. In Mail: **Settings → Signatures**, select the target account in the left column, click **+**
2. Click on the new entry — this triggers the file write to disk
3. Note the new UUID: `cat ~/Library/Mail/V10/MailData/Signatures/AllSignatures.plist`
4. Quit Mail, then follow the full procedure above from step 2

## HTML template

```html
<body>
<div dir="ltr">
<img width="96" height="33" src="https://tamm.in/static/email-signature/LOGO-FILENAME.png?v=1"><br>
Tamm Sj&#246;din (<a href="https://medium.com/gender-inclusivit/why-i-put-pronouns-on-my-email-signature-and-linkedin-profile-and-you-should-too-d3dc942c8743" style="color:LINK-COLOUR" target="_blank">they/them</a>)<br>
&#x1F4E7; <a href="mailto:YOUR-EMAIL" style="color:LINK-COLOUR" target="_blank">YOUR-EMAIL</a> | &#x1F4F1; +61 437 287 095
<br><br>
&#x1F5A4;&#x1F49B;&#x2764;&#xFE0F; I acknowledge the Gadigal people of the Eora Nation as the Traditional Custodians of the land where I live and work. I pay my respects to Elders past, and present.
<br><br>
&#x1F3F3;&#xFE0F;&#x200D;&#x1F308;&#x1F3F3;&#xFE0F;&#x200D;&#x26A7;&#xFE0F; Proud advocate for LGBTQIA+ rights and equality. Everyone deserves to live authentically and with dignity.
</div>
</body>
```

### Logo variants

| File | Use | Link colour |
|------|-----|-------------|
| `tamm-signature-logo.png` | Light background | `#f48031` (orange) |
| `tamm-signature-logo-inverted-solid.png` | Dark / neutral background | `#55A6FC` (blue) |

Hosted at: `https://tamm.in/static/email-signature/`

## What does NOT work (and why we tried it)

| Approach | Why it fails |
|----------|-------------|
| Writing the file while Mail is open | Mail's filesystem watcher overwrites it within milliseconds |
| Writing the file while Mail is closed, no iCloud removal | Mail restores the old content from iCloud on next open |
| Using a different build number than the existing file | Mail regenerates the file from its cached version |
| Creating a new UUID not known to Mail | Mail ignores/deletes it; must bootstrap via UI first |
| Using a different UUID to replace a known one | Mail's prefs (`SignaturesSelected`, `SyncedFilesInfo`) reference the old UUID and restore it |
| `set content of signature` via AppleScript | Sets plain text only — Mail serialises this back and overwrites HTML |
| `set html content` on a message via AppleScript | Silently ignored by Mail |
| Editing AllSignatures.plist without locking it | Mail restores name/IsRich from iCloud, reverting changes |
| PlistBuddy edits to AllSignatures.plist while Mail is open | Mail overwrites the plist on quit |

## Account and signature reference

Account UUIDs and signature UUIDs for this machine are stored in a local-only file
(not committed to git). See `~/.mcp-apple-mail/` or check the plists directly:

```bash
# Account UUIDs
cat ~/Library/Mail/V10/MailData/Signatures/AccountsMap.plist

# Signature UUIDs and names
cat ~/Library/Mail/V10/MailData/Signatures/AllSignatures.plist

# Which sig is locked
ls -lO ~/Library/Mail/V10/MailData/Signatures/*.mailsignature
```
