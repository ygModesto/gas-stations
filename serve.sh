#!/usr/bin/env bash
# Equivalente de serve.ps1 para Linux. Sirve el directorio del propio script como web estática.
#
# El reparto es: bash se encarga de lo que bash hace bien (argumentos, leer el puerto de
# config.yaml, abrir el navegador, mensajes) y delega el servidor en python3, que está en cualquier
# Ubuntu. No se usa `python3 -m http.server`: ese NO soporta peticiones Range -- devuelve 200 con
# el fichero entero en vez de 206 con el trozo pedido -- y FlatGeobuf lee los .fgb justamente por
# rangos, así que con él las gasolineras no llegan a cargarse.
#
#   ./serve.sh                 puerto de config.yaml (o 8000) y abre el navegador
#   ./serve.sh -p 8001         otro puerto
#   ./serve.sh -r develop/     abre esa ruta en vez de la raíz
#   ./serve.sh -n              no abrir el navegador

set -euo pipefail

RAIZ="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PUERTO=0
RUTA=''
ABRIR=1

ayuda() {
    cat <<'AYUDA'
Uso: ./serve.sh [opciones]

  -p, --port <n>   Puerto. Por defecto, el de config.yaml (servidor.puerto) o 8000.
  -r, --ruta <r>   Ruta que abrir en el navegador, relativa a la raíz. Por defecto, la raíz.
  -n, --no-abrir   No abrir el navegador.
  -h, --help       Esta ayuda.
AYUDA
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -p|--port|--puerto)
            [[ $# -ge 2 ]] || { echo "Falta el valor de $1" >&2; exit 1; }
            PUERTO="$2"; shift 2 ;;
        -r|--ruta)
            [[ $# -ge 2 ]] || { echo "Falta el valor de $1" >&2; exit 1; }
            RUTA="$2"; shift 2 ;;
        -n|--no-abrir|--noabrir)
            ABRIR=0; shift ;;
        -h|--help)
            ayuda; exit 0 ;;
        *)
            echo "Opción desconocida: $1" >&2; ayuda >&2; exit 1 ;;
    esac
done

[[ "$PUERTO" =~ ^[0-9]+$ ]] || { echo "El puerto debe ser un número: $PUERTO" >&2; exit 1; }

# Mismo criterio que serve.ps1: el puerto sale de config.yaml, y 8000 solo si no está. La clave va
# indentada (cuelga de 'servidor:'), de ahí que el patrón exija espacio delante.
if [[ "$PUERTO" -eq 0 ]]; then
    PUERTO=8000
    if [[ -f "$RAIZ/config.yaml" ]]; then
        del_config="$(sed -nE 's/^[[:space:]]+puerto:[[:space:]]*([0-9]+).*/\1/p' "$RAIZ/config.yaml" | head -1)"
        [[ -n "$del_config" ]] && PUERTO="$del_config"
    fi
fi

command -v python3 >/dev/null 2>&1 || {
    echo "Hace falta python3. Instálalo con: sudo apt install python3" >&2
    exit 1
}

URL="http://localhost:$PUERTO/$RUTA"

# En segundo plano y con una pausa: el navegador no debe llamar antes de que el socket escuche.
if [[ "$ABRIR" -eq 1 ]] && command -v xdg-open >/dev/null 2>&1; then
    ( sleep 0.7; xdg-open "$URL" >/dev/null 2>&1 || true ) &
fi

# El programa va por stdin ('python3 -'), así que los argumentos de después se reciben tal cual.
exec python3 - "$RAIZ" "$PUERTO" <<'PYTHON'
import os
import re
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RAIZ = os.path.realpath(sys.argv[1])
PUERTO = int(sys.argv[2])

# Misma tabla que serve.ps1. No se usa el módulo mimetypes porque no conoce .fgb y porque conviene
# que los dos scripts sirvan exactamente lo mismo.
TIPOS = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'text/javascript; charset=utf-8',
    '.mjs':  'text/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg':  'image/svg+xml',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico':  'image/x-icon',
    '.fgb':  'application/octet-stream',
    '.wasm': 'application/wasm',
    '.txt':  'text/plain; charset=utf-8',
    '.yaml': 'text/yaml; charset=utf-8',
}

RANGO = re.compile(r'^bytes=(\d*)-(\d*)$')
COLOR = sys.stdout.isatty()


def pinta(estado, ruta):
    linea = f'{estado} {ruta}'
    if COLOR and estado >= 400:
        linea = f'\033[33m{linea}\033[0m'
    print(linea, flush=True)


