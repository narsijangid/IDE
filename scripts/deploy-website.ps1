#Requires -Version 5.1
<#
.SYNOPSIS
  Deploy OLKIL WordPress theme + plugins to Hostinger via SCP/SSH.

.PARAMETER Target
  production (olkil.com) or testing (testing.olkil.com)

.PARAMETER EnvFile
  Path to deploy env file (default: scripts/.env.deploy)

.EXAMPLE
  cd C:\zzzzzz\OLU
  .\scripts\deploy-website.ps1 -Target testing

.EXAMPLE
  .\scripts\deploy-website.ps1 -Target production
#>
param(
    [ValidateSet('production', 'testing')]
    [string]$Target = 'testing',

    [string]$EnvFile = (Join-Path $PSScriptRoot '.env.deploy')
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path $PSScriptRoot -Parent

function Write-Step([string]$Message) {
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Get-DeployConfig {
    param([string]$Path)

    if (-not (Test-Path $Path)) {
        throw "Missing $Path — copy scripts/deploy.env.example to scripts/.env.deploy and set SSH_HOST."
    }

    $cfg = @{}
    Get-Content $Path | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith('#')) { return }
        $parts = $line -split '=', 2
        if ($parts.Count -eq 2) {
            $cfg[$parts[0].Trim()] = $parts[1].Trim()
        }
    }

    foreach ($key in @('SSH_USER', 'SSH_HOST', 'SSH_PORT')) {
        if (-not $cfg[$key] -or $cfg[$key] -eq 'YOUR_SSH_HOST') {
            throw "Set $key in $Path (from Hostinger hPanel → SSH Access)."
        }
    }

    return $cfg
}

function Invoke-Ssh {
    param([hashtable]$Cfg, [string]$RemoteCommand)
    & ssh -p $Cfg.SSH_PORT -o StrictHostKeyChecking=accept-new "$($Cfg.SSH_USER)@$($Cfg.SSH_HOST)" $RemoteCommand
    if ($LASTEXITCODE -ne 0) { throw "SSH command failed." }
}

function Invoke-ScpDir {
    param(
        [hashtable]$Cfg,
        [string]$LocalDir,
        [string]$RemoteDir
    )

    if (-not (Test-Path $LocalDir)) {
        throw "Local path not found: $LocalDir"
    }

    $parent = Split-Path $LocalDir -Parent
    $name = Split-Path $LocalDir -Leaf
    Push-Location $parent
    try {
        & scp -P $Cfg.SSH_PORT -r $name "${Cfg.SSH_USER}@${Cfg.SSH_HOST}:$RemoteDir"
        if ($LASTEXITCODE -ne 0) { throw "SCP failed for $LocalDir" }
    } finally {
        Pop-Location
    }
}

Write-Step "Loading config"
$cfg = Get-DeployConfig -Path $EnvFile

$domain = if ($Target -eq 'production') { 'olkil.com' } else { 'testing.olkil.com' }
$remoteRoot = "/home/$($cfg.SSH_USER)/domains/$domain/public_html"
$remoteTheme = "$remoteRoot/wp-content/themes"
$remotePlugins = "$remoteRoot/wp-content/plugins"

Write-Host "Target: $domain" -ForegroundColor Yellow
Write-Host "Remote: $remoteRoot" -ForegroundColor DarkGray

Write-Step 'Preparing theme overrides locally'
$themeDir = Join-Path $RepoRoot 'olkil-theme-extract\olkil'
$seoOverrideCss = Join-Path $RepoRoot 'wp-plugins\olkil-seo-brand\theme-overrides\assets\olkil\css\olkil.css'
$themeCss = Join-Path $themeDir 'assets\olkil\css\olkil.css'
$legalCss = Join-Path $RepoRoot 'wp-plugins\olkil-legal-pages\olkil.css'

if (Test-Path $themeCss) {
    Copy-Item $themeCss $seoOverrideCss -Force
    Copy-Item $themeCss $legalCss -Force
    Write-Host 'Synced olkil.css → seo-brand override + legal-pages plugin'
}

Write-Step 'Uploading theme (olkil)'
Invoke-ScpDir -Cfg $cfg -LocalDir $themeDir -RemoteDir $remoteTheme

$plugins = @(
    @{ Local = 'wp-plugins\olkil-payu-checkout'; Slug = 'olkil-payu-checkout' },
    @{ Local = 'wp-plugins\olkil-seo-brand'; Slug = 'olkil-seo-brand' },
    @{ Local = 'wp-plugins\olkil-legal-pages'; Slug = 'olkil-legal-pages' },
    @{ Local = 'wp-plugins\olkil-payu-compliance'; Slug = 'olkil-payu-compliance' },
    @{ Local = 'wordpress-plugins\olkil-download-links'; Slug = 'olkil-download-links' }
)

foreach ($plugin in $plugins) {
    $localPath = Join-Path $RepoRoot $plugin.Local
    if (-not (Test-Path $localPath)) {
        Write-Host "Skip missing plugin: $($plugin.Slug)" -ForegroundColor DarkYellow
        continue
    }
    Write-Step "Uploading plugin: $($plugin.Slug)"
    Invoke-ScpDir -Cfg $cfg -LocalDir $localPath -RemoteDir $remotePlugins
}

Write-Step 'Flushing WordPress rewrite rules + cache (if wp-cli available on server)'
$remoteCmd = @"
cd '$remoteRoot' && (
  command -v wp >/dev/null 2>&1 && wp rewrite flush --hard && wp cache flush
) || echo 'wp-cli not found — open site once in browser to trigger plugin sync'
"@
try {
    Invoke-Ssh -Cfg $cfg -RemoteCommand $remoteCmd
} catch {
    Write-Host 'Remote wp-cli flush skipped (not fatal).' -ForegroundColor DarkYellow
}

Write-Host ''
Write-Host 'Deploy complete!' -ForegroundColor Green
Write-Host "  Site: https://$domain/" -ForegroundColor Yellow
Write-Host "  Dashboard: https://$domain/dashboard/" -ForegroundColor Gray
Write-Host "  Blog: https://$domain/blog/" -ForegroundColor Gray
Write-Host ''
Write-Host 'If CSS looks old: Hostinger hPanel → LiteSpeed Cache → Purge All' -ForegroundColor DarkGray
