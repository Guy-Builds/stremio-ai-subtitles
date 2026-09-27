# First-time setup wizard. Run it by double-clicking INSTALL.bat.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir
$host.UI.RawUI.WindowTitle = 'AI Subtitles - Install'

function Say($t, $c = 'Gray') { Write-Host "  $t" -ForegroundColor $c }
function Stop-Here($msg) { Say ''; Say $msg 'Red'; Say ''; Read-Host '  Press Enter to close'; exit 1 }

Write-Host ''
Say 'AI Subtitles for Stremio - installer' 'Cyan'
Say '==========================================' 'Cyan'
Say 'Everything below is free. You will need two accounts:' 'DarkGray'
Say 'Google AI Studio (for the translation) and ngrok (for the address).' 'DarkGray'
Write-Host ''

# ---------- 1. Node -------------------------------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Say '[1/6] Node.js is missing - trying to install it...' 'Yellow'
  try { winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements } catch { }
  $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Start-Process 'https://nodejs.org'
  Stop-Here 'Install Node.js (the big green LTS button), then run INSTALL.bat again.'
}
$nv = (& node --version) -replace 'v',''
if ([int]($nv -split '\.')[0] -lt 18) { Stop-Here "Node $nv is too old. Install the LTS version from nodejs.org." }
Say "[1/6] Node.js $nv" 'Green'

# ---------- 2. Gemini key + live model pick -------------------------------
$envPath = Join-Path $dir '.env'
$existingKey = $null
if (Test-Path $envPath) {
  $existingKey = (Get-Content $envPath | Where-Object { $_ -like 'GEMINI_API_KEY=*' } | Select-Object -First 1) -replace '^GEMINI_API_KEY=', ''
}
if ($existingKey) {
  Say '[2/6] using the API key already in .env' 'DarkGray'
  $key = $existingKey
} else {
  Say ''
  Say 'Open https://aistudio.google.com/apikey and create a free API key.' 'Cyan'
  Start-Process 'https://aistudio.google.com/apikey'
  $key = (Read-Host '  Paste the API key here').Trim()
  if (-not $key) { Stop-Here 'No key entered.' }
}

Say '      checking the key and seeing which models it can use...'
try {
  $ml = Invoke-RestMethod 'https://generativelanguage.googleapis.com/v1beta/models' -Headers @{ 'x-goog-api-key' = $key } -TimeoutSec 30
} catch {
  Stop-Here 'Google rejected that key. Copy it again from aistudio.google.com/apikey and rerun.'
}
$usable = $ml.models | Where-Object { $_.supportedGenerationMethods -contains 'generateContent' } |
          ForEach-Object { $_.name -replace '^models/', '' }
# Prefer Flash: it chooses words better. Flash-Lite goes second, as the
# fallback for when Flash's smaller free daily quota runs out.
$rank = @(
  ($usable | Where-Object { $_ -eq 'gemini-flash-latest' }),
  ($usable | Where-Object { $_ -eq 'gemini-flash-lite-latest' }),
  ($usable | Where-Object { $_ -like '*flash-lite*' -and $_ -notlike '*preview*' -and $_ -notlike '*image*' }),
  ($usable | Where-Object { $_ -like '*flash*' -and $_ -notlike '*preview*' -and $_ -notlike '*image*' -and $_ -notlike '*tts*' })
) | ForEach-Object { $_ } | Where-Object { $_ } | Select-Object -Unique
if (-not $rank) { Stop-Here 'That key cannot reach any usable Gemini model.' }
$model = $rank[0]
$fallback = if ($rank.Count -gt 1) { $rank[1] } else { '' }
Say "[2/6] key works. model: $model" 'Green'
if ($fallback) { Say "      fallback: $fallback" 'DarkGray' }

