"""Native-R boundary for WAQN/SAQN historical OpenAir workspaces.

The downloaded RData bytes remain the authoritative source evidence.  This
module uses base R's ``load()`` only to expose the narrow tabular boundary the
Integrity coordinator needs; it deliberately has no pyreadr dependency.
"""

from __future__ import annotations

import csv
import datetime as dt
from dataclasses import dataclass
import hashlib
import io
import math
from pathlib import Path
import shutil
import subprocess
from typing import Any, Iterable, Mapping
import urllib.error
import urllib.parse
import urllib.request


@dataclass(frozen=True)
class OfficialNetworkRDataConfig:
    source_key: str
    connector_code: str
    connector_id: int
    base_url: str
    metadata_filename: str
    metadata_object: str
    accepted_hosts: tuple[str, ...]


class AuthoritativeSourceArtifactAbsent(RuntimeError):
    """A canonical provider object ended in an authenticated HTTP 404."""

    def __init__(
        self,
        *,
        canonical_url: str,
        final_url: str,
        requested_at_utc: str,
    ) -> None:
        super().__init__(f"canonical provider object returned HTTP 404: {final_url}")
        self.canonical_url = canonical_url
        self.final_url = final_url
        self.http_status = 404
        self.requested_at_utc = requested_at_utc


NETWORKS: dict[str, OfficialNetworkRDataConfig] = {
    "waqn": OfficialNetworkRDataConfig(
        source_key="waqn",
        connector_code="waqn",
        connector_id=9,
        base_url="https://airquality.gov.wales/sites/default/files/openair/R_data/",
        metadata_filename="WAQ_metadata.RData",
        metadata_object="metadata",
        accepted_hosts=("airquality.gov.wales", "www.airquality.gov.wales"),
    ),
    "saqn": OfficialNetworkRDataConfig(
        source_key="saqn",
        connector_code="saqn",
        connector_id=10,
        base_url="https://www.scottishairquality.scot/openair/R_data/",
        metadata_filename="SCOT_metadata.RData",
        metadata_object="meta",
        accepted_hosts=(
            "scottishairquality.scot",
            "www.scottishairquality.scot",
        ),
    ),
}


RDATA_COLUMN_TO_POLLUTANT = {
    "PM2.5": "pm25",
    "PM10": "pm10",
    "NO2": "no2",
    "O3": "o3",
}
POLLUTANT_TO_METADATA_PARAMETER = {
    "pm25": "PM2.5",
    "pm10": "PM10",
    "no2": "NO2",
    "o3": "O3",
}

COVERAGE_REQUIRED = "required"
COVERAGE_AUTHORITATIVE_NO_COVERAGE = "authoritative_no_coverage"
COVERAGE_INDETERMINATE = "indeterminate"
TIMESTAMP_MAPPING = "rdata_posixct_gmt_instant_to_observed_at_utc"


