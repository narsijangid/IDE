param(
    [string]$FilePath,
    [string]$BaseUrl,
    [string]$RelPath,
    [string]$Auth,
    [string]$Rest,
    [int]$ChunkSize = 524288
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

function Get-TusOffset {
    param($Client, [string]$Target)
    $headReq = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Head, $Target)
    $headResp = $Client.SendAsync($headReq).GetAwaiter().GetResult()
    if ($headResp.Headers.Contains('Upload-Offset')) {
        return [int64]$headResp.Headers.GetValues('Upload-Offset').GetEnumerator().Current
    }
    return 0
}

$size = (Get-Item $FilePath).Length
$target = "$BaseUrl/$RelPath" + '?override=true'
$client = New-Object System.Net.Http.HttpClient
$client.Timeout = [TimeSpan]::FromMinutes(15)
$client.DefaultRequestHeaders.Add('X-Auth', $Auth)
$client.DefaultRequestHeaders.Add('X-Auth-Rest', $Rest)
$client.DefaultRequestHeaders.Add('Tus-Resumable', '1.0.0')

Write-Host "Creating upload session ($size bytes)..."
$postReq = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, $target)
$postReq.Headers.Add('Upload-Length', [string]$size)
$postReq.Headers.Add('Upload-Offset', '0')
$postResp = $client.SendAsync($postReq).GetAwaiter().GetResult()
Write-Host "POST status:" $postResp.StatusCode
$postResp.Dispose()

$offset = Get-TusOffset -Client $client -Target $target
Write-Host "Resume offset:" $offset

$fs = [System.IO.File]::OpenRead($FilePath)
try {
    if ($offset -gt 0) { $fs.Seek($offset, [System.IO.SeekOrigin]::Begin) | Out-Null }
    $buffer = New-Object byte[] $ChunkSize
    while ($offset -lt $size) {
        $read = $fs.Read($buffer, 0, $ChunkSize)
        if ($read -le 0) { break }
        $chunk = New-Object byte[] $read
        [Array]::Copy($buffer, $chunk, $read)
        $content = [System.Net.Http.ByteArrayContent]::new($chunk)
        $content.Headers.Add('Content-Type', 'application/offset+octet-stream')
        $patchMethod = New-Object System.Net.Http.HttpMethod('PATCH')
        $patchReq = New-Object System.Net.Http.HttpRequestMessage($patchMethod, $target)
        $patchReq.Headers.Add('Upload-Offset', [string]$offset)
        $patchReq.Content = $content
        $patchResp = $client.SendAsync($patchReq).GetAwaiter().GetResult()
        $code = $patchResp.StatusCode.value__
        if ($code -eq 409) {
            $patchResp.Dispose()
            $offset = Get-TusOffset -Client $client -Target $target
            $fs.Seek($offset, [System.IO.SeekOrigin]::Begin) | Out-Null
            Write-Host ('Conflict synced to offset {0}' -f $offset)
            continue
        }
        if ($code -ne 204) {
            $body = $patchResp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            Write-Host "PATCH status:" $patchResp.StatusCode
            Write-Host $body
            throw "PATCH failed at offset $offset"
        }
        if ($patchResp.Headers.Contains('Upload-Offset')) {
            $offset = [int64]$patchResp.Headers.GetValues('Upload-Offset').GetEnumerator().Current
        } else {
            $offset += $read
        }
        $patchResp.Dispose()
        $pct = [math]::Round(100 * $offset / $size, 1)
        Write-Host ('Uploaded {0} / {1} ({2} pct)' -f $offset, $size, $pct)
    }
} finally {
    $fs.Close()
    $client.Dispose()
}

if ($offset -lt $size) { throw ('Incomplete upload: {0} / {1}' -f $offset, $size) }
Write-Host 'Video upload complete.'