class Servidor(BaseHTTPRequestHandler):
    # HTTP/1.1 para que el navegador reutilice la conexión: una vista del mapa son varias
    # peticiones de rango seguidas al mismo .fgb y abrir un socket por cada una se nota.
    protocol_version = 'HTTP/1.1'
    server_version = 'serve.sh'

    # El log propio (ver pinta) sustituye al de la clase base, que escribe a stderr en otro formato
    def log_message(self, formato, *args):
        pass

    def do_GET(self):
        self.servir(con_cuerpo=True)

    def do_HEAD(self):
        self.servir(con_cuerpo=False)

    def error(self, estado, ruta_url, cabeceras=None):
        self.send_response(estado)
        for nombre, valor in (cabeceras or {}).items():
            self.send_header(nombre, valor)
        self.send_header('Content-Length', '0')
        self.end_headers()
        pinta(estado, ruta_url)

    def servir(self, con_cuerpo):
        ruta_url = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        destino = os.path.realpath(os.path.join(RAIZ, ruta_url.lstrip('/')))

        # Un directorio se sirve como su index.html, pero antes hay que asegurar la barra final:
        # sin ella, las rutas relativas de dentro de la página colgarían del directorio padre.
        if os.path.isdir(destino):
            if not ruta_url.endswith('/'):
                self.error(301, ruta_url, {'Location': ruta_url + '/'})
                return
            destino = os.path.join(destino, 'index.html')

        # realpath ya ha resuelto los '..' y los enlaces simbólicos, así que comprobar el prefijo
        # aquí basta para que no se pueda salir del directorio servido.
        dentro = destino == RAIZ or destino.startswith(RAIZ + os.sep)
        if not dentro or not os.path.isfile(destino):
            self.error(404, ruta_url)
            return

        total = os.path.getsize(destino)
        ini, fin, estado = 0, total - 1, 200

        # Peticiones por rango: esto es lo que necesita FlatGeobuf para leer solo el trozo del .fgb
        # que cae en el recuadro visible en vez de bajarse los 3 MB enteros.
        m = RANGO.match(self.headers.get('Range', '') or '')
        if m and (m.group(1) or m.group(2)):
            if not m.group(1):
                ini = max(0, total - int(m.group(2)))  # 'bytes=-500': los últimos 500 bytes
            else:
                ini = int(m.group(1))
                if m.group(2):
                    fin = min(int(m.group(2)), total - 1)
            if ini > fin or ini >= total:
                self.error(416, ruta_url, {'Content-Range': f'bytes */{total}'})
                return
            estado = 206

        largo = fin - ini + 1
        extension = os.path.splitext(destino)[1].lower()

        self.send_response(estado)
        self.send_header('Content-Type', TIPOS.get(extension, 'application/octet-stream'))
        # no-store: esto es para desarrollar, así que un F5 tiene que traer el fichero de verdad
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Accept-Ranges', 'bytes')
        if estado == 206:
            self.send_header('Content-Range', f'bytes {ini}-{fin}/{total}')
        self.send_header('Content-Length', str(largo))
        self.end_headers()

        if con_cuerpo:
            with open(destino, 'rb') as f:
                f.seek(ini)
                resta = largo
                while resta > 0:
                    trozo = f.read(min(65536, resta))
                    if not trozo:
                        break
                    self.wfile.write(trozo)
                    resta -= len(trozo)

        pinta(estado, ruta_url)

    # El navegador corta descargas a media petición constantemente (al mover el mapa cancela los
    # rangos que ya no le valen). Eso llega aquí como una tubería rota y no es un error que
    # merezca traza: se deja caer la conexión y ya.
    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True


try:
    httpd = ThreadingHTTPServer(('127.0.0.1', PUERTO), Servidor)
except OSError as e:
    print(f'No se pudo abrir el puerto {PUERTO} ({e.strerror}). Prueba con: ./serve.sh -p {PUERTO + 1}',
          file=sys.stderr)
    sys.exit(1)

# flush explícito: fuera de una terminal, python almacena la salida y estos mensajes no se verían
# hasta la primera petición, que es justo cuando ya no hacen falta.
print(f'Sirviendo {RAIZ}')
print(f'  principal: http://localhost:{PUERTO}/')
print(f'  develop:   http://localhost:{PUERTO}/develop/')
print('Ctrl+C para parar.', flush=True)

try:
    httpd.serve_forever()
except KeyboardInterrupt:
    print()
finally:
    httpd.server_close()
PYTHON