_R_EXTRACT_SCRIPT = r'''
args <- commandArgs(trailingOnly=TRUE)
if (length(args) != 3L) stop("expected mode, path and object name")
mode <- args[[1L]]
path <- args[[2L]]
object_name <- args[[3L]]
workspace <- new.env(parent=emptyenv())
loaded <- load(path, envir=workspace)
if (!(object_name %in% loaded)) stop(paste("required object missing:", object_name))
value <- workspace[[object_name]]
if (!is.data.frame(value)) stop(paste("required object is not a data.frame:", object_name))

if (identical(mode, "site_year")) {
  if (!("date" %in% names(value))) stop("site-year object has no date column")
  if (!inherits(value$date, "POSIXct")) stop("site-year date is not POSIXct")
  if (!identical(attr(value$date, "tzone"), "GMT")) {
    stop("site-year date timezone is not explicitly GMT")
  }
  keep <- intersect(c("date", "PM2.5", "PM10", "NO2", "O3"), names(value))
  value <- value[, keep, drop=FALSE]
  parsed <- as.POSIXct(value$date, tz="UTC")
  if (any(is.na(parsed))) stop("site-year object has an invalid date value")
  value$date <- format(parsed, "%Y-%m-%dT%H:%M:%SZ", tz="UTC", usetz=FALSE)
} else if (identical(mode, "metadata")) {
  required <- c("site_id", "parameter", "start_date", "end_date", "ratified_to")
  if (!all(required %in% names(value))) stop("metadata object lacks required columns")
  value <- value[, required, drop=FALSE]
  value$site_id <- as.character(value$site_id)
  value$parameter <- as.character(value$parameter)
  value$start_date <- as.character(value$start_date)
  value$end_date <- as.character(value$end_date)
  value$ratified_to <- as.character(value$ratified_to)
} else {
  stop(paste("unsupported extraction mode:", mode))
}

write.table(
  value,
  file=stdout(),
  sep="\t",
  quote=TRUE,
  row.names=FALSE,
  col.names=TRUE,
  na="",
  qmethod="double",
  fileEncoding="UTF-8"
)
'''


def resolve_rscript() -> str:
    """Resolve native R from PATH and fail with an operator-facing message."""
    executable = shutil.which("Rscript")
    if not executable:
        raise RuntimeError(
            "Rscript is required to decode WAQN/SAQN RData and was not found on PATH"
        )
    return executable


