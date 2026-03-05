#!/usr/bin/env python3
from __future__ import annotations

import pathlib
import re
import subprocess
import sys


REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
CONFIG_REL = "openclaw_assistant/config.yaml"
CHANGELOG_REL = "openclaw_assistant/CHANGELOG.md"
METADATA_FILES = {CONFIG_REL, CHANGELOG_REL}
VERSION_RE = re.compile(r'^version:\s*"([^"]+)"$', re.MULTILINE)


def git(*args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=True,
    )
    return result.stdout


def changed_files(base: str, head: str) -> set[str]:
    output = git("diff", "--name-only", f"{base}..{head}")
    return {line.strip() for line in output.splitlines() if line.strip()}


def read_version_from_ref(ref: str) -> str:
    content = git("show", f"{ref}:{CONFIG_REL}")
    match = VERSION_RE.search(content)
    if not match:
        raise ValueError(f"Could not parse version from {CONFIG_REL} at {ref}")
    return match.group(1)


def changelog_has_version(version: str) -> bool:
    changelog = (REPO_ROOT / CHANGELOG_REL).read_text(encoding="utf-8")
    return f"## [{version}]" in changelog


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: check_release_metadata.py <base-sha> <head-sha>", file=sys.stderr)
        return 2

    base, head = sys.argv[1], sys.argv[2]
    files = changed_files(base, head)
    addon_changes = {path for path in files if path.startswith("openclaw_assistant/")}
    substantive_changes = addon_changes - METADATA_FILES
    if not substantive_changes:
        print("No substantive add-on changes detected.")
        return 0

    missing = [path for path in sorted(METADATA_FILES) if path not in files]
    if missing:
        print(
            "Add-on files changed without release metadata update. Missing changes in: "
            + ", ".join(missing),
            file=sys.stderr,
        )
        return 1

    base_version = read_version_from_ref(base)
    head_version = read_version_from_ref(head)
    if base_version == head_version:
        print(
            f"Add-on files changed but version stayed at {head_version}. "
            "Bump openclaw_assistant/config.yaml.",
            file=sys.stderr,
        )
        return 1

    if not changelog_has_version(head_version):
        print(
            f"CHANGELOG is missing an entry for version {head_version}.",
            file=sys.stderr,
        )
        return 1

    print(
        f"Release metadata looks valid: {base_version} -> {head_version}.",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
