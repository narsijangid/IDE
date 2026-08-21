param(
    [string]$FilePath,
    [string]$BaseUrl,
    [string]$RelPath,
    [string]$Auth,
    [string]$Rest,
    [int]$ChunkSize = 524288
)

$ErrorActionPreference = 'Stop'
$size = (Get-Item $FilePath).Length
$target = "$BaseUrl/$RelPath" + '?override=true'

Write-Host "Creating upload session ($size bytes)..."
$postRaw = curl.exe -s -i -X POST $target `
    -H "X-Auth: $Auth" -H "X-Auth-Rest: $Rest" -H "Tus-Resumable: 1.0.0" `
    -H "Upload-Length: $size" -H "Upload-Offset: 0"
$post = ($postRaw | Out-String)
if ($post -notmatch '201 Created' -and $post -notmatch '409 Conflict') {
    Write-Host $post
    throw 'POST failed'
}

$offset = 0
if ($post -match 'Upload-Offset:\s*(\d+)') {
    $offset = [int]$Matches[1]
}

$fs = [System.IO.File]::OpenRead($FilePath)
try {
    if ($offset -gt 0) { $fs.Seek($offset, [System.IO.SeekOrigin]::Begin) | Out-Null }
    $buffer = New-Object byte[] $ChunkSize
    while ($offset -lt $size) {
        $read = $fs.Read($buffer, 0, $ChunkSize)
        if ($read -le 0) { break }
        $temp = [System.IO.Path]::GetTempFileName()
        try {
            [System.IO.File]::WriteAllBytes($temp, $buffer[0..($read - 1)])
            $respRaw = curl.exe --max-time 180 -s -i -X PATCH $target `
                -H "X-Auth: $Auth" -H "X-Auth-Rest: $Rest" -H "Tus-Resumable: 1.0.0" `
                -H "Content-Type: application/offset+octet-stream" -H "Upload-Offset: $offset" `
                --data-binary "@$temp"
            $resp = ($respRaw | Out-String)
        } finally {
            Remove-Item $temp -Force -ErrorAction SilentlyContinue
        }

        if ($resp -match 'Upload-Offset:\s*(\d+)') {
            $newOffset = [int]$Matches[1]
        } elseif ($resp -match '204 No Content') {
            $newOffset = $offset + $read
        } else {
            Write-Host $resp
            throw "PATCH failed at offset $offset"
        }

        if ($newOffset -le $offset) {
            throw "Upload stalled at offset $offset"
        }
        $offset = $newOffset
        $pct = [math]::Round(100 * $offset / $size, 1)
        Write-Host "Uploaded $offset / $size ($pct%)"
    }
} finally {
    $fs.Close()
}

if ($offset -lt $size) { throw "Incomplete upload: $offset / $size" }
Write-Host 'Video upload complete.'
