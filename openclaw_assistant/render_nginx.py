#!/usr/bin/env python3
"""
Render nginx.conf and landing page HTML from templates.

Called by run.sh with the following env vars:
  GW_PUBLIC_URL, GW_TOKEN, TERMINAL_PORT,
  ENABLE_HTTPS_PROXY, HTTPS_PROXY_PORT,
  GATEWAY_INTERNAL_PORT, ACCESS_MODE,
  DISK_TOTAL, DISK_USED, DISK_AVAIL, DISK_PCT,
  RUNTIME_INSTALL_MODE, RUNTIME_SOURCE_REPO_URL,
  RUNTIME_SOURCE_BRANCH, RUNTIME_SOURCE_HEAD,
  RUNTIME_PACKAGE_VERSION
"""

import html
import json
import os
import subprocess
from pathlib import Path
from urllib.parse import urlparse


def summarize_repo(repo_url: str) -> str:
    value = (repo_url or "").strip()
    if not value:
        return ""
    if value.startswith("git@"):
        _, _, tail = value.partition(":")
        label = tail
    else:
        parsed = urlparse(value)
        label = parsed.path or value
    label = label.strip("/")
    if label.endswith(".git"):
        label = label[:-4]
    return label or value


def read_openclaw_config():
    config_path = Path(
        os.environ.get("OPENCLAW_CONFIG_PATH", "/config/.openclaw/openclaw.json")
    )
    try:
        return json.loads(config_path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def resolve_model_primary(value):
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        primary = value.get("primary")
        if isinstance(primary, str):
            return primary.strip()
    return ""


def resolve_model_fallbacks(value):
    if isinstance(value, dict):
        raw = value.get("fallbacks")
        if isinstance(raw, list):
            return [entry.strip() for entry in raw if isinstance(entry, str) and entry.strip()]
    return []


def format_model_list(values):
    return ", ".join(values) if values else "-"


def format_remaining_short(remaining_ms):
    if not isinstance(remaining_ms, (int, float)):
        return "unknown"
    if remaining_ms <= 0:
        return "0m"
    rounded_minutes = round(remaining_ms / 60_000)
    if rounded_minutes < 1:
        return "1m"
    if rounded_minutes < 60:
        return f"{rounded_minutes}m"
    rounded_hours = round(rounded_minutes / 60)
    if rounded_hours < 48:
        return f"{rounded_hours}h"
    return f"{round(rounded_hours / 24)}d"


def load_model_status_json():
    try:
        result = subprocess.run(
            ["openclaw", "models", "status", "--json"],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
    except Exception as exc:
        return None, str(exc)

    if result.returncode != 0:
        stderr = (result.stderr or "").strip()
        stdout = (result.stdout or "").strip()
        return None, stderr or stdout or f"exit {result.returncode}"

    try:
        return json.loads(result.stdout), None
    except json.JSONDecodeError as exc:
        return None, f"invalid JSON: {exc}"


def build_model_health_summary():
    cfg = read_openclaw_config()
    defaults = cfg.get("agents", {}).get("defaults", {})

    text_primary = resolve_model_primary(defaults.get("model"))
    text_fallbacks = resolve_model_fallbacks(defaults.get("model"))
    image_primary = resolve_model_primary(defaults.get("imageModel"))
    image_fallbacks = resolve_model_fallbacks(defaults.get("imageModel"))

    summary = {
        "model_primary": text_primary or "not configured",
        "model_fallbacks": format_model_list(text_fallbacks),
        "image_model": image_primary or "inherit from text model",
        "image_fallbacks": format_model_list(image_fallbacks),
        "model_health_icon": "❔",
        "model_health_label": "unknown",
        "model_health_detail": "Model health not available yet.",
    }

    payload, error = load_model_status_json()
    if payload is None:
        if error:
            summary["model_health_detail"] = f"openclaw models status unavailable: {error}"
        return summary

    summary["model_primary"] = payload.get("defaultModel") or summary["model_primary"]
    summary["model_fallbacks"] = format_model_list(payload.get("fallbacks") or text_fallbacks)
    image_model = payload.get("imageModel")
    summary["image_model"] = image_model or summary["image_model"]
    summary["image_fallbacks"] = format_model_list(
        payload.get("imageFallbacks") or image_fallbacks
    )

    primary_provider = ""
    if "/" in summary["model_primary"]:
        primary_provider = summary["model_primary"].split("/", 1)[0]

    auth = payload.get("auth", {})
    missing_in_use = [
        entry.strip()
        for entry in auth.get("missingProvidersInUse", [])
        if isinstance(entry, str) and entry.strip()
    ]
    unusable_profiles = [
        entry for entry in auth.get("unusableProfiles", []) if isinstance(entry, dict)
    ]
    oauth_providers = {
        entry.get("provider"): entry
        for entry in auth.get("oauth", {}).get("providers", [])
        if isinstance(entry, dict) and isinstance(entry.get("provider"), str)
    }

    fallback_ready = summary["model_fallbacks"] != "-"
    primary_unusable = next(
        (
            entry
            for entry in unusable_profiles
            if isinstance(entry.get("provider"), str) and entry.get("provider") == primary_provider
        ),
        None,
    )
    first_unusable = primary_unusable or (unusable_profiles[0] if unusable_profiles else None)
    primary_health = oauth_providers.get(primary_provider)

    if missing_in_use:
        summary["model_health_icon"] = "❌"
        summary["model_health_label"] = "broken"
        summary["model_health_detail"] = "Missing auth for: " + ", ".join(missing_in_use)
    elif first_unusable:
        provider = first_unusable.get("provider") or primary_provider or "provider"
        kind = first_unusable.get("kind") or "cooldown"
        remaining = format_remaining_short(first_unusable.get("remainingMs"))
        reason = first_unusable.get("reason")
        summary["model_health_icon"] = "⚠️" if fallback_ready else "❌"
        summary["model_health_label"] = "degraded" if fallback_ready else "broken"
        detail = f"{provider} {kind} for {remaining}"
        if reason:
            detail = f"{detail} ({reason})"
        if fallback_ready:
            detail = f"{detail}; fallback ready: {summary['model_fallbacks']}"
        summary["model_health_detail"] = detail
    elif isinstance(primary_health, dict) and primary_health.get("status") in {"expired", "missing"}:
        remaining = format_remaining_short(primary_health.get("remainingMs"))
        summary["model_health_icon"] = "⚠️" if fallback_ready else "❌"
        summary["model_health_label"] = "degraded" if fallback_ready else "broken"
        detail = f"{primary_provider or 'primary'} auth {primary_health.get('status')}"
        if remaining != "unknown":
            detail = f"{detail} ({remaining})"
        if fallback_ready:
            detail = f"{detail}; fallback ready: {summary['model_fallbacks']}"
        summary["model_health_detail"] = detail
    elif isinstance(primary_health, dict) and primary_health.get("status") == "expiring":
        remaining = format_remaining_short(primary_health.get("remainingMs"))
        summary["model_health_icon"] = "⚠️"
        summary["model_health_label"] = "degraded"
        summary["model_health_detail"] = (
            f"{primary_provider or 'primary'} auth expiring in {remaining}; "
            f"fallback ready: {summary['model_fallbacks']}"
        )
    else:
        summary["model_health_icon"] = "✅"
        summary["model_health_label"] = "healthy"
        detail = "Primary auth OK."
        if fallback_ready:
            detail = f"{detail} Fallback ready: {summary['model_fallbacks']}"
        if unusable_profiles:
            detail = f"{detail} {len(unusable_profiles)} non-primary unusable profile(s)."
        summary["model_health_detail"] = detail

    return summary


def main():
    tpl = Path("/etc/nginx/nginx.conf.tpl").read_text()
    landing_tpl = Path("/etc/nginx/landing.html.tpl").read_text()

    public_url = os.environ.get("GW_PUBLIC_URL", "")
    terminal_port = os.environ.get("TERMINAL_PORT", "7681")
    enable_https = os.environ.get("ENABLE_HTTPS_PROXY", "false") == "true"
    https_port = os.environ.get("HTTPS_PROXY_PORT", "")
    internal_gw_port = os.environ.get("GATEWAY_INTERNAL_PORT", "")
    access_mode = os.environ.get("ACCESS_MODE", "custom")

    disk_total = os.environ.get("DISK_TOTAL", "")
    disk_used = os.environ.get("DISK_USED", "")
    disk_avail = os.environ.get("DISK_AVAIL", "")
    disk_pct = os.environ.get("DISK_PCT", "")
    nginx_log_level = os.environ.get("NGINX_LOG_LEVEL", "minimal")
    runtime_install_mode = os.environ.get("RUNTIME_INSTALL_MODE", "package")
    runtime_source_repo_url = os.environ.get("RUNTIME_SOURCE_REPO_URL", "")
    runtime_source_branch = os.environ.get("RUNTIME_SOURCE_BRANCH", "")
    runtime_source_head = os.environ.get("RUNTIME_SOURCE_HEAD", "")
    runtime_package_version = os.environ.get("RUNTIME_PACKAGE_VERSION", "")

    token = os.environ.get("GW_TOKEN", "")

    gw_path = "" if public_url.endswith("/") else "/"

    if nginx_log_level == "minimal":
        access_log_block = (
            "# Suppress repetitive HA health-check / polling requests\n"
            "  map $http_user_agent $loggable {\n"
            "    ~HomeAssistant 0;\n"
            "    default 1;\n"
            "  }\n"
            "  access_log /dev/stdout combined if=$loggable;"
        )
    else:
        access_log_block = "access_log /dev/stdout;"

    conf = tpl.replace("__NGINX_ACCESS_LOG__", access_log_block)
    conf = conf.replace("__TERMINAL_PORT__", terminal_port)

    https_block = ""
    if enable_https and https_port and internal_gw_port:
        https_block = f"""
    # --- HTTPS Gateway Proxy (lan_https mode) ---
    server {{
        listen {https_port} ssl;

        ssl_certificate     /config/certs/gateway.crt;
        ssl_certificate_key /config/certs/gateway.key;
        ssl_protocols       TLSv1.2 TLSv1.3;
        ssl_ciphers         HIGH:!aNULL:!MD5;

        # Proxy all traffic to the loopback gateway with WebSocket support
        location / {{
            proxy_pass http://127.0.0.1:{internal_gw_port};
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto https;
            proxy_read_timeout 86400s;
            proxy_send_timeout 86400s;
            proxy_buffering off;
        }}

        # Download the local CA certificate (install on phone for trusted access)
        location = /cert/ca.crt {{
            alias /etc/nginx/html/openclaw-ca.crt;
            default_type application/x-x509-ca-cert;
            add_header Content-Disposition 'attachment; filename="openclaw-ca.crt"';
        }}
    }}
"""

    conf = conf.replace("__HTTPS_GATEWAY_BLOCK__", https_block)
    Path("/etc/nginx/nginx.conf").write_text(conf)

    if enable_https and not public_url:
        try:
            lan_ip = subprocess.check_output(
                ["hostname", "-I"], text=True, timeout=2
            ).split()[0]
        except Exception:
            lan_ip = "127.0.0.1"
        public_url = f"https://{lan_ip}:{https_port}"
        gw_path = "/"

    repo_label = summarize_repo(runtime_source_repo_url)
    if runtime_install_mode == "source":
        runtime_mode_label = "source"
        runtime_detail = "configured Git checkout"
        detail_parts = [part for part in [repo_label, runtime_source_branch] if part]
        if detail_parts:
            runtime_detail = " ".join(detail_parts)
        if runtime_source_head:
            runtime_detail = f"{runtime_detail} @ {runtime_source_head[:7]}"
        package_warning_class = "hidden"
        package_warning = ""
    else:
        runtime_mode_label = "package"
        runtime_detail = runtime_package_version or "bundled image runtime"
        tracked_ref = " ".join(
            part for part in [repo_label, runtime_source_branch] if part
        ).strip()
        if not tracked_ref:
            tracked_ref = "the configured Git repo"
        package_warning_class = ""
        package_warning = (
            f"This add-on is using the bundled {runtime_detail}. "
            f"GitHub updates from {tracked_ref} are not pulled in package mode; "
            "set install_mode to source if you want Home Assistant to rebuild from "
            "the configured repo on restart."
        )

    model_health = build_model_health_summary()

    replacements = {
        "__GATEWAY_TOKEN__": html.escape(token, quote=True),
        "__GATEWAY_PUBLIC_URL__": html.escape(public_url, quote=True),
        "__GW_PUBLIC_URL_PATH__": html.escape(gw_path, quote=True),
        "__ACCESS_MODE__": html.escape(access_mode, quote=True),
        "__HTTPS_PORT__": html.escape(https_port if enable_https else "", quote=True),
        "__DISK_TOTAL__": html.escape(disk_total, quote=True),
        "__DISK_USED__": html.escape(disk_used, quote=True),
        "__DISK_AVAIL__": html.escape(disk_avail, quote=True),
        "__DISK_PCT__": html.escape(disk_pct, quote=True),
        "__RUNTIME_MODE_LABEL__": html.escape(runtime_mode_label, quote=True),
        "__RUNTIME_DETAIL__": html.escape(runtime_detail, quote=True),
        "__PACKAGE_WARNING_CLASS__": html.escape(package_warning_class, quote=True),
        "__PACKAGE_WARNING__": html.escape(package_warning, quote=True),
        "__MODEL_PRIMARY__": html.escape(model_health["model_primary"], quote=True),
        "__MODEL_FALLBACKS__": html.escape(model_health["model_fallbacks"], quote=True),
        "__IMAGE_MODEL__": html.escape(model_health["image_model"], quote=True),
        "__IMAGE_FALLBACKS__": html.escape(model_health["image_fallbacks"], quote=True),
        "__MODEL_HEALTH_ICON__": html.escape(model_health["model_health_icon"], quote=True),
        "__MODEL_HEALTH_LABEL__": html.escape(model_health["model_health_label"], quote=True),
        "__MODEL_HEALTH_DETAIL__": html.escape(
            model_health["model_health_detail"], quote=True
        ),
    }

    landing = landing_tpl
    for placeholder, value in replacements.items():
        landing = landing.replace(placeholder, value)

    out_dir = Path("/etc/nginx/html")
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / "index.html"
    out_file.write_text(landing)

    try:
        out_dir.chmod(0o755)
        out_file.chmod(0o644)
    except Exception:
        pass


if __name__ == "__main__":
    main()
