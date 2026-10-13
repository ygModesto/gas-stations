param(
    [int]$Port = 0,
    [string]$Ruta = '',
    [switch]$NoAbrir
)

$ErrorActionPreference = 'Stop'
$raiz = [System.IO.Path]::GetFullPath($PSScriptRoot)

if ($Port -eq 0) {
    $Port = 8000
    $cfg = Join-Path $raiz 'config.yaml'
    if (Test-Path $cfg) {
        $m = [regex]::Match((Get-Content $cfg -Raw), '(?m)^[ \t]+puerto:[ \t]*(\d+)')
        if ($m.Success) { $Port = [int]$m.Groups[1].Value }
    }
}

$tipos = @{
    '.html' = 'text/html; charset=utf-8'
    '.js'   = 'text/javascript; charset=utf-8'
    '.mjs'  = 'text/javascript; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.svg'  = 'image/svg+xml'
    '.png'  = 'image/png'
    '.jpg'  = 'image/jpeg'
    '.jpeg' = 'image/jpeg'
    '.webp' = 'image/webp'
    '.ico'  = 'image/x-icon'
    '.fgb'  = 'application/octet-stream'
    '.wasm' = 'application/wasm'
    '.txt'  = 'text/plain; charset=utf-8'
    '.yaml' = 'text/yaml; charset=utf-8'
}

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$Port/")
try {
    $listener.Start()
} catch {
    Write-Error "No se pudo abrir el puerto $Port (en uso?). Prueba con: .\serve.ps1 -Port 8001"
    exit 1
}

$url = "http://localhost:$Port/$Ruta"
Write-Host "Sirviendo $raiz"
Write-Host "  principal: http://localhost:$Port/"
Write-Host "  develop:   http://localhost:$Port/develop/"
Write-Host 'Ctrl+C para parar.'
if (-not $NoAbrir) { Start-Process $url }

try {
    $pendiente = $listener.GetContextAsync()
    while ($true) {
        if (-not $pendiente.AsyncWaitHandle.WaitOne(200)) { continue }
        $ctx = $pendiente.GetAwaiter().GetResult()
        $pendiente = $listener.GetContextAsync()

        $res = $ctx.Response
        try {
            $rel = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
            $ruta = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($raiz, $rel))
            if (Test-Path -LiteralPath $ruta -PathType Container) {
                if (-not $ctx.Request.Url.AbsolutePath.EndsWith('/')) {
                    $res.StatusCode = 301
                    $res.RedirectLocation = $ctx.Request.Url.AbsolutePath + '/'
                    $res.Close()
                    continue
                }
                $ruta = Join-Path $ruta 'index.html'
            }

            if (-not $ruta.StartsWith($raiz) -or -not (Test-Path -LiteralPath $ruta -PathType Leaf)) {
                $res.StatusCode = 404
                Write-Host "404 $($ctx.Request.Url.AbsolutePath)" -ForegroundColor Yellow
            } else {
                $ext = [System.IO.Path]::GetExtension($ruta).ToLowerInvariant()
                $res.ContentType = if ($tipos.ContainsKey($ext)) { $tipos[$ext] } else { 'application/octet-stream' }
                $res.Headers.Add('Cache-Control', 'no-store')
                $res.Headers.Add('Accept-Ranges', 'bytes')
                $total = (Get-Item -LiteralPath $ruta).Length
                $ini = 0L
                $fin = $total - 1
                $estado = 200
                $rango = [regex]::Match([string]$ctx.Request.Headers['Range'], '^bytes=(\d*)-(\d*)$')
                if ($rango.Success -and ($rango.Groups[1].Value -ne '' -or $rango.Groups[2].Value -ne '')) {
                    if ($rango.Groups[1].Value -eq '') {
                        $ini = [Math]::Max(0L, $total - [long]$rango.Groups[2].Value)
                    } else {
                        $ini = [long]$rango.Groups[1].Value
                        if ($rango.Groups[2].Value -ne '') { $fin = [Math]::Min([long]$rango.Groups[2].Value, $total - 1) }
                    }
                    if ($ini -gt $fin) {
                        $res.StatusCode = 416
                        $res.Headers.Add('Content-Range', "bytes */$total")
                        $estado = 416
                    } else {
                        $estado = 206
                        $res.StatusCode = 206
                        $res.Headers.Add('Content-Range', "bytes $ini-$fin/$total")
                    }
                }
                if ($estado -ne 416) {
                    $largo = $fin - $ini + 1
                    $res.ContentLength64 = $largo
                    if ($ctx.Request.HttpMethod -ne 'HEAD') {
                        $fs = [System.IO.File]::Open($ruta, 'Open', 'Read', 'ReadWrite')
                        try {
                            $null = $fs.Seek($ini, 'Begin')
                            $buf = New-Object byte[] 65536
                            $resta = $largo
                            while ($resta -gt 0) {
                                $n = $fs.Read($buf, 0, [int][Math]::Min($buf.Length, $resta))
                                if ($n -le 0) { break }
                                $res.OutputStream.Write($buf, 0, $n)
                                $resta -= $n
                            }
                        } finally { $fs.Dispose() }
                    }
                }
                Write-Host "$estado $($ctx.Request.Url.AbsolutePath)"
            }
        } catch {
            try { $res.StatusCode = 500 } catch {}
        } finally {
            try { $res.Close() } catch {}
        }
    }
} finally {
    $listener.Stop()
    $listener.Close()
}
