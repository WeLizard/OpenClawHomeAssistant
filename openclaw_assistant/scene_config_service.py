#!/usr/bin/env python3
from __future__ import annotations

import json
import logging
import os
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit


HOST = os.environ.get("SCENE_EDITOR_HOST", "127.0.0.1")
PORT = int(os.environ.get("SCENE_EDITOR_PORT", "48098"))
PATH_PREFIX = "/scene-editor"
SCENE_ROOT = Path(os.environ.get("SCENE_ROOT", "/config/openclaw-scene"))
PACKS_DIR = Path(os.environ.get("SCENE_PACKS_DIR", str(SCENE_ROOT / "scene-packs")))
ACTIVE_PACK_FILE = Path(
    os.environ.get("SCENE_ACTIVE_PACK_FILE", str(SCENE_ROOT / "active-pack.json"))
)
DEFAULT_PACK_ID = os.environ.get("SCENE_DEFAULT_PACK_ID", "neiri").strip() or "neiri"
EXPLICIT_SCENE_CONFIG_PATH = os.environ.get("SCENE_EDITOR_CONFIG_PATH", "").strip()
LEGACY_SCENE_CONFIG_PATHS = (
    Path("/config/www/neiri-scene/scene.default.json"),
    Path("/config/www/live2d/neiri-slides.json"),
    Path("/config/haoskiosk/display-config.json"),
)

DEFAULT_SCENE_CONFIG: dict[str, Any] = {
    "version": 1,
    "rotation": {
        "order": ["page-1"],
        "defaultDwellSeconds": 18,
    },
    "pages": [
        {
            "id": "page-1",
            "kind": "cards",
            "title": "Overview",
            "subtitle": "Add dashboard cards here",
            "cards": [],
        }
    ],
}

EDITOR_HTML_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenClaw Scene Editor</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #08131d;
      --paper: #102131;
      --paper-2: #15293c;
      --line: rgba(255,255,255,0.11);
      --text: #e9f2f7;
      --muted: #a8bac7;
      --accent: #68c3a3;
      --bad: #ef8e8e;
      --ok: #88d69e;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font: 14px/1.5 "Aptos", "Segoe UI", sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at top, rgba(104,195,163,0.14), transparent 34%),
        linear-gradient(180deg, #07111a 0%, #0d1b29 100%);
    }
    .wrap {
      max-width: 1160px;
      margin: 0 auto;
      padding: 28px 20px 40px;
      display: grid;
      gap: 18px;
    }
    .panel {
      background: linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.03));
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 18px;
      box-shadow: 0 18px 50px rgba(0,0,0,0.18);
    }
    h1, h2 { margin: 0; line-height: 1.05; }
    h1 { font-size: 30px; letter-spacing: -0.04em; }
    h2 { font-size: 16px; margin-bottom: 10px; }
    p { margin: 0; color: var(--muted); }
    .row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
    }
    button, textarea {
      font: inherit;
    }
    textarea {
      width: 100%;
      min-height: 560px;
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 12px 14px;
      color: var(--text);
      background: var(--paper);
      resize: vertical;
      font-family: "Cascadia Code", "Consolas", monospace;
      line-height: 1.45;
    }
    button {
      border: 1px solid rgba(104,195,163,0.3);
      background: linear-gradient(180deg, rgba(104,195,163,0.18), rgba(104,195,163,0.08));
      color: var(--text);
      border-radius: 12px;
      padding: 10px 14px;
      cursor: pointer;
    }
    button:hover { border-color: rgba(104,195,163,0.5); }
    code {
      background: rgba(255,255,255,0.06);
      border-radius: 6px;
      padding: 2px 6px;
    }
    .status {
      min-height: 20px;
      font-size: 13px;
      color: var(--muted);
    }
    .status.ok { color: var(--ok); }
    .status.bad { color: var(--bad); }
    .meta {
      display: grid;
      gap: 6px;
      font-size: 13px;
      color: var(--muted);
    }
  </style>
