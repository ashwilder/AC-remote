# Stops the older script-based AC Remote (if installed) so it does not compete with the desktop app for the same port.
Get-CimInstance Win32_Process -Filter "Name = 'cmd.exe'" | Where-Object { $_.CommandLine -like '*ac-remote-service.cmd*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*src*server.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Remove-Item (Join-Path ([Environment]::GetFolderPath('Startup')) 'AC Remote.lnk') -ErrorAction SilentlyContinue
Get-NetFirewallRule -DisplayName 'AC Remote (*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
