# Sets up secure access from anywhere using Tailscale (free for personal use).
# Your phone and this PC join your own private Tailscale network; nothing is opened to the internet.
$ErrorActionPreference = 'Continue'
$Port = 8080
function Say($msg, $color = 'White') { Write-Host $msg -ForegroundColor $color }

$ts = $null
$cmd = Get-Command tailscale -ErrorAction SilentlyContinue
if ($cmd) { $ts = $cmd.Source }
elseif (Test-Path "$env:ProgramFiles\Tailscale\tailscale.exe") { $ts = "$env:ProgramFiles\Tailscale\tailscale.exe" }
if (-not $ts) {
    Say 'Installing Tailscale...' Yellow
    winget install -e --id Tailscale.Tailscale --accept-source-agreements --accept-package-agreements
    $ts = "$env:ProgramFiles\Tailscale\tailscale.exe"
    if (-not (Test-Path $ts)) { Say 'Tailscale did not install. Get it from https://tailscale.com/download and run this again.' Red; Read-Host 'Press Enter to close'; exit 1 }
}

Say ''
Say 'Step 1: sign in to Tailscale. A browser window will open; sign in with Google, Microsoft or another account.' Cyan
& $ts up
if ($LASTEXITCODE -ne 0) { Say 'Tailscale sign-in did not finish. Run this again.' Red; Read-Host 'Press Enter to close'; exit 1 }

Say ''
Say 'Step 2: publishing AC Remote privately on your Tailscale network...' Cyan
Say '(If Tailscale asks you to enable HTTPS, open the link it shows, click Enable, then come back.)' Yellow
& $ts serve --bg $Port
if ($LASTEXITCODE -ne 0) { Say 'Tailscale could not publish AC Remote. Fix the message above and run this again.' Red; Read-Host 'Press Enter to close'; exit 1 }

$dns = (& $ts status --json | ConvertFrom-Json).Self.DNSName.TrimEnd('.')
$url = "https://$dns"
New-Item -ItemType Directory -Force -Path "$env:LOCALAPPDATA\ACRemote" | Out-Null
Set-Content -Path "$env:LOCALAPPDATA\ACRemote\remote-url.txt" -Value $url

Say ''
Say '  Remote access is ready.' Green
Say "  Your private address:  $url"
Say ''
Say '  On your phone:'
Say '   1. Install the Tailscale app (Play Store / App Store) and sign in with the same account.'
Say "   2. Open $url in Chrome or Safari and enter your PIN."
Say '   3. Use "Add to Home screen" (or "Install app") to get an AC Remote icon.'
Say '  This address works at home and away, as long as Tailscale is on in the phone.'
Say ''
Read-Host 'Press Enter to close'
