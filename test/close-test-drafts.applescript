tell application "System Events" to tell process "Mail"
    repeat 10 times
        if not (exists sheet 1 of window 1) then exit repeat
        click button "Don’t Save" of sheet 1 of window 1
        delay 0.5
    end repeat
end tell
tell application "Mail"
    repeat 10 times
        set ws to (every window whose name starts with "Re: The August")
        if (count of ws) is 0 then exit repeat
        close (item 1 of ws) saving no
        delay 0.5
        tell application "System Events" to tell process "Mail"
            if (exists sheet 1 of window 1) then click button "Don’t Save" of sheet 1 of window 1
        end tell
    end repeat
    return count of (every window whose name starts with "Re: The August")
end tell
