#Requires -Version 5.1
<#
.SYNOPSIS
  Start local OLKIL WordPress for UI testing (Docker).

.EXAMPLE
  .\start-local.ps1
  .\start-local.ps1 -Reset
#>
param(
    [switch]$Reset
)

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

function Write-Step([string]$Message) {
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Invoke-Docker {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
    $output = & docker @Args 2>&1
    $code = $LASTEXITCODE
    if ($output) { $output | ForEach-Object { Write-Host $_ } }
    if ($code -ne 0) { throw "docker $($Args -join ' ') failed ($code)" }
    return $output
}

function Invoke-Wp {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
    $output = & docker compose run --rm --entrypoint wp wpcli @Args 2>&1
    $code = $LASTEXITCODE
    if ($output) { $output | ForEach-Object { Write-Host $_ } }
    if ($code -ne 0) { throw "wp $($Args -join ' ') failed ($code)" }
    return ($output | Out-String).Trim()
}

Write-Step 'Checking Docker'
try {
    Invoke-Docker info | Out-Null
} catch {
    Write-Host 'Docker is not running. Start Docker Desktop, then run this script again.' -ForegroundColor Red
    exit 1
}

if ($Reset) {
    Write-Step 'Removing old containers and volumes'
    Invoke-Docker compose down -v
}

Write-Step 'Starting WordPress + MySQL'
Invoke-Docker compose up -d db wordpress wpcli | Out-Null

Write-Step 'Waiting for WordPress database'
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    $ping = & docker compose exec -T db mysqladmin ping -h localhost -uwordpress -pwordpress 2>&1
    if ($LASTEXITCODE -eq 0) {
        $ready = $true
        break
    }
    Start-Sleep -Seconds 2
}
if (-not $ready) {
    Write-Host 'Database did not become ready in time.' -ForegroundColor Red
    exit 1
}

Write-Step 'Bootstrapping WordPress (first run only)'
$wpInstalled = $false
try {
    Invoke-Wp core is-installed | Out-Null
    $wpInstalled = $true
} catch {
    $wpInstalled = $false
}

if (-not $wpInstalled) {
    Invoke-Wp core install `
        --url='http://localhost:8081' `
        --title='OLKIL Local' `
        --admin_user='admin' `
        --admin_password='admin123' `
        --admin_email='admin@olkil.local' `
        --skip-email | Out-Null
}

Write-Step 'Activating OLKIL theme and plugins'
Invoke-Wp theme activate olkil | Out-Null
Invoke-Wp plugin activate olkil-payu-checkout olkil-seo-brand olkil-legal-pages olkil-payu-compliance olkil-download-links | Out-Null
Invoke-Wp rewrite structure '/%postname%/' --hard | Out-Null
Invoke-Wp rewrite flush --hard | Out-Null
Invoke-Wp option update blogdescription 'Local test site' | Out-Null
Invoke-Wp option update show_on_front page | Out-Null
Invoke-Wp option update posts_per_page 10 | Out-Null

$homeId = ''
try { $homeId = Invoke-Wp post list --post_type=page --name=home --field=ID --format=csv } catch { $homeId = '' }
if (-not $homeId) {
    Invoke-Wp post create --post_type=page --post_title='Home' --post_name='home' --post_status=publish | Out-Null
    $homeId = Invoke-Wp post list --post_type=page --name=home --field=ID --format=csv
}
if ($homeId) {
    Invoke-Wp option update page_on_front $homeId | Out-Null
}

$blogId = ''
try { $blogId = Invoke-Wp post list --post_type=page --name=blog --field=ID --format=csv } catch { $blogId = '' }
if (-not $blogId) {
    Invoke-Wp post create --post_type=page --post_title='Blog' --post_name='blog' --post_status=publish | Out-Null
    $blogId = Invoke-Wp post list --post_type=page --name=blog --field=ID --format=csv
}
if ($blogId) {
    Invoke-Wp option update page_for_posts $blogId | Out-Null
}

$postCount = 0
try { $postCount = [int](Invoke-Wp post list --post_type=post --format=count) } catch { $postCount = 0 }
if ($postCount -lt 5) {
    $samples = @(
        'Getting started with OLKIL AI agents',
        'How to use cloud tokens efficiently',
        'Building your first project in OLKIL',
        'OLKIL vs traditional IDEs',
        'New features in the latest OLKIL release',
        'Tips for faster code reviews with AI'
    )
    foreach ($title in $samples) {
        Invoke-Wp post create --post_type=post --post_title="$title" --post_status=publish --post_content='Sample post for local UI testing.' | Out-Null
    }
}

Write-Step 'Triggering plugin page/theme sync'
Invoke-Wp eval 'do_action("init");' | Out-Null

Write-Host ''
Write-Host 'OLKIL local site is ready!' -ForegroundColor Green
Write-Host ''
Write-Host '  Site:      http://localhost:8081' -ForegroundColor Yellow
Write-Host '  Admin:     http://localhost:8081/wp-admin' -ForegroundColor Yellow
Write-Host '  Login:     admin / admin123' -ForegroundColor Yellow
Write-Host ''
Write-Host '  Test pages:' -ForegroundColor White
Write-Host '    Homepage:  http://localhost:8081/' -ForegroundColor Gray
Write-Host '    Dashboard: http://localhost:8081/dashboard/' -ForegroundColor Gray
Write-Host '    Blog:      http://localhost:8081/blog/' -ForegroundColor Gray
Write-Host '    Profile:   http://localhost:8081/profile/' -ForegroundColor Gray
Write-Host ''
Write-Host 'Stop:  docker compose down' -ForegroundColor DarkGray
Write-Host 'Reset: .\start-local.ps1 -Reset' -ForegroundColor DarkGray