def rscript_identity() -> dict[str, str]:
    """Return the PATH-resolved executable and its native version string."""
    executable = resolve_rscript()
    process = subprocess.run(
        [executable, "--version"],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if process.returncode != 0:
        raise RuntimeError(
            "Rscript was found on PATH but its version could not be determined"
        )
    version = " ".join((process.stdout or process.stderr or "").split())
    if not version:
        raise RuntimeError("Rscript returned an empty version string")
    return {"executable": executable, "version": version}


def _extract_tsv(
    path: Path,
    *,
    mode: str,
    object_name: str,
    required_columns: Iterable[str] = (),
) -> list[dict[str, str]]:
    process = subprocess.run(
        [resolve_rscript(), "--vanilla", "-", mode, str(path), object_name],
        input=_R_EXTRACT_SCRIPT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if process.returncode != 0:
        detail = " ".join((process.stderr or process.stdout or "").split())
        raise RuntimeError(
            f"RData extraction failed for {path.name} object={object_name}: {detail[:1200]}"
        )
    reader = csv.DictReader(io.StringIO(process.stdout), delimiter="\t")
    if not reader.fieldnames:
        raise RuntimeError(f"RData extraction returned no columns for {path.name}")
    missing = sorted(set(required_columns) - set(reader.fieldnames))
    if missing:
        raise RuntimeError(
            f"RData object {object_name} lacks selected columns: {missing}"
        )
    return [
        {str(key): str(value or "") for key, value in row.items()}
        for row in reader
    ]


def extract_site_year(
    path: Path,
    *,
    site_code: str,
    year: int,
    selected_pollutants: Iterable[str] = (),
) -> list[dict[str, str]]:
    selected = set(selected_pollutants)
    unknown = selected - set(POLLUTANT_TO_METADATA_PARAMETER)
    if unknown:
        raise ValueError(f"unsupported selected RData pollutants: {sorted(unknown)}")
    return _extract_tsv(
        path,
        mode="site_year",
        object_name=f"{site_code}_{int(year)}",
        required_columns=(
            "date", *(POLLUTANT_TO_METADATA_PARAMETER[code] for code in sorted(selected))
        ),
    )


def extract_metadata(
    path: Path,
    *,
    config: OfficialNetworkRDataConfig,
) -> list[dict[str, str]]:
    return _extract_tsv(
        path,
        mode="metadata",
        object_name=config.metadata_object,
    )


def canonical_observed_at(raw_timestamp: str) -> dt.datetime:
    """Preserve the instant emitted from an explicitly GMT POSIXct RData date."""
    parsed = dt.datetime.fromisoformat(raw_timestamp.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("RData timestamp lacks an authenticated timezone")
    observed = parsed.astimezone(dt.timezone.utc)
    if observed.minute or observed.second or observed.microsecond:
        raise ValueError("RData timestamp is not an exact canonical hour")
    return observed


def required_site_years(days: Iterable[dt.date]) -> list[int]:
    """Select only source calendar years containing the requested UTC days."""
    return sorted({day.year for day in days})


def source_time_windows_for_year(
    days: Iterable[dt.date],
    source_year: int,
) -> list[dict[str, str]]:
    """Return source UTC windows for canonical UTC days, clipped to the file year."""
    year_start = dt.datetime(
        int(source_year), 1, 1, tzinfo=dt.timezone.utc,
    )
    year_end = dt.datetime(
        int(source_year) + 1, 1, 1, tzinfo=dt.timezone.utc,
    )
    windows: list[dict[str, str]] = []
    for day in sorted(set(days)):
        canonical_start = dt.datetime.combine(
            day, dt.time.min, tzinfo=dt.timezone.utc,
        )
        raw_start = canonical_start
        raw_end = canonical_start + dt.timedelta(days=1)
        clipped_start = max(raw_start, year_start)
        clipped_end = min(raw_end, year_end)
        if clipped_start >= clipped_end:
            continue
        windows.append({
            "canonical_day_utc": day.isoformat(),
            "raw_start_utc": clipped_start.isoformat().replace("+00:00", "Z"),
            "raw_end_exclusive_utc": clipped_end.isoformat().replace(
                "+00:00", "Z",
            ),
        })
    return windows


def canonical_unavailable_windows(
    raw_source_windows: Iterable[Mapping[str, Any]],
) -> list[dict[str, str]]:
    """Project unavailable GMT source windows onto identical canonical instants."""
    windows: list[dict[str, str]] = []
    for raw_window in raw_source_windows:
        day_utc = str(raw_window.get("canonical_day_utc") or "").strip()
        try:
            start = dt.datetime.fromisoformat(
                str(raw_window.get("raw_start_utc") or "").replace(
                    "Z", "+00:00"
                )
            )
            end = dt.datetime.fromisoformat(
                str(raw_window.get("raw_end_exclusive_utc") or "").replace(
                    "Z", "+00:00"
                )
            )
        except ValueError as exc:
            raise ValueError("invalid raw RData source window") from exc
        if start.tzinfo is None or end.tzinfo is None or start >= end:
            raise ValueError("invalid raw RData source window")
        canonical_start = start.astimezone(dt.timezone.utc)
        canonical_end = end.astimezone(dt.timezone.utc)
        try:
            day = dt.date.fromisoformat(day_utc)
        except ValueError as exc:
            raise ValueError("raw RData source window has invalid canonical day") from exc
        day_start = dt.datetime.combine(day, dt.time.min, tzinfo=dt.timezone.utc)
        day_end = day_start + dt.timedelta(days=1)
        if canonical_start < day_start or canonical_end > day_end:
            raise ValueError("raw RData source window escaped its canonical day")
        windows.append({
            "canonical_day_utc": day_utc,
            "canonical_start_utc": canonical_start.isoformat().replace(
                "+00:00", "Z"
            ),
            "canonical_end_exclusive_utc": canonical_end.isoformat().replace(
                "+00:00", "Z"
            ),
        })
    return windows


def canonical_timestamp_is_in_windows(
    observed_at_utc: str,
    windows: Iterable[Mapping[str, Any]],
) -> bool:
    """Return whether a canonical observation timestamp is in any half-open window."""
    try:
        observed = dt.datetime.fromisoformat(
            str(observed_at_utc).replace("Z", "+00:00")
        )
    except ValueError as exc:
        raise ValueError("invalid canonical RData observation timestamp") from exc
    if observed.tzinfo is None:
        raise ValueError("canonical RData observation timestamp is not UTC-aware")
    observed = observed.astimezone(dt.timezone.utc)
    for window in windows:
        try:
            start = dt.datetime.fromisoformat(
                str(window.get("canonical_start_utc") or "").replace(
                    "Z", "+00:00"
                )
            )
            end = dt.datetime.fromisoformat(
                str(window.get("canonical_end_exclusive_utc") or "").replace(
                    "Z", "+00:00"
                )
            )
        except ValueError as exc:
            raise ValueError("invalid canonical RData unavailable window") from exc
        if start.tzinfo is None or end.tzinfo is None or start >= end:
            raise ValueError("invalid canonical RData unavailable window")
        start = start.astimezone(dt.timezone.utc)
        end = end.astimezone(dt.timezone.utc)
        if start <= observed < end:
            return True
    return False


def canonical_day_has_available_window(
    day_utc: str,
    unavailable_windows: Iterable[Mapping[str, Any]],
) -> bool:
    """Return whether any part of a canonical UTC day remains source-authoritative."""
    day = dt.date.fromisoformat(day_utc)
    day_start = dt.datetime.combine(day, dt.time.min, tzinfo=dt.timezone.utc)
    day_end = day_start + dt.timedelta(days=1)
    intervals: list[tuple[dt.datetime, dt.datetime]] = []
    for window in unavailable_windows:
        start = dt.datetime.fromisoformat(
            str(window.get("canonical_start_utc") or "").replace(
                "Z", "+00:00"
            )
        )
        end = dt.datetime.fromisoformat(
            str(window.get("canonical_end_exclusive_utc") or "").replace(
                "Z", "+00:00"
            )
        )
        if start.tzinfo is None or end.tzinfo is None or start >= end:
            raise ValueError("invalid canonical RData unavailable window")
        start = start.astimezone(dt.timezone.utc)
        end = end.astimezone(dt.timezone.utc)
        start = max(start, day_start)
        end = min(end, day_end)
        if start < end:
            intervals.append((start, end))
    covered_until = day_start
    for start, end in sorted(intervals):
        if start > covered_until:
            return True
        if end > covered_until:
            covered_until = end
        if covered_until >= day_end:
            return False
    return covered_until < day_end


def _parse_lifecycle_date(raw_value: Any) -> dt.date | None:
    raw = str(raw_value or "").strip()
    if not raw:
        return None
    try:
        parsed = dt.date.fromisoformat(raw)
    except ValueError:
        return None
    return parsed if parsed.isoformat() == raw else None


def classify_site_year_coverage(
    metadata_rows: Iterable[Mapping[str, Any]],
    *,
    site_code: str,
    bindings_by_pollutant: Mapping[str, Mapping[str, Any]],
    selected_days: Iterable[dt.date],
    source_year: int,
) -> dict[str, Any]:
    """Classify whether selected bindings can overlap one raw site-year file.

    Only a unique metadata row with valid ISO lifecycle dates (or the verified
    ``ongoing`` end marker) can prove no coverage.  Missing, malformed or
    contradictory lifecycle evidence remains indeterminate and therefore must
    retain the existing fail-closed acquisition behaviour.
    """
    days = sorted(set(selected_days))
    windows = source_time_windows_for_year(days, source_year)
    if not windows:
        return {
            "classification": COVERAGE_INDETERMINATE,
            "reason": "no_selected_source_window_for_year",
            "site_code": site_code.upper(),
            "source_year": int(source_year),
            "selected_canonical_days": [day.isoformat() for day in days],
            "raw_source_windows": [],
            "selected_bindings": [],
        }

    parsed_windows = [
        (
            dt.datetime.fromisoformat(window["raw_start_utc"].replace("Z", "+00:00")),
            dt.datetime.fromisoformat(
                window["raw_end_exclusive_utc"].replace("Z", "+00:00")
            ),
        )
        for window in windows
    ]
    rows = list(metadata_rows)
    binding_evidence: list[dict[str, Any]] = []
    for pollutant_code, binding in sorted(bindings_by_pollutant.items()):
        parameter = POLLUTANT_TO_METADATA_PARAMETER[pollutant_code]
        matches = [
            row for row in rows
            if str(row.get("site_id") or "").strip().upper() == site_code.upper()
            and str(row.get("parameter") or "").strip().upper() == parameter.upper()
        ]
        evidence: dict[str, Any] = {
            "pollutant_code": pollutant_code,
            "station_id": int(binding["station_id"]),
            "timeseries_id": int(binding["timeseries_id"]),
            "metadata_row_identity": {
                "site_id": site_code.upper(),
                "parameter": parameter,
            },
        }
        if len(matches) != 1:
            evidence.update({
                "start_date": None,
                "end_date": None,
                "normalised_start_date": None,
                "normalised_end_date": None,
                "end_open": None,
                "classification": COVERAGE_INDETERMINATE,
                "reason": (
                    "metadata_lifecycle_row_missing"
                    if not matches else "metadata_lifecycle_row_ambiguous"
                ),
                "metadata_match_count": len(matches),
            })
            binding_evidence.append(evidence)
            continue

        row = matches[0]
        raw_start = str(row.get("start_date") or "").strip()
        raw_end = str(row.get("end_date") or "").strip()
        start_date = _parse_lifecycle_date(raw_start)
        end_open = raw_end.lower() == "ongoing"
        end_date = None if end_open else _parse_lifecycle_date(raw_end)
        evidence.update({
            "start_date": raw_start or "missing",
            "end_date": raw_end or "missing",
            "normalised_start_date": (
                start_date.isoformat() if start_date is not None else None
            ),
            "normalised_end_date": (
                end_date.isoformat() if end_date is not None else None
            ),
            "end_open": end_open,
            "metadata_match_count": 1,
        })
        lifecycle_reason = None
        if start_date is None:
            lifecycle_reason = (
                "start_date_missing" if not raw_start else "start_date_malformed"
            )
        elif not end_open and end_date is None:
            lifecycle_reason = (
                "end_date_missing" if not raw_end else "end_date_malformed"
            )
        elif end_date is not None and end_date < start_date:
            lifecycle_reason = "lifecycle_dates_contradictory"
        if lifecycle_reason is not None:
            evidence.update({
                "classification": COVERAGE_INDETERMINATE,
                "reason": lifecycle_reason,
            })
            binding_evidence.append(evidence)
            continue

        coverage_start = dt.datetime.combine(
            start_date, dt.time.min, tzinfo=dt.timezone.utc,
        )
        coverage_end = (
            None
            if end_open else dt.datetime.combine(
                end_date + dt.timedelta(days=1),
                dt.time.min,
                tzinfo=dt.timezone.utc,
            )
        )
        overlaps = any(
            coverage_start < raw_end_exclusive
            and (coverage_end is None or coverage_end > raw_start)
            for raw_start, raw_end_exclusive in parsed_windows
        )
        if overlaps:
            evidence.update({
                "classification": COVERAGE_REQUIRED,
                "reason": "lifecycle_overlaps_selected_source_window",
            })
        else:
            earliest_start = min(raw_start for raw_start, _end in parsed_windows)
            latest_end = max(raw_end for _start, raw_end in parsed_windows)
            reason = "lifecycle_does_not_overlap_selected_source_window"
            if coverage_start >= latest_end:
                reason = "coverage_starts_after_selected_source_window"
            elif coverage_end is not None and coverage_end <= earliest_start:
                reason = "coverage_ends_before_selected_source_window"
            evidence.update({
                "classification": COVERAGE_AUTHORITATIVE_NO_COVERAGE,
                "reason": reason,
            })
        binding_evidence.append(evidence)

    classifications = {
        str(item["classification"]) for item in binding_evidence
    }
    if not binding_evidence:
        classification = COVERAGE_INDETERMINATE
        reason = "selected_binding_scope_empty"
    elif COVERAGE_REQUIRED in classifications:
        classification = COVERAGE_REQUIRED
        reason = "selected_binding_overlaps_source_window"
    elif COVERAGE_INDETERMINATE in classifications:
        classification = COVERAGE_INDETERMINATE
        reason = "selected_binding_coverage_indeterminate"
    else:
        classification = COVERAGE_AUTHORITATIVE_NO_COVERAGE
        reason = "all_selected_bindings_outside_source_window"
    return {
        "classification": classification,
        "reason": reason,
        "site_code": site_code.upper(),
        "source_year": int(source_year),
        "selected_canonical_days": [day.isoformat() for day in days],
        "raw_source_windows": windows,
        "selected_bindings": binding_evidence,
    }


def _validated_provider_url(
    url: str,
    *,
    config: OfficialNetworkRDataConfig,
    expected_path: str,
) -> str:
    parsed = urllib.parse.urlsplit(str(url))
    host = str(parsed.hostname or "").lower()
    if (
        parsed.scheme.lower() != "https"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port not in (None, 443)
        or host not in set(config.accepted_hosts)
        or parsed.path != expected_path
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError(
            f"unexpected {config.source_key} RData provider URL: {url}"
        )
    return urllib.parse.urlunsplit(("https", parsed.netloc, parsed.path, "", ""))


def download_pinned(
    url: str,
    destination: Path,
    *,
    config: OfficialNetworkRDataConfig,
    timeout: int = 180,
) -> dict[str, Any]:
    """GET one source object once and atomically retain its exact bytes."""
    requested_at_utc = dt.datetime.now(dt.timezone.utc).isoformat()
    expected_path = urllib.parse.urlsplit(url).path
    canonical_url = _validated_provider_url(
        url,
        config=config,
        expected_path=expected_path,
    )
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.name + ".part")
    digest = hashlib.sha256()
    byte_count = 0
    request = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            final_url = _validated_provider_url(
                response.geturl(),
                config=config,
                expected_path=expected_path,
            )
            if int(getattr(response, "status", 200)) != 200:
                raise RuntimeError(f"GET {url} returned {response.status}")
            with temporary.open("wb") as output:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    output.write(chunk)
                    digest.update(chunk)
                    byte_count += len(chunk)
            headers = response.headers
            raw_content_length = headers.get("Content-Length")
            if raw_content_length is not None:
                try:
                    expected_bytes = int(raw_content_length)
                except (TypeError, ValueError) as exc:
                    raise RuntimeError(
                        f"GET {url} returned an invalid Content-Length"
                    ) from exc
                if expected_bytes < 0 or byte_count != expected_bytes:
                    raise RuntimeError(
                        f"GET {url} download was incomplete: "
                        f"expected_bytes={expected_bytes} actual_bytes={byte_count}"
                    )
        temporary.replace(destination)
    except urllib.error.HTTPError as exc:
        temporary.unlink(missing_ok=True)
        final_url = _validated_provider_url(
            exc.geturl(),
            config=config,
            expected_path=expected_path,
        )
        if int(exc.code) == 404:
            raise AuthoritativeSourceArtifactAbsent(
                canonical_url=canonical_url,
                final_url=final_url,
                requested_at_utc=requested_at_utc,
            ) from exc
        raise
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    return {
        "url": canonical_url,
        "canonical_url": canonical_url,
        "final_url": final_url,
        "availability": "present",
        "http_status": 200,
        "requested_at_utc": requested_at_utc,
        "bytes": byte_count,
        "sha256": digest.hexdigest(),
        "etag": headers.get("ETag"),
        "last_modified": headers.get("Last-Modified"),
        "path": str(destination),
    }


def parse_ratified_to(value: str) -> dt.date | None:
    raw = str(value or "").strip()
    if not raw or raw.lower() == "never":
        return None
    for pattern in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y"):
        try:
            return dt.datetime.strptime(raw, pattern).date()
        except ValueError:
            pass
    raise ValueError(f"unsupported ratified_to value: {raw!r}")


def metadata_boundary(
    metadata_rows: Iterable[Mapping[str, Any]],
    *,
    site_code: str,
    pollutant_code: str,
) -> tuple[dt.date | None, str]:
    parameter = POLLUTANT_TO_METADATA_PARAMETER[pollutant_code]
    matches = [
        row for row in metadata_rows
        if str(row.get("site_id") or "").strip().upper() == site_code.upper()
        and str(row.get("parameter") or "").strip().upper() == parameter.upper()
    ]
    if len(matches) != 1:
        raise ValueError(
            "RData metadata row is missing or ambiguous: "
            f"site_id={site_code} parameter={parameter} matches={len(matches)}"
        )
    raw = str(matches[0].get("ratified_to") or "").strip()
    return parse_ratified_to(raw), raw or "missing"


def canonical_rows_for_site_year(
    source_rows: Iterable[Mapping[str, Any]],
    *,
    connector_id: int,
    site_code: str,
    bindings_by_pollutant: Mapping[str, Mapping[str, Any]],
    metadata_rows: Iterable[Mapping[str, Any]],
    selected_days: set[dt.date],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Map decoded rows only through unambiguous authoritative bindings."""
    boundaries: dict[str, tuple[dt.date | None, str]] = {}
    audits: list[dict[str, Any]] = []
    for pollutant_code in sorted(bindings_by_pollutant):
        boundary, raw = metadata_boundary(
            metadata_rows,
            site_code=site_code,
            pollutant_code=pollutant_code,
        )
        boundaries[pollutant_code] = (boundary, raw)
        audits.append({
            "metadata_row_identity": {
                "site_id": site_code,
                "parameter": POLLUTANT_TO_METADATA_PARAMETER[pollutant_code],
            },
            "pollutant_code": pollutant_code,
            "ratified_to": raw,
            "ratified_to_utc_date": boundary.isoformat() if boundary else None,
            "classification": (
                "ratification_boundary"
                if boundary is not None
                else "provisional_no_ratification_boundary"
            ),
        })

    canonical: list[dict[str, Any]] = []
    for source_row in source_rows:
        observed = canonical_observed_at(str(source_row.get("date") or ""))
        if observed.date() not in selected_days:
            continue
        for source_column, pollutant_code in RDATA_COLUMN_TO_POLLUTANT.items():
            binding = bindings_by_pollutant.get(pollutant_code)
            if binding is None or source_column not in source_row:
                continue
            raw_value = str(source_row.get(source_column) or "").strip()
            if not raw_value:
                continue
            try:
                value = float(raw_value)
            except ValueError as exc:
                raise ValueError(
                    f"invalid RData observation value site={site_code} column={source_column}"
                ) from exc
            if not math.isfinite(value):
                continue
            ratified_to, _raw_boundary = boundaries[pollutant_code]
            canonical.append({
                "connector_id": int(connector_id),
                "station_id": int(binding["station_id"]),
                "timeseries_id": int(binding["timeseries_id"]),
                "pollutant_code": pollutant_code,
                "observed_at_utc": observed.isoformat(
                    timespec="milliseconds"
                ).replace("+00:00", "Z"),
                "value": value,
                "verification_status": (
                    "R" if ratified_to is not None and observed.date() <= ratified_to else "P"
                ),
            })
    canonical.sort(key=lambda row: (
        row["observed_at_utc"],
        row["timeseries_id"],
        row["pollutant_code"],
    ))
    return canonical, audits
