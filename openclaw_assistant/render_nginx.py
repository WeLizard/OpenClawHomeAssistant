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
import os
import subprocess
from pathlib import Path
from urllib.parse import urlparse


def summarize_repo(repo_url: str) -> str:
    value = (repo_url or '').strip()
    if not value:
        return ''
    if value.startswith('git@'):
        _, _, tail = value.partition(':')
        label = tail
    else:
        parsed = urlparse(value)
        label = parsed.path or value
    label = label.strip('/')
    if label.endswith('.git'):
        label = label[:-4]
    return label or value


def main():
    tpl = Path('/etc/nginx/nginx.conf.tpl').read_text()
    landing_tpl = Path('/etc/nginx/landing.html.tpl').read_text()

    public_url = os.environ.get('GW_PUBLIC_URL', '')
    terminal_port = os.environ.get('TERMINAL_PORT', '7681')
    enable_https = os.environ.get('ENABLE_HTTPS_PROXY', 'false') == 'true'
    https_port = os.environ.get('HTTPS_PROXY_PORT', '')
    internal_gw_port = os.environ.get('GATEWAY_INTERNAL_PORT', '')
    access_mode = os.environ.get('ACCESS_MODE', 'custom')

    # Disk usage info (collected by run.sh)
    disk_total = os.environ.get('DISK_TOTAL', '')
    disk_used = os.environ.get('DISK_USED', '')
    disk_avail = os.environ.get('DISK_AVAIL', '')
    disk_pct = os.environ.get('DISK_PCT', '')
    nginx_log_level = os.environ.get('NGINX_LOG_LEVEL', 'minimal')
    runtime_install_mode = os.environ.get('RUNTIME_INSTALL_MODE', 'package')
    runtime_source_repo_url = os.environ.get('RUNTIME_SOURCE_REPO_URL', '')
    runtime_source_branch = os.environ.get('RUNTIME_SOURCE_BRANCH', '')
    runtime_source_head = os.environ.get('RUNTIME_SOURCE_HEAD', '')
    runtime_package_version = os.environ.get('RUNTIME_PACKAGE_VERSION', '')

    # Token comes from environment (best-effort CLI query in run.sh)
    token = os.environ.get('GW_TOKEN', '')

    gw_path = '' if public_url.endswith('/') else '/'

    # ── nginx.conf ──────────────────────────────────────────────
    # Build access_log directive (minimal suppresses HA health-check / polling noise)
    if nginx_log_level == 'minimal':
        access_log_block = (
            '# Suppress repetitive HA health-check / polling requests\n'
            '  map $http_user_agent $loggable {\n'
            '    ~HomeAssistant 0;\n'
            '    default 1;\n'
            '  }\n'
            '  access_log /dev/stdout combined if=$loggable;'
        )
    else:
        access_log_block = 'access_log /dev/stdout;'

    conf = tpl.replace('__NGINX_ACCESS_LOG__', access_log_block)
    conf = conf.replace('__TERMINAL_PORT__', terminal_port)

    # Build HTTPS gateway proxy block (only for lan_https mode)
    https_block = ''
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

    conf = conf.replace('__HTTPS_GATEWAY_BLOCK__', https_block)
    Path('/etc/nginx/nginx.conf').write_text(conf)

    # ── landing page ────────────────────────────────────────────
    # If lan_https and no explicit public URL, auto-construct one
    if enable_https and not public_url:
        try:
            lan_ip = subprocess.check_output(
                ['hostname', '-I'], text=True, timeout=2
            ).split()[0]
        except Exception:
            lan_ip = '127.0.0.1'
        public_url = f'https://{lan_ip}:{https_port}'
        gw_path = '/'

    repo_label = summarize_repo(runtime_source_repo_url)
    if runtime_install_mode == 'source':
        runtime_mode_label = 'source'
        runtime_detail = 'configured Git checkout'
        detail_parts = [part for part in [repo_label, runtime_source_branch] if part]
        if detail_parts:
            runtime_detail = ' '.join(detail_parts)
        if runtime_source_head:
            short_head = runtime_source_head[:7]
            runtime_detail = f'{runtime_detail} @ {short_head}'
        package_warning_class = 'hidden'
        package_warning = ''
    else:
        runtime_mode_label = 'package'
        runtime_detail = runtime_package_version or 'bundled image runtime'
        tracked_ref = ' '.join(part for part in [repo_label, runtime_source_branch] if part).strip()
        if not tracked_ref:
            tracked_ref = 'the configured Git repo'
        package_warning_class = ''
        package_warning = (
            f'This add-on is using the bundled {runtime_detail}. '
            f'GitHub updates from {tracked_ref} are not pulled in package mode; '
            'set install_mode to source if you want Home Assistant to rebuild from '
            'the configured repo on restart.'
        )

    replacements = {
        '__GATEWAY_TOKEN__': html.escape(token, quote=True),
        '__GATEWAY_PUBLIC_URL__': html.escape(public_url, quote=True),
        '__GW_PUBLIC_URL_PATH__': html.escape(gw_path, quote=True),
        '__ACCESS_MODE__': html.escape(access_mode, quote=True),
        '__HTTPS_PORT__': html.escape(https_port if enable_https else '', quote=True),
        '__DISK_TOTAL__': html.escape(disk_total, quote=True),
        '__DISK_USED__': html.escape(disk_used, quote=True),
        '__DISK_AVAIL__': html.escape(disk_avail, quote=True),
        '__DISK_PCT__': html.escape(disk_pct, quote=True),
        '__RUNTIME_MODE_LABEL__': html.escape(runtime_mode_label, quote=True),
        '__RUNTIME_DETAIL__': html.escape(runtime_detail, quote=True),
        '__PACKAGE_WARNING_CLASS__': html.escape(package_warning_class, quote=True),
        '__PACKAGE_WARNING__': html.escape(package_warning, quote=True),
    }

    landing = landing_tpl
    for placeholder, value in replacements.items():
        landing = landing.replace(placeholder, value)

    out_dir = Path('/etc/nginx/html')
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / 'index.html'
    out_file.write_text(landing)

    # Ensure nginx can read it even if base image uses restrictive umask/permissions.
    try:
        out_dir.chmod(0o755)
        out_file.chmod(0o644)
    except Exception:
        pass


if __name__ == '__main__':
    main()
