"""Verified local input views for v2 timeseries binding backups.

The packed representation is transport authority only.  Callers provide the
authoritative SOS-light timeseries IDs and continue to apply the established
binding JSON semantics to the returned individual-file-shaped view.
"""

from __future__ import annotations

import base64
import binascii
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import tempfile
from typing import Any, Iterator, Mapping


BINDING_PREFIX = "history/_index_v2/timeseries_binding"
PACK_PREFIX = "history/_backup_packs_v1/timeseries_binding"
PACK_ROOT_PATH = f"{PACK_PREFIX}/root.json"
STATE_ROOT_PREFIX = "_ops/checkpoints/r2_history_backup_state_v2"
STATE_ROOT_PATH = f"{STATE_ROOT_PREFIX}/root.json"
RANGE_SIZE = 1_000

PACK_ROOT_KIND = "uk_aq_r2_history_timeseries_binding_backup_pack_root"
PACK_KIND = "uk_aq_r2_history_timeseries_binding_backup_pack"
STATE_ROOT_KIND = "uk_aq_r2_history_backup_state_v2_root"
PACK_STATE_ROOT_KIND = (
    "uk_aq_r2_history_backup_state_timeseries_binding_packs_root"
)
PACK_RANGE_STATE_KIND = (
    "uk_aq_r2_history_backup_state_timeseries_binding_pack_range"
)

_SHA256_RE = re.compile(r"[a-f0-9]{64}")
_BINDING_PATH_RE = re.compile(
    rf"{re.escape(BINDING_PREFIX)}/timeseries_id=([1-9]\d*)\.json"
)


class PackedBindingError(ValueError):
    """Packed binding evidence is missing, malformed, or contradictory."""


def _reject_duplicate_object_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise PackedBindingError(f"duplicate JSON object key: {key}")
        result[key] = value
    return result