# ---------- 3. ngrok.exe --------------------------------------------------
$ngrok = Join-Path $dir 'ngrok.exe'
if (-not (Test-Path $ngrok)) {
  # Only the exact path the instructions name. Searching the whole Downloads
  # tree and running the first ngrok.exe it turns up means anything that
  # happens to carry that name gets executed, and handed your authtoken.
  $found = @((Join-Path $HOME 'Downloads\ngrok.exe')) |
    Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $found) {
    Say ''
    Say 'ngrok is missing. The download page is opening now.' 'Yellow'
    Say 'Choose Windows 64-bit, download the ZIP, and EXTRACT it' 'Yellow'
    Say '(right-click - Extract All). Do not use the Microsoft Store version.' 'Yellow'
    Start-Process 'https://ngrok.com/download'
    Read-Host '  Press Enter once ngrok.exe is in your Downloads folder'
    $found = @((Join-Path $HOME 'Downloads\ngrok.exe')) |
      Where-Object { Test-Path $_ } | Select-Object -First 1
  }
  if (-not $found) { Stop-Here 'Could not find ngrok.exe. Put it next to this installer and rerun.' }
  Say ''
  Say "About to use this file as ngrok, and run it:" 'Yellow'
  Say "  $found" 'Yellow'
  if ((Read-Host '  Is that the file you downloaded from ngrok.com? (y/N)') -ne 'y') {
    Stop-Here 'Stopped. Put the ngrok.exe you downloaded next to this installer and rerun.'
  }
  Copy-Item $found $ngrok -Force
}
Say '[3/6] ngrok.exe is in place' 'Green'

# ---------- 4. ngrok account ---------------------------------------------
Say ''
Say 'Sign up free at ngrok (the page is opening), then from the dashboard:' 'Cyan'
Say '  - "Your Authtoken"  - copy it' 'Cyan'
Say '  - "Domains"         - copy your permanent domain' 'Cyan'
Start-Process 'https://dashboard.ngrok.com/signup'
$tok = (Read-Host '  Paste the AUTHTOKEN').Trim()
if ($tok) { & $ngrok config add-authtoken $tok | Out-Null; Say '[4/6] authtoken saved' 'Green' }
else { Say '[4/6] no token entered - the tunnel will not start without it' 'Yellow' }

$domain = (Read-Host '  Paste your DOMAIN (e.g. abc-12-34.ngrok-free.app)').Trim() -replace '^https?://', '' -replace '/+$', ''
if (-not $domain) { Stop-Here 'No domain entered.' }
# START.bat puts this into a command line, so only a plain hostname is allowed.
if ($domain -notmatch '^[A-Za-z0-9.-]+$') { Stop-Here 'That does not look like a domain - paste just the hostname.' }
Say "[5/6] domain: $domain" 'Green'

# ---------- 5. write .env -------------------------------------------------
$lines = @(
  "GEMINI_API_KEY=$key",
  "GEMINI_MODEL=$model",
  "GEMINI_FALLBACK=$fallback",
  "NGROK_DOMAIN=$domain",
  'CONCURRENCY=1',
  'CHUNK_SIZE=80',
  'MIN_SPLIT=2'
)
Set-Content -Path $envPath -Value $lines -Encoding ascii

# ---------- 6. self-test --------------------------------------------------
Say '      running the built-in self-test (no network, no quota used)...'
$t = & node test/run.js 2>&1
if ("$t" -match 'all checks passed') { Say '[6/6] self-test passed' 'Green' }
else { Say '[6/6] self-test did not pass:' 'Yellow'; Write-Host $t }

Write-Host ''
Say '------------------------------------------------------------' 'Cyan'
Say 'Installed.' 'Green'
Say ''
Say 'Stremio install URL (permanent - install it once):' 'Cyan'
Say "https://$domain/manifest.json" 'White'
try { Set-Clipboard -Value "https://$domain/manifest.json"; Say '(copied to clipboard)' 'DarkGray' } catch { }
Say ''
Say 'To watch: double-click START.bat, wait for READY, then open an episode' 'Gray'
Say 'in Stremio and pick your language in the subtitle menu.' 'Gray'
Say '------------------------------------------------------------' 'Cyan'
Write-Host ''
Read-Host '  Press Enter to close'
