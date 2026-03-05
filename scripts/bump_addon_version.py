#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import pathlib
import re
import sys


REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
CONFIG_PATH = REPO_ROOT / "openclaw_assistant" / "config.yaml"
CHANGELOG_PATH = REPO_ROOT / "openclaw_assistant" / "CHANGELOG.md"
VERSION_RE = re.compile(r'^(version:\s*")([^"]+)(")$', re.MULTILINE)
SUFFIX_RE = re.compile(r"^(?P<prefix>.+-welizard\.)(?P<build>\d+)$")


def read_text(path: pathlib.Path) -> str:
    return path.read_text(encoding="utf-8")


def write_text(path: pathlib.Path, content: str) -> None:
    path.write_text(content, encoding="utf-8", newline="\n")


def extract_version(config_text: str) -> str:
    match = VERSION_RE.search(config_text)
    if not match:
        raise ValueError(f"Could not find version in {CONFIG_PATH}")
    return match.group(2)


def bump_version(version: str) -> str:
    match = SUFFIX_RE.match(version)
    if not match:
        raise ValueError(
            "Expected version format '<base>-welizard.<n>', "
            f"got {version!r}",
        )
    build = int(match.group("build")) + 1
    return f"{match.group('prefix')}{build}"


def update_config_version(config_text: str, new_version: str) -> str:
    return VERSION_RE.sub(
        lambda match: f'{match.group(1)}{new_version}{match.group(3)}',
        config_text,
        count=1,
    )


def prepend_changelog_entry(changelog_text: str, version: str, date_str: str) -> str:
    heading = f"## [{version}] - {date_str}"
    if heading in changelog_text:
        return changelog_text
    marker = "All notable changes to the OpenClaw Assistant Home Assistant Add-on will be documented in this file.\n"
    if marker not in changelog_text:
        raise ValueError(f"Could not find changelog insertion marker in {CHANGELOG_PATH}")
    entry = (
        f"\n{heading}\n\n"
        "### Changed\n"
        "- TODO: describe the user-visible change.\n"
    )
    return changelog_text.replace(marker, marker + entry, 1)


def main() -> int:
    parser = argparse.ArgumentParser(description="Bump Home Assistant add-on version and changelog.")
    parser.add_argument("--version", help="Set an explicit add-on version instead of incrementing.")
    args = parser.parse_args()

    config_text = read_text(CONFIG_PATH)
    current_version = extract_version(config_text)
    new_version = args.version or bump_version(current_version)
    if new_version == current_version:
        print(f"Version already set to {new_version}", file=sys.stderr)
        return 1

    updated_config = update_config_version(config_text, new_version)
    updated_changelog = prepend_changelog_entry(
        read_text(CHANGELOG_PATH),
        new_version,
        dt.date.today().isoformat(),
    )

    write_text(CONFIG_PATH, updated_config)
    write_text(CHANGELOG_PATH, updated_changelog)
    print(new_version)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
