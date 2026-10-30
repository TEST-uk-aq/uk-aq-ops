#!/usr/bin/env python3
"""Remove restrictive robots directives from active public website HTML."""

import argparse
from html import escape
from html.parser import HTMLParser
import os
from pathlib import Path
import re
import sys

BLOCKED_DIRECTIVES = {"noindex", "nofollow", "none"}
EXCLUDED_DIRS = {".git", ".pages-site", "node_modules", "logs", "archive"}
CONTENT_ATTRIBUTE = re.compile(r"""(?<![\w:-])content\s*=\s*(["'])(.*?)\1""", re.I | re.S)
BLOCKED_WORD = re.compile(r"\b(?:noindex|nofollow|none)\b", re.I)


class RobotsParser(HTMLParser):
    def __init__(self, source: str, relative_path: str):
        super().__init__(convert_charrefs=True)
        self.source = source
        self.relative_path = relative_path
        self.line_offsets = [0]
        self.line_offsets.extend(match.end() for match in re.finditer("\n", source))
        self.replacements: list[tuple[int, int, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "meta":
            return
        attributes = dict(attrs)
        name = (attributes.get("name") or "").casefold()
        http_equiv = (attributes.get("http-equiv") or "").casefold()
        if not (
            name == "robots"
            or "bot" in name
            or name in {"slurp", "baiduspider", "yandex"}
            or http_equiv == "x-robots-tag"
        ):
            return

        content = attributes.get("content") or ""
        directives = [item.strip() for item in content.split(",")]
        remaining = [item for item in directives if item.casefold() not in BLOCKED_DIRECTIVES]
        if len(remaining) == len(directives):
            if BLOCKED_WORD.search(content):
                raise ValueError(
                    f"{self.relative_path}: unsupported robots directives: {content!r}"
                )
            return
        if any(BLOCKED_WORD.search(item) for item in remaining):
            raise ValueError(
                f"{self.relative_path}: ambiguous robots directives: {content!r}"
            )

        raw_tag = self.get_starttag_text()
        line, column = self.getpos()
        start = self.line_offsets[line - 1] + column
        end = start + len(raw_tag)
        if remaining:
            match = CONTENT_ATTRIBUTE.search(raw_tag)
            if not match:
                raise ValueError(
                    f"{self.relative_path}: unsupported robots content attribute"
                )
            rewritten = (
                raw_tag[: match.start(2)]
                + escape(", ".join(remaining), quote=True)
                + raw_tag[match.end(2) :]
            )
        else:
            rewritten = ""
            # Remove the entire line if this is its only HTML content.
            line_start = self.source.rfind("\n", 0, start) + 1
            line_end = self.source.find("\n", end)
            if line_end < 0:
                line_end = len(self.source)
            if (
                not self.source[line_start:start].strip()
                and not self.source[end:line_end].strip()
            ):
                start = line_start
                end = line_end + (line_end < len(self.source))
        self.replacements.append((start, end, rewritten))

    def rewritten_html(self) -> str:
        self.feed(self.source)
        self.close()
        output = self.source
        for start, end, rewritten in reversed(self.replacements):
            output = output[:start] + rewritten + output[end:]
        return output


def active_html(root: Path):
    for base, directories, files in os.walk(root, followlinks=False):
        directories[:] = sorted(
            directory for directory in directories
            if directory.casefold() not in EXCLUDED_DIRS
        )
        for filename in sorted(files):
            if Path(filename).suffix.lower() not in {".html", ".htm"}:
                continue
            path = Path(base) / filename
            if path.is_symlink():
                raise ValueError(f"Refusing symlinked HTML file: {path}")
            yield path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path, help="Website checkout root")
    parser.add_argument("--apply", action="store_true", help="Write stripped HTML to the specified root")
    args = parser.parse_args()
    root = args.root
    if not root.is_dir() or root.is_symlink():
        raise ValueError(f"Website root must be a real directory: {root}")

    updates: list[tuple[Path, str, int]] = []
    inspected = 0
    for path in active_html(root):
        inspected += 1
        source = path.read_text(encoding="utf-8")
        relative = path.relative_to(root).as_posix()
        transformer = RobotsParser(source, relative)
        rewritten = transformer.rewritten_html()
        if rewritten != source:
            updates.append((path, rewritten, len(transformer.replacements)))

    # Parse every active HTML page before writing anything.
    label = "removed" if args.apply else "would remove"
    for path, _, count in updates:
        print(f" >robots... {label} {count} restricted meta tag(s): {path.relative_to(root)}")
    if args.apply:
        for path, rewritten, _ in updates:
            path.write_text(rewritten, encoding="utf-8")
    print(
        f" Public LIVE robots transform: {inspected} active HTML page(s) inspected; "
        f"{len(updates)} page(s) {'updated' if args.apply else 'would be updated'}."
    )
    print(" Archived HTML snapshots were left unchanged.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, UnicodeError, ValueError) as error:
        print(f"ERROR: public LIVE robots transform failed: {error}", file=sys.stderr)
        sys.exit(1)
