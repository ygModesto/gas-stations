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
                $bytes = [System.IO.File]::ReadAllBytes($ruta)
                $res.ContentLength64 = $bytes.Length
                if ($ctx.Request.HttpMethod -ne 'HEAD') { $res.OutputStream.Write($bytes, 0, $bytes.Length) }
                Write-Host "200 $($ctx.Request.Url.AbsolutePath)"
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
