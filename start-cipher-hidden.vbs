' start-cipher-hidden.vbs
' Runs cipher-server.js in the background with NO visible window.
' Keep this file in the SAME folder as cipher-server.js and cipher.js.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
' "0" = hidden window, "False" = don't wait
sh.CurrentDirectory = folder
sh.Run "node """ & folder & "\cipher-server.js""", 0, False
