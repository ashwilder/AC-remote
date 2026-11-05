' Starts AC Remote in the background with no window.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.Run "cmd.exe /c """ & dir & "\ac-remote-service.cmd""", 0, False
