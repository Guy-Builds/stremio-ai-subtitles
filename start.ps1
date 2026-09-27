$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir
$host.UI.RawUI.WindowTitle = 'AI Subtitles - Launcher'
function Fail($msg) { Write-Host ''; Write-Host "  $msg" -ForegroundColor Red; Write-Host ''; Read-Host '  Press Enter to close'; exit 1 }

Write-Host ''
Write-Host '  AI Subtitles for Stremio' -ForegroundColor Cyan
Write-Host '  ============================'

$ngrok = Join-Path $dir 'ngrok.exe'
if (-not (Test-Path (Join-Path $dir '.env'))) { Fail 'Not installed yet - run INSTALL.bat first.' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'node not found - run INSTALL.bat first.' }
if (-not (Test-Path $ngrok)) { Fail 'ngrok.exe missing - run INSTALL.bat first.' }

$line = Get-Content .env | Where-Object { $_ -like 'NGROK_DOMAIN=*' } | Select-Object -First 1
if (-not $line) { Fail 'NGROK_DOMAIN missing from .env - run INSTALL.bat again.' }
$domain = ($line -replace '^NGROK_DOMAIN=', '').Trim()
# Both of these end up inside a command string below. A folder name or an .env
# line containing a quote would otherwise close the string and run whatever
# follows it, so neither is trusted as written.
if ($domain -notmatch '^[A-Za-z0-9.-]+$') { Fail 'NGROK_DOMAIN in .env does not look like a domain - run INSTALL.bat again.' }
$dirQ = $dir -replace "'", "''"
$manifest = "https://$domain/manifest.json"

$busy = $null
try { $busy = Get-NetTCPConnection -LocalPort 7788 -State Listen -ErrorAction SilentlyContinue } catch { }
if ($busy) {
  Write-Host '  Port 7788 is already in use - it may already be running.' -ForegroundColor Yellow
  if ((Read-Host '  Start anyway? (y/N)') -ne 'y') { exit 0 }
}

Write-Host '  [1/3] starting the addon server...'
Start-Process powershell -ArgumentList @('-NoExit','-NoProfile','-Command',
  "`$host.UI.RawUI.WindowTitle='AI Subtitles - SERVER'; Set-Location '$dirQ'; node --env-file=.env src/boot.js") | Out-Null

Write-Host '  [2/3] opening the tunnel...'
Start-Process powershell -ArgumentList @('-NoExit','-NoProfile','-Command',
  "`$host.UI.RawUI.WindowTitle='AI Subtitles - TUNNEL'; Set-Location '$dirQ'; .\ngrok.exe http 7788 --url https://$domain") | Out-Null

Write-Host '  [3/3] checking that the addon answers over the tunnel...'
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 2
  try { $r = Invoke-RestMethod $manifest -TimeoutSec 10; if ($r.id) { $ok = $true; break } } catch { }
  if ($i % 5 -eq 4) { Write-Host "        still waiting... $(($i + 1) * 2)s" }
}

Write-Host ''
Write-Host '  ------------------------------------------------------------'
if ($ok) { Write-Host '   READY - Stremio can reach the addon.' -ForegroundColor Green }
else { Write-Host '   No answer yet. Look at the SERVER and TUNNEL windows.' -ForegroundColor Yellow }
Write-Host ''
Write-Host '   Stremio install URL (same every time):' -ForegroundColor Cyan
Write-Host "   $manifest" -ForegroundColor White
try { Set-Clipboard -Value $manifest; Write-Host '   (copied to clipboard)' -ForegroundColor DarkGray } catch { }
Write-Host '  ------------------------------------------------------------'
Write-Host ''
Write-Host '   Keep the SERVER and TUNNEL windows open while watching.'
Write-Host '   Do NOT select text inside them - Windows freezes them if you do.'
Write-Host ''
Read-Host '  Press Enter to close this launcher (the other windows stay open)'
