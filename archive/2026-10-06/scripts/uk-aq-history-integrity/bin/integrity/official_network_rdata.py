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
import urllib.request


@dataclass(frozen=True)
class OfficialNetworkRDataConfig:
    source_key: str
    connector_code: str
    connector_id: int
    base_url: str
    metadata_filename: str
    metadata_object: str


NETWORKS: dict[str, OfficialNetworkRDataConfig] = {
    "waqn": OfficialNetworkRDataConfig(
        source_key="waqn",
        connector_code="waqn",
        connector_id=9,
        base_url="https://airquality.gov.wales/sites/default/files/openair/R_data/",
        metadata_filename="WAQ_metadata.RData",
        metadata_object="metadata",
    ),
    "saqn": OfficialNetworkRDataConfig(
        source_key="saqn",
        connector_code="saqn",
        connector_id=10,
        base_url="https://www.scottishairquality.scot/openair/R_data/",
        metadata_filename="SCOT_metadata.RData",
        metadata_object="meta",
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
  keep <- intersect(c("date", "PM2.5", "PM10", "NO2", "O3"), names(value))
  value <- value[, keep, drop=FALSE]
  parsed <- as.POSIXct(value$date, tz="UTC")
  if (any(is.na(parsed))) stop("site-year object has an invalid date value")
  value$date <- format(parsed, "%Y-%m-%dT%H:%M:%SZ", tz="UTC", usetz=FALSE)
} else if (identical(mode, "metadata")) {
  required <- c("site_id", "parameter", "ratified_to")
  if (!all(required %in% names(value))) stop("metadata object lacks required columns")
  value <- value[, required, drop=FALSE]
  value$site_id <- as.character(value$site_id)
  value$parameter <- as.character(value$parameter)
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


def _extract_tsv(path: Path, *, mode: str, object_name: str) -> list[dict[str, str]]:
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
    return [
        {str(key): str(value or "") for key, value in row.items()}
        for row in reader
    ]


def extract_site_year(path: Path, *, site_code: str, year: int) -> list[dict[str, str]]:
    return _extract_tsv(
        path,
        mode="site_year",
        object_name=f"{site_code}_{int(year)}",
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


def canonical_observed_at(raw_date_beginning: str) -> dt.datetime:
    """Map proven OpenAir hour-beginning UTC to UK-AQ canonical hour-ending UTC."""
    parsed = dt.datetime.fromisoformat(raw_date_beginning.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc) + dt.timedelta(hours=1)


def required_site_years(days: Iterable[dt.date]) -> list[int]:
    """Include the prior raw year needed for a canonical 1 January 00:00 row."""
    years: set[int] = set()
    for day in days:
        start = dt.datetime.combine(day, dt.time.min, tzinfo=dt.timezone.utc)
        end = start + dt.timedelta(days=1)
        years.add((start - dt.timedelta(hours=1)).year)
        years.add((end - dt.timedelta(hours=1)).year)
    return sorted(years)


def download_pinned(url: str, destination: Path, *, timeout: int = 180) -> dict[str, Any]:
    """GET one source object once and atomically retain its exact bytes."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.name + ".part")
    digest = hashlib.sha256()
    byte_count = 0
    request = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
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
        temporary.replace(destination)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    return {
        "url": url,
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
