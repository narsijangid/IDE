$ErrorActionPreference = 'Stop'
$cfg = Get-Content -Raw $env:HST_TUS_CFG | ConvertFrom-Json
$tus = $cfg.url.TrimEnd('/')
$auth = $cfg.auth_key
$rest = $cfg.rest_auth_key
$dir = 'c:\zzzzzz\OLU\.deploy-tmp\olkil-1.3.15'
$files = @(
  'OLKIL-1.3.15.exe',
  'OLKIL-1.3.15.exe.blockmap',
  'OLKIL-1.3.15-arm64.dmg',
  'OLKIL-1.3.15-arm64.dmg.blockmap',
  'OLKIL-1.3.15-x64.dmg',
  'OLKIL-1.3.15-x64.dmg.blockmap',
  'OLKIL-1.3.15.deb',
  'OLKIL-1.3.15.AppImage'
)

function Upload-Tus([string]$local, [string]$remote) {
  $size = (Get-Item -LiteralPath $local).Length
  $url = "$tus/${remote}?override=true"
  Write-Host "POST $remote size=$size"
  $postOut = Join-Path $env:TEMP 'tus-post-headers.txt'
  & curl.exe -sS -D $postOut -o NUL -X POST $url `
    -H "X-Auth: $auth" `
    -H "X-Auth-Rest: $rest" `
    -H "Tus-Resumable: 1.0.0" `
    -H "Upload-Length: $size" `
    -H "Upload-Offset: 0"
  $postHeaders = Get-Content $postOut -Raw
  Write-Host $postHeaders
  if ($LASTEXITCODE -ne 0 -and $postHeaders -notmatch '204|201|409|200') {
    throw "POST failed $remote exit=$LASTEXITCODE"
  }

  $offset = 0
  $chunkSize = 8 * 1024 * 1024
  $fs = [System.IO.File]::OpenRead($local)
  try {
    $buffer = New-Object byte[] $chunkSize
    while ($offset -lt $size) {
      $remaining = $size - $offset
      $toRead = [Math]::Min($chunkSize, $remaining)
      $n = $fs.Read($buffer, 0, $toRead)
      if ($n -le 0) { throw "short read at $offset" }
      $tmp = Join-Path $env:TEMP ("tus-" + [guid]::NewGuid().ToString('N') + '.bin')
      $out = New-Object byte[] $n
      [Array]::Copy($buffer, 0, $out, 0, $n)
      [System.IO.File]::WriteAllBytes($tmp, $out)
      Write-Host ("PATCH {0} offset={1} bytes={2} ({3:N0}/{4:N0})" -f $remote, $offset, $n, ($offset + $n), $size)
      $patchOut = Join-Path $env:TEMP 'tus-patch-headers.txt'
      & curl.exe -sS -D $patchOut -o NUL -X PATCH $url `
        -H "X-Auth: $auth" `
        -H "X-Auth-Rest: $rest" `
        -H "Tus-Resumable: 1.0.0" `
        -H "Content-Type: application/offset+octet-stream" `
        -H "Upload-Offset: $offset" `
        --data-binary "@$tmp"
      Remove-Item -Force $tmp
      $patchHeaders = Get-Content $patchOut -Raw
      if ($LASTEXITCODE -ne 0) {
        Write-Host $patchHeaders
        throw "PATCH failed $remote at $offset exit=$LASTEXITCODE"
      }
      if ($patchHeaders -match 'Upload-Offset:\s*(\d+)') {
        $offset = [int64]$Matches[1]
      } else {
        $offset += $n
      }
    }
  } finally {
    $fs.Dispose()
  }
  Write-Host "DONE $remote"
}

foreach ($f in $files) {
  Upload-Tus (Join-Path $dir $f) ("downloads/" + $f)
}
Write-Host 'ALL UPLOADS COMPLETE'
