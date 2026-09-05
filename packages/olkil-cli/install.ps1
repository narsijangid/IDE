$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "OLKIL CLI needs Node.js 18+."
  Write-Host "Install it from https://nodejs.org then run this command again."
  exit 1
}

$base = 'https://olkil.com/downloads/cli'
$cliDir = Join-Path $env:USERPROFILE '.olkil\cli'
$binDir = Join-Path $env:USERPROFILE '.olkil\bin'
New-Item -ItemType Directory -Force -Path $cliDir | Out-Null
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

Write-Host "Installing OLKIL CLI..."
Invoke-WebRequest -UseBasicParsing -Uri "$base/olkil.cjs" -OutFile (Join-Path $cliDir 'olkil.cjs')

$cmd = @"
@echo off
node "%USERPROFILE%\.olkil\cli\olkil.cjs" %*
"@
Set-Content -Path (Join-Path $binDir 'olkil.cmd') -Value $cmd -Encoding ASCII

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }
if ($userPath -notlike "*$binDir*") {
  [Environment]::SetEnvironmentVariable('Path', ($binDir.TrimEnd('\') + ';' + $userPath), 'User')
}
$env:Path = $binDir + ';' + $env:Path

Write-Host ""
Write-Host "OLKIL CLI installed."
Write-Host "Open a new terminal, then run:  olkil"
Write-Host ""
