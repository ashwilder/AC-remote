# AC Remote installer for Windows 10/11.
# Installs Node.js if needed, installs the app, opens the firewall for your home network,
# makes AC Remote start when you sign in, and starts it now.
$ErrorActionPreference = 'Stop'
$App = Split-Path -Parent $PSScriptRoot
$Port = 8080

function Say($msg, $color = 'White') { Write-Host $msg -ForegroundColor $color }
function Ask($q) { $a = Read-Host "$q [Y/n]"; return ($a -eq '' -or $a -match '^[Yy]') }

# Re-launch as administrator (needed for the firewall rules only).
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Say 'AC Remote needs administrator permission once, to allow your phone through Windows Firewall.' Yellow
    Start-Process powershell.exe -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit
}

Say ''
Say '  AC Remote setup' Cyan
Say "  Installing from: $App"
Say ''

# 1. Node.js
function Get-NodeVersion {
    try { return [version]((& node --version) -replace '^v', '') } catch { return $null }
}
$nodeVer = Get-NodeVersion
if (-not $nodeVer -or $nodeVer -lt [version]'20.19.0') {
    Say 'Installing Node.js (LTS)...' Yellow
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Say 'winget is not available. Install Node.js LTS from https://nodejs.org, then run this installer again.' Red
        Read-Host 'Press Enter to close'; exit 1
    }
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    $nodeVer = Get-NodeVersion
    if (-not $nodeVer) { Say 'Node.js did not install. Install it from https://nodejs.org and run this again.' Red; Read-Host 'Press Enter to close'; exit 1 }
}
Say "Node.js $nodeVer found." Green

# 2. App dependencies
Say 'Installing AC Remote (this can take a minute)...' Yellow
Push-Location $App
try {
    & npm ci --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
} finally { Pop-Location }
Say 'App installed.' Green

# 3. Firewall: allow the web app (TCP) and Matter traffic (UDP) on private/home networks only.
$nodeExe = (Get-Command node).Source
Get-NetFirewallRule -DisplayName 'AC Remote*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'AC Remote (web app)' -Direction Inbound -Protocol TCP -LocalPort $Port -Profile Private,Domain -Action Allow | Out-Null
New-NetFirewallRule -DisplayName 'AC Remote (Matter)' -Direction Inbound -Program $nodeExe -Protocol UDP -Profile Private,Domain -Action Allow | Out-Null
Say 'Firewall rules added for home (private) networks.' Green

$public = Get-NetConnectionProfile | Where-Object { $_.NetworkCategory -eq 'Public' }
foreach ($p in $public) {
    Say "Your network '$($p.Name)' is set to Public, which blocks your phone and the AC from reaching this PC." Yellow
    if (Ask "Set '$($p.Name)' to Private (recommended for your home Wi-Fi)?") {
        Set-NetConnectionProfile -InterfaceIndex $p.InterfaceIndex -NetworkCategory Private
        Say 'Network set to Private.' Green
    }
}

# 4. Keep the PC awake on mains power, so the AC stays reachable.
if (Ask 'Stop this PC from going to sleep while plugged in? (Needed to control the AC when you are away)') {
    powercfg /change standby-timeout-ac 0
    Say 'Sleep on mains power turned off.' Green
}

# 5. Start at sign-in (hidden window) and start now.
$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'AC Remote.lnk'
$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($lnk)
$s.TargetPath = "$env:WINDIR\System32\wscript.exe"
$s.Arguments = "`"$App\scripts\run-hidden.vbs`""
$s.WorkingDirectory = $App
$s.IconLocation = "$nodeExe,0"
$s.Description = 'Starts AC Remote in the background'
$s.Save()
Say 'AC Remote will start automatically when you sign in to Windows.' Green

# Stop any copy that is already running, then start in the background.
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*src\server.mjs*' -or $_.CommandLine -like '*src/server.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-CimInstance Win32_Process -Filter "Name = 'cmd.exe'" | Where-Object { $_.CommandLine -like '*ac-remote-service.cmd*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
# Launch through Explorer so the app runs as you, not as administrator.
Start-Process explorer.exe -ArgumentList "`"$lnk`""
Start-Sleep -Seconds 6

$ips = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } | Select-Object -ExpandProperty IPAddress
Say ''
Say '  Done. AC Remote is running.' Cyan
Say "  On this PC:    http://localhost:$Port"
foreach ($ip in $ips) { Say "  On your phone: http://${ip}:$Port   (same Wi-Fi)" }
Say ''
Say '  Next: choose a PIN in the browser window that opens, then pair your AC.'
Say '  For control away from home, run "Set up remote access.bat".'
Say ''
Start-Process "http://localhost:$Port"
Read-Host 'Press Enter to close this window'
