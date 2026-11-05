# Removes AC Remote's autostart, firewall rules and (optionally) its data.
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Start-Process powershell.exe -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit
}
& "$PSScriptRoot\stop.ps1"
Remove-Item (Join-Path ([Environment]::GetFolderPath('Startup')) 'AC Remote.lnk') -ErrorAction SilentlyContinue
Get-NetFirewallRule -DisplayName 'AC Remote*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
$ts = "$env:ProgramFiles\Tailscale\tailscale.exe"
if (Test-Path $ts) { & $ts serve reset 2>$null }
Write-Host 'Autostart and firewall rules removed.' -ForegroundColor Green
$a = Read-Host 'Also delete your PIN and paired ACs? You would need to pair again. [y/N]'
if ($a -match '^[Yy]') {
    Remove-Item "$env:LOCALAPPDATA\ACRemote" -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host 'Data deleted. Your AC may still list "AC Remote (PC)" as a connected app; you can remove it in MirAIe or Google Home.'
}
Write-Host 'You can now delete the AC Remote folder.'
Read-Host 'Press Enter to close'