</head>
<body>
  <div class="wrap">
    <section class="panel">
      <h1>OpenClaw Scene Editor</h1>
      <p>Ingress-owned editor for the renderer scene config. This now belongs to OpenClaw Assistant, not HAOS-kiosk.</p>
    </section>
    <section class="panel">
      <div class="row">
        <button id="loadBtn" type="button">Load</button>
        <button id="validateBtn" type="button">Validate JSON</button>
        <button id="formatBtn" type="button">Format</button>
        <button id="newPageBtn" type="button">+ Page</button>
        <button id="starterBtn" type="button">Template</button>
        <button id="saveBtn" type="button">Save</button>
      </div>
      <div id="status" class="status"></div>
    </section>
    <section class="panel">
      <h2>Scene Config</h2>
      <textarea id="editor" spellcheck="false"></textarea>
    </section>
    <section class="panel meta">
      <div>Active pack: <code>__ACTIVE_PACK_ID__</code></div>
      <div>Primary path: <code>__SCENE_EDITOR_CONFIG_PATH__</code></div>
      <div>Legacy read-only fallback: <code>__LEGACY_SCENE_EDITOR_CONFIG_PATHS__</code></div>
      <div>Saving always writes to the primary path so the hosted scene app and editor share one source of truth.</div>
    </section>
  </div>
  <script>
    const editorEl = document.getElementById('editor');
    const statusEl = document.getElementById('status');
    const loadBtn = document.getElementById('loadBtn');
    const saveBtn = document.getElementById('saveBtn');
    const validateBtn = document.getElementById('validateBtn');
    const formatBtn = document.getElementById('formatBtn');
    const newPageBtn = document.getElementById('newPageBtn');
    const starterBtn = document.getElementById('starterBtn');

    function setStatus(text, kind) {
      statusEl.textContent = text || '';
      statusEl.className = `status${kind ? ` ${kind}` : ''}`;
    }

    function apiUrl() {
      return new URL('./api/config', window.location.href).toString();
    }

    function starterConfig() {
      return {
        version: 1,
        rotation: {
          order: ['page-1'],
          defaultDwellSeconds: 18
        },
        pages: [
          {
            id: 'page-1',
            kind: 'cards',
            title: 'Overview',
            subtitle: 'Add dashboard cards here',
            cards: []
          }
        ]
      };
    }

    function setEditorValue(config, statusMessage) {
      editorEl.value = JSON.stringify(config, null, 2);
      if (statusMessage) {
        setStatus(statusMessage, 'ok');
      }
    }

    function parseConfig() {
      return JSON.parse(editorEl.value);
    }

    function readConfigOrDefault() {
      if (!editorEl.value.trim()) {
        return starterConfig();
      }
      return parseConfig();
    }

    function formatJsonInEditor() {
      setEditorValue(readConfigOrDefault(), 'JSON formatted.');
    }

    function addPage() {
      const config = readConfigOrDefault();
      if (!config.rotation || typeof config.rotation !== 'object') {
        config.rotation = { order: [], defaultDwellSeconds: 18 };
      }
      if (!Array.isArray(config.rotation.order)) {
        config.rotation.order = [];
      }
      if (!Array.isArray(config.pages)) {
        config.pages = [];
      }
      const nextIndex = config.pages.length + 1;
      const pageId = `page-${nextIndex}`;
      config.pages.push({
        id: pageId,
        kind: 'cards',
        title: `Page ${nextIndex}`,
        subtitle: 'New scene section',
        cards: []
      });
      config.rotation.order.push(pageId);
      setEditorValue(config, `Added ${pageId}.`);
    }

    async function loadConfig() {
      setStatus('Loading...');
      const response = await fetch(apiUrl(), { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      editorEl.value = JSON.stringify(data.config, null, 2);
      if (data.loadedFrom && data.loadedFrom !== data.path) {
        setStatus(`Loaded legacy config from ${data.loadedFrom}. Save to migrate into ${data.path}.`, 'ok');
      } else {
        setStatus(`Loaded ${data.path}.`, 'ok');
      }
    }

    async function saveConfig() {
      const parsed = parseConfig();
      setStatus('Saving...');
      const response = await fetch(apiUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      editorEl.value = JSON.stringify(data.config, null, 2);
      setStatus(`Saved ${data.path}.`, 'ok');
    }

    loadBtn.addEventListener('click', async () => {
      try { await loadConfig(); } catch (error) { setStatus(String(error), 'bad'); }
    });

    validateBtn.addEventListener('click', () => {
      try {
        parseConfig();
        setStatus('JSON is valid.', 'ok');
      } catch (error) {
        setStatus(String(error), 'bad');
      }
    });

    formatBtn.addEventListener('click', () => {
      try { formatJsonInEditor(); } catch (error) { setStatus(String(error), 'bad'); }
    });

    newPageBtn.addEventListener('click', () => {
      try { addPage(); } catch (error) { setStatus(String(error), 'bad'); }
    });

    starterBtn.addEventListener('click', () => {
      try { setEditorValue(starterConfig(), 'Applied starter template.'); } catch (error) { setStatus(String(error), 'bad'); }
    });

    saveBtn.addEventListener('click', async () => {
      try { await saveConfig(); } catch (error) { setStatus(String(error), 'bad'); }
    });

    loadConfig().catch((error) => setStatus(String(error), 'bad'));
  </script>
</body>
</html>
"""


def normalize_scene_config(config: Any) -> dict[str, Any]:
    if not isinstance(config, dict):
        raise ValueError("Scene config must be a JSON object")
    return config


def load_active_pack_id() -> str:
    if ACTIVE_PACK_FILE.exists():
        try:
            payload = json.loads(ACTIVE_PACK_FILE.read_text(encoding="utf-8"))
            value = str(payload.get("id", "")).strip()
            if value:
                return value
        except Exception as exc:
            logging.warning("Failed to read %s: %s", ACTIVE_PACK_FILE, exc)
    return DEFAULT_PACK_ID


def resolve_primary_scene_config_path() -> Path:
    if EXPLICIT_SCENE_CONFIG_PATH:
        return Path(EXPLICIT_SCENE_CONFIG_PATH)
    return PACKS_DIR / load_active_pack_id() / "scene.default.json"


def resolve_legacy_scene_config_paths(primary_path: Path) -> tuple[Path, ...]:
    paths: list[Path] = []
    for candidate in LEGACY_SCENE_CONFIG_PATHS:
        if candidate == primary_path or candidate in paths:
            continue
        paths.append(candidate)
    return tuple(paths)


def render_editor_html() -> bytes:
    primary_path = resolve_primary_scene_config_path()
    legacy_paths = ", ".join(
        str(path) for path in resolve_legacy_scene_config_paths(primary_path)
    )
    html_text = EDITOR_HTML_TEMPLATE.replace(
        "__ACTIVE_PACK_ID__",
        load_active_pack_id(),
    ).replace(
        "__SCENE_EDITOR_CONFIG_PATH__",
        str(primary_path),
    ).replace(
        "__LEGACY_SCENE_EDITOR_CONFIG_PATHS__",
        legacy_paths,
    )
    return html_text.encode("utf-8")


def load_scene_config() -> tuple[dict[str, Any], Path, str | None]:
    primary_path = resolve_primary_scene_config_path()
    if primary_path.exists():
        return normalize_scene_config(
            json.loads(primary_path.read_text(encoding="utf-8"))
        ), primary_path, None

    for legacy_path in resolve_legacy_scene_config_paths(primary_path):
        if legacy_path.exists():
            return normalize_scene_config(
                json.loads(legacy_path.read_text(encoding="utf-8"))
            ), primary_path, str(legacy_path)

    return (
        normalize_scene_config(json.loads(json.dumps(DEFAULT_SCENE_CONFIG))),
        primary_path,
        None,
    )


def save_scene_config(config: Any) -> tuple[dict[str, Any], Path]:
    normalized = normalize_scene_config(config)
    primary_path = resolve_primary_scene_config_path()
    primary_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = primary_path.with_suffix(primary_path.suffix + ".tmp")
    temp_path.write_text(
        json.dumps(normalized, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(temp_path, primary_path)
    return normalized, primary_path


class SceneConfigHandler(BaseHTTPRequestHandler):
    server_version = "OpenClawSceneEditor/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        logging.info("%s - %s", self.address_string(), fmt % args)

    def send_json(self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_html(self, body: bytes) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json_body(self) -> Any:
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length else b"{}"
        if not raw:
            raw = b"{}"
        return json.loads(raw.decode("utf-8"))

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == "/health":
            primary_path = resolve_primary_scene_config_path()
            self.send_json(
                {
                    "status": "ok",
                    "path": str(primary_path),
                    "activePackId": load_active_pack_id(),
                }
            )
            return
        if path in (PATH_PREFIX, PATH_PREFIX + "/"):
            self.send_html(render_editor_html())
            return
        if path == PATH_PREFIX + "/api/config":
            try:
                config, primary_path, loaded_from = load_scene_config()
                self.send_json(
                    {
                        "success": True,
                        "config": config,
                        "path": str(primary_path),
                        "packId": load_active_pack_id(),
                        "loadedFrom": loaded_from,
                    }
                )
            except Exception as exc:
                logging.exception("Failed to load scene config: %s", exc)
                self.send_json(
                    {"success": False, "error": str(exc)},
                    status=HTTPStatus.INTERNAL_SERVER_ERROR,
                )
            return
        self.send_json(
            {"success": False, "error": f"Endpoint not found: {path}"},
            status=HTTPStatus.NOT_FOUND,
        )

    def do_POST(self) -> None:
        path = urlsplit(self.path).path
        if path != PATH_PREFIX + "/api/config":
            self.send_json(
                {"success": False, "error": f"Endpoint not found: {path}"},
                status=HTTPStatus.NOT_FOUND,
            )
            return
        try:
            payload = self.read_json_body()
        except json.JSONDecodeError:
            self.send_json(
                {"success": False, "error": "Invalid JSON payload"},
                status=HTTPStatus.BAD_REQUEST,
            )
            return

        try:
            config, primary_path = save_scene_config(payload)
            self.send_json(
                {
                    "success": True,
                    "config": config,
                    "path": str(primary_path),
                    "packId": load_active_pack_id(),
                }
            )
        except ValueError as exc:
            self.send_json(
                {"success": False, "error": str(exc)},
                status=HTTPStatus.BAD_REQUEST,
            )
        except Exception as exc:
            logging.exception("Failed to save scene config: %s", exc)
            self.send_json(
                {"success": False, "error": str(exc)},
                status=HTTPStatus.INTERNAL_SERVER_ERROR,
            )


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="[%(asctime)s] %(levelname)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    server = ThreadingHTTPServer((HOST, PORT), SceneConfigHandler)
    logging.info(
        "Starting scene config service on http://%s:%s for %s",
        HOST,
        PORT,
        resolve_primary_scene_config_path(),
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