def _read_json_bytes(path: Path, label: str) -> tuple[bytes, Mapping[str, Any]]:
    try:
        body = path.read_bytes()
    except OSError as exc:
        raise PackedBindingError(f"{label} is unavailable: {path}: {exc}") from exc
    try:
        value = json.loads(
            body.decode("utf-8"),
            object_pairs_hook=_reject_duplicate_object_keys,
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PackedBindingError(f"{label} is not valid UTF-8 JSON: {path}") from exc
    if not isinstance(value, Mapping):
        raise PackedBindingError(f"{label} must be a JSON object: {path}")
    return body, value


def _sha256(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def _require_sha256(value: Any, label: str) -> str:
    if not isinstance(value, str) or _SHA256_RE.fullmatch(value) is None:
        raise PackedBindingError(f"{label} must be lowercase SHA-256 hex")
    return value


def _require_int(value: Any, label: str, *, positive: bool = False) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise PackedBindingError(f"{label} must be an integer")
    if value < (1 if positive else 0):
        qualifier = "positive" if positive else "non-negative"
        raise PackedBindingError(f"{label} must be {qualifier}")
    return value


def _require_text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise PackedBindingError(f"{label} must be non-empty text")
    return value.strip()


def _relative_path(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise PackedBindingError(f"{label} must be a normalized relative path")
    if value.startswith("/") or "\\" in value or "\x00" in value:
        raise PackedBindingError(f"{label} must be a safe POSIX relative path")
    pure = PurePosixPath(value)
    if pure.is_absolute() or any(part in {"", ".", ".."} for part in pure.parts):
        raise PackedBindingError(f"{label} contains traversal or invalid segments")
    if pure.as_posix() != value:
        raise PackedBindingError(f"{label} is not normalized")
    return value


def _range_bounds(raw: Mapping[str, Any], label: str) -> tuple[int, int]:
    start = _require_int(raw.get("range_start"), f"{label} range_start")
    end = _require_int(raw.get("range_end"), f"{label} range_end")
    if start % RANGE_SIZE != 0 or end != start + RANGE_SIZE - 1:
        raise PackedBindingError(f"{label} has invalid range {start}-{end}")
    return start, end


def _range_key(start: int, end: int) -> str:
    return f"range={start:06d}-{end:06d}"


def _safe_local_file(root: Path, relative_path: str, label: str) -> Path:
    root_resolved = root.resolve(strict=True)
    candidate = root / relative_path
    try:
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(root_resolved)
    except (FileNotFoundError, OSError, RuntimeError, ValueError) as exc:
        raise PackedBindingError(
            f"{label} is missing or escapes the packed Dropbox root: {relative_path}"
        ) from exc
    if not resolved.is_file():
        raise PackedBindingError(f"{label} is not a file: {relative_path}")
    return resolved


def _validate_root(root: Mapping[str, Any]) -> dict[str, Any]:
    if (
        root.get("schema_version") != 1
        or root.get("kind") != PACK_ROOT_KIND
        or root.get("backup_pack_version") != "v1"
        or root.get("range_size") != RANGE_SIZE
    ):
        raise PackedBindingError("packed binding root identity mismatch")
    source_prefix = _relative_path(root.get("source_prefix"), "source_prefix")
    if source_prefix != BINDING_PREFIX:
        raise PackedBindingError("packed binding root source_prefix mismatch")
    source_root_key = _relative_path(root.get("source_root_key"), "source_root_key")
    if source_root_key != f"{source_prefix}/_manifests/root.json":
        raise PackedBindingError("packed binding root source_root_key mismatch")
    source_root_hash = _require_sha256(root.get("source_root_hash"), "source_root_hash")
    raw_ranges = root.get("ranges")
    if not isinstance(raw_ranges, list):
        raise PackedBindingError("packed binding root ranges must be an array")
    ranges: list[dict[str, Any]] = []
    seen_starts: set[int] = set()
    for index, raw_range in enumerate(raw_ranges):
        if not isinstance(raw_range, Mapping):
            raise PackedBindingError(f"packed binding root range {index} must be an object")
        start, end = _range_bounds(raw_range, f"root range {index}")
        if start in seen_starts:
            raise PackedBindingError(f"duplicate occupied range reference: {start}")
        seen_starts.add(start)
        source_range_hash = _require_sha256(
            raw_range.get("source_range_hash"), f"range {start} source_range_hash"
        )
        pack_path = _relative_path(
            raw_range.get("pack_relative_path"), f"range {start} pack_relative_path"
        )
        expected_path = (
            f"{PACK_PREFIX}/{_range_key(start, end)}/{source_range_hash}.pack.json"
        )
        if pack_path != expected_path:
            raise PackedBindingError(f"range {start} pack_relative_path mismatch")
        ranges.append({
            "range_start": start,
            "range_end": end,
            "source_range_hash": source_range_hash,
            "pack_relative_path": pack_path,
            "pack_sha256": _require_sha256(
                raw_range.get("pack_sha256"), f"range {start} pack_sha256"
            ),
            "pack_size": _require_int(
                raw_range.get("pack_size"), f"range {start} pack_size", positive=True
            ),
            "member_count": _require_int(
                raw_range.get("member_count"),
                f"range {start} member_count",
                positive=True,
            ),
        })
    ranges.sort(key=lambda item: item["range_start"])
    range_count = _require_int(root.get("range_count"), "root range_count")
    member_count = _require_int(root.get("member_count"), "root member_count")
    if range_count != len(ranges):
        raise PackedBindingError("packed binding root range_count mismatch")
    if member_count != sum(item["member_count"] for item in ranges):
        raise PackedBindingError("packed binding root member_count mismatch")
    return {
        "source_prefix": source_prefix,
        "source_root_hash": source_root_hash,
        "range_count": range_count,
        "member_count": member_count,
        "ranges": ranges,
    }


def _validate_checkpoint_state(
    *,
    pack_root: Path,
    state_root: Mapping[str, Any],
    root_info: Mapping[str, Any],
    root_body: bytes,
) -> None:
    if (
        state_root.get("schema_version") != 1
        or state_root.get("kind") != STATE_ROOT_KIND
        or state_root.get("backup_version") != "v2"
    ):
        raise PackedBindingError("hierarchical checkpoint state root identity mismatch")
    pack_state = state_root.get("timeseries_binding_packs")
    if not isinstance(pack_state, Mapping):
        raise PackedBindingError("checkpoint state root is missing timeseries_binding_packs")
    if (
        pack_state.get("schema_version") != 1
        or pack_state.get("kind") != PACK_STATE_ROOT_KIND
        or pack_state.get("backup_pack_version") != "v1"
        or pack_state.get("verified") is not True
    ):
        raise PackedBindingError("packed binding checkpoint root is incomplete or invalid")
    if (
        _require_sha256(
            pack_state.get("processed_source_root_hash"),
            "checkpoint processed_source_root_hash",
        )
        != root_info["source_root_hash"]
    ):
        raise PackedBindingError("packed root/checkpoint source identity mismatch")
    if (
        _require_sha256(
            pack_state.get("processed_pack_root_sha256"),
            "checkpoint processed_pack_root_sha256",
        )
        != _sha256(root_body)
    ):
        raise PackedBindingError("packed root/checkpoint pack-root SHA-256 mismatch")
    if _relative_path(
        pack_state.get("pack_root_relative_path"),
        "checkpoint pack_root_relative_path",
    ) != PACK_ROOT_PATH:
        raise PackedBindingError("checkpoint pack root path mismatch")
    if _require_int(
        pack_state.get("pack_root_size"), "checkpoint pack_root_size", positive=True
    ) != len(root_body):
        raise PackedBindingError("checkpoint pack root size mismatch")
    _require_text(pack_state.get("copied_at"), "checkpoint copied_at")

    state_ranges = pack_state.get("ranges")
    if not isinstance(state_ranges, list):
        raise PackedBindingError("checkpoint pack ranges must be an array")
    by_start: dict[int, Mapping[str, Any]] = {}
    for index, raw in enumerate(state_ranges):
        if not isinstance(raw, Mapping):
            raise PackedBindingError(f"checkpoint range {index} must be an object")
        start, end = _range_bounds(raw, f"checkpoint range {index}")
        if start in by_start:
            raise PackedBindingError(f"duplicate checkpoint range {start}")
        by_start[start] = raw
        expected_shard = (
            f"{STATE_ROOT_PREFIX}/timeseries_binding_packs/{_range_key(start, end)}.json"
        )
        if _relative_path(raw.get("state_shard_key"), "state_shard_key") != expected_shard:
            raise PackedBindingError(f"checkpoint range {start} state shard path mismatch")
    root_ranges = list(root_info["ranges"])
    if set(by_start) != {item["range_start"] for item in root_ranges}:
        raise PackedBindingError("checkpoint/root occupied range set mismatch")

    for reference in root_ranges:
        start = reference["range_start"]
        raw = by_start[start]
        for state_key, reference_key in (
            ("range_end", "range_end"),
            ("processed_source_range_hash", "source_range_hash"),
            ("pack_relative_path", "pack_relative_path"),
            ("pack_sha256", "pack_sha256"),
            ("pack_size", "pack_size"),
            ("member_count", "member_count"),
        ):
            if raw.get(state_key) != reference[reference_key]:
                raise PackedBindingError(
                    f"checkpoint root range {start} {state_key} mismatch"
                )
        shard_hash = _require_sha256(
            raw.get("state_shard_hash"), f"checkpoint range {start} shard hash"
        )
        shard_path = _safe_local_file(
            pack_root,
            str(raw["state_shard_key"]),
            f"checkpoint range {start} shard",
        )
        shard_body, shard = _read_json_bytes(shard_path, f"checkpoint range {start} shard")
        if _sha256(shard_body) != shard_hash:
            raise PackedBindingError(f"checkpoint range {start} shard SHA-256 mismatch")
        shard_start, shard_end = _range_bounds(shard, f"checkpoint range {start} shard")
        if (
            shard.get("schema_version") != 1
            or shard.get("kind") != PACK_RANGE_STATE_KIND
            or shard.get("backup_pack_version") != "v1"
            or shard.get("range_size") != RANGE_SIZE
            or shard_start != start
            or shard_end != reference["range_end"]
            or shard.get("verified") is not True
        ):
            raise PackedBindingError(f"checkpoint range {start} shard identity mismatch")
        _require_text(shard.get("copied_at"), f"checkpoint range {start} copied_at")
        for shard_key, reference_key in (
            ("processed_source_range_hash", "source_range_hash"),
            ("pack_relative_path", "pack_relative_path"),
            ("pack_sha256", "pack_sha256"),
            ("pack_size", "pack_size"),
            ("member_count", "member_count"),
        ):
            if shard.get(shard_key) != reference[reference_key]:
                raise PackedBindingError(
                    f"checkpoint range {start} shard {shard_key} mismatch"
                )


def verify_packed_binding_generation(
    pack_root: Path,
    required_timeseries_ids: set[int],
) -> tuple[dict[int, bytes], dict[str, Any]]:
    """Verify every packed range and retain only required member bytes."""
    try:
        resolved_root = Path(pack_root).resolve(strict=True)
    except (FileNotFoundError, OSError, RuntimeError) as exc:
        raise PackedBindingError(f"packed binding root is unavailable: {pack_root}") from exc
    if not resolved_root.is_dir():
        raise PackedBindingError(f"packed binding root is not a directory: {pack_root}")
    required = {int(value) for value in required_timeseries_ids}
    if any(value <= 0 for value in required):
        raise PackedBindingError("required timeseries IDs must be positive integers")

    root_path = _safe_local_file(resolved_root, PACK_ROOT_PATH, "packed binding root")
    root_body, root = _read_json_bytes(root_path, "packed binding root")
    root_info = _validate_root(root)
    state_path = _safe_local_file(resolved_root, STATE_ROOT_PATH, "checkpoint state root")
    _, state_root = _read_json_bytes(state_path, "checkpoint state root")
    _validate_checkpoint_state(
        pack_root=resolved_root,
        state_root=state_root,
        root_info=root_info,
        root_body=root_body,
    )

    selected: dict[int, bytes] = {}
    seen_ids: set[int] = set()
    seen_paths: set[str] = set()
    total_pack_bytes = 0
    total_members = 0
    for reference in root_info["ranges"]:
        start = reference["range_start"]
        end = reference["range_end"]
        pack_path = _safe_local_file(
            resolved_root,
            reference["pack_relative_path"],
            f"binding pack {start}-{end}",
        )
        pack_body, pack = _read_json_bytes(pack_path, f"binding pack {start}-{end}")
        if len(pack_body) != reference["pack_size"]:
            raise PackedBindingError(f"binding pack {start}-{end} byte size mismatch")
        if _sha256(pack_body) != reference["pack_sha256"]:
            raise PackedBindingError(f"binding pack {start}-{end} SHA-256 mismatch")
        if (
            pack.get("schema_version") != 1
            or pack.get("kind") != PACK_KIND
            or pack.get("backup_pack_version") != "v1"
            or pack.get("range_size") != RANGE_SIZE
            or pack.get("range_start") != start
            or pack.get("range_end") != end
            or pack.get("source_prefix") != BINDING_PREFIX
            or pack.get("source_range_hash") != reference["source_range_hash"]
        ):
            raise PackedBindingError(f"binding pack {start}-{end} identity mismatch")
        members = pack.get("members")
        if not isinstance(members, list):
            raise PackedBindingError(f"binding pack {start}-{end} members must be an array")
        member_count = _require_int(
            pack.get("member_count"), f"binding pack {start}-{end} member_count", positive=True
        )
        if member_count != len(members) or member_count != reference["member_count"]:
            raise PackedBindingError(f"binding pack {start}-{end} member count mismatch")
        previous_id = 0
        for member_index, member in enumerate(members):
            if not isinstance(member, Mapping):
                raise PackedBindingError(
                    f"binding pack {start}-{end} member {member_index} must be an object"
                )
            timeseries_id = _require_int(
                member.get("timeseries_id"), "pack member timeseries_id", positive=True
            )
            if timeseries_id in seen_ids:
                raise PackedBindingError(
                    f"duplicate packed binding member: {timeseries_id}"
                )
            if timeseries_id <= previous_id:
                raise PackedBindingError(
                    f"binding pack {start}-{end} members are not strictly sorted"
                )
            previous_id = timeseries_id
            if not start <= timeseries_id <= end:
                raise PackedBindingError(
                    f"timeseries_id {timeseries_id} is outside pack range {start}-{end}"
                )
            relative_path = _relative_path(
                member.get("relative_path"), f"member {timeseries_id} path"
            )
            match = _BINDING_PATH_RE.fullmatch(relative_path)
            if match is None or int(match.group(1)) != timeseries_id:
                raise PackedBindingError(
                    f"member {timeseries_id} path is outside the exact binding namespace"
                )
            if relative_path in seen_paths:
                raise PackedBindingError(f"duplicate packed binding member: {timeseries_id}")
            seen_ids.add(timeseries_id)
            seen_paths.add(relative_path)
            member_size = _require_int(member.get("size"), "pack member size")
            member_sha256 = _require_sha256(member.get("sha256"), "pack member SHA-256")
            encoded = member.get("body_base64")
            if not isinstance(encoded, str):
                raise PackedBindingError(f"member {timeseries_id} body_base64 must be text")
            try:
                decoded = base64.b64decode(encoded, validate=True)
            except (binascii.Error, ValueError) as exc:
                raise PackedBindingError(
                    f"member {timeseries_id} body_base64 is invalid"
                ) from exc
            if base64.b64encode(decoded).decode("ascii") != encoded:
                raise PackedBindingError(
                    f"member {timeseries_id} body_base64 is not canonical"
                )
            if len(decoded) != member_size:
                raise PackedBindingError(f"member {timeseries_id} decoded size mismatch")
            if _sha256(decoded) != member_sha256:
                raise PackedBindingError(f"member {timeseries_id} decoded SHA-256 mismatch")
            if timeseries_id in required:
                selected[timeseries_id] = decoded
            total_members += 1
        total_pack_bytes += len(pack_body)
    if total_members != root_info["member_count"]:
        raise PackedBindingError("globally verified pack member total mismatch")
    missing = sorted(required - set(selected))
    if missing:
        sample = ",".join(str(value) for value in missing[:20])
        raise PackedBindingError(f"required SOS binding members are missing: {sample}")
    audit = {
        "mode": "pack",
        "pack_root": str(resolved_root),
        "pack_root_relative_path": PACK_ROOT_PATH,
        "pack_root_sha256": _sha256(root_body),
        "pack_root_size": len(root_body),
        "source_root_hash": root_info["source_root_hash"],
        "checkpoint_source_root_hash": root_info["source_root_hash"],
        "ranges_verified": root_info["range_count"],
        "total_pack_bytes_verified": total_pack_bytes,
        "total_pack_members_verified": total_members,
        "sos_bindings_selected": len(required),
        "sos_bindings_materialised": 0,
        "non_sos_bindings_materialised": 0,
        "temporary_path": None,
        "cleanup_outcome": "not_started",
    }
    return selected, audit


@contextmanager
def binding_backup_view(
    *,
    mode: str,
    individual_root: Path,
    pack_root: Path | None,
    required_timeseries_ids: set[int],
) -> Iterator[tuple[Path, dict[str, Any]]]:
    """Yield an individual-file-shaped binding view and mutable audit data."""
    if mode == "individual":
        yield Path(individual_root), {
            "mode": "individual",
            "individual_root": str(Path(individual_root)),
            "sos_bindings_selected": len(required_timeseries_ids),
            "temporary_path": None,
            "cleanup_outcome": "not_applicable",
        }
        return
    if mode != "pack":
        raise PackedBindingError(f"unsupported timeseries binding backup mode: {mode}")
    if pack_root is None:
        raise PackedBindingError("pack mode requires a packed binding root")

    selected, audit = verify_packed_binding_generation(
        Path(pack_root), required_timeseries_ids
    )
    temporary = tempfile.TemporaryDirectory(prefix="uk-aq-sos-binding-view-")
    view_root = Path(temporary.name)
    for protected_root in (Path(individual_root), Path(pack_root)):
        try:
            view_root.resolve().relative_to(protected_root.resolve(strict=True))
        except (FileNotFoundError, OSError, RuntimeError, ValueError):
            continue
        temporary.cleanup()
        raise PackedBindingError(
            "temporary packed binding view resolved inside a Dropbox backup root"
        )
    audit["temporary_path"] = str(view_root)
    try:
        for timeseries_id, body in sorted(selected.items()):
            relative_path = (
                f"{BINDING_PREFIX}/timeseries_id={timeseries_id}.json"
            )
            target = view_root / relative_path
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as handle:
                handle.write(body)
            if target.read_bytes() != body:
                raise PackedBindingError(
                    f"materialised binding byte verification failed: {timeseries_id}"
                )
        audit["sos_bindings_materialised"] = len(selected)
        audit["cleanup_outcome"] = "pending"
        yield view_root, audit
    finally:
        temporary.cleanup()
        audit["cleanup_outcome"] = (
            "removed" if not view_root.exists() else "failed"
        )
        if view_root.exists():
            raise PackedBindingError(
                f"temporary packed binding view cleanup failed: {view_root}"
            )
