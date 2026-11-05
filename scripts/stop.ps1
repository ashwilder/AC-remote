# Stops the background copy of AC Remote.
Get-CimInstance Win32_Process -Filter "Name = 'cmd.exe'" | Where-Object { $_.CommandLine -like '*ac-remote-service.cmd*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
$n = 0
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*src\server.mjs*' -or $_.CommandLine -like '*src/server.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $n++ }
if ($n) { Write-Host 'AC Remote stopped.' -ForegroundColor Green } else { Write-Host 'AC Remote was not running.' }
