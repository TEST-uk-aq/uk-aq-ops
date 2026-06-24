import csv
import os
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path("scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py")
DAY = "2026-06-18"


def run_checker(tmp_path, root, extra_args=None, version="v2"):
    out = tmp_path / "out"
    env = os.environ.copy()
    env["UK_AQ_R2_HISTORY_VERSION"] = version
    args = [
        sys.executable,
        str(SCRIPT),
        "--from-day",
        DAY,
        "--to-day",
        DAY,
        "--r2-history-root",
        str(root),
        "--out",
        str(out),
    ]
    if extra_args:
        args.extend(extra_args)
    proc = subprocess.run(args, env=env, text=True, capture_output=True, check=False)
    return proc, out


def parquet_writer():
    duckdb = pytest.importorskip("duckdb")
    return duckdb


def write_obs(root, pollutant="pm25", timeseries_counts=None, connector_id="1"):
    duckdb = parquet_writer()
    timeseries_counts = timeseries_counts or {"218": 1}
    part = root / "history/v2/observations" / f"day_utc={DAY}" / f"connector_id={connector_id}" / f"pollutant_code={pollutant}"
    part.mkdir(parents=True, exist_ok=True)
    rows = []
    for tsid, count in timeseries_counts.items():
        for hour in range(count):
            rows.append((int(connector_id), 100 + int(tsid), int(tsid), pollutant, f"{DAY} {hour % 24:02d}:00:00", 12.3))
    con = duckdb.connect()
    con.execute("CREATE TABLE obs(connector_id INTEGER, station_id INTEGER, timeseries_id INTEGER, pollutant_code VARCHAR, observed_at_utc TIMESTAMP, value DOUBLE)")
    con.executemany("INSERT INTO obs VALUES (?, ?, ?, ?, ?, ?)", rows)
    con.execute("COPY obs TO ? (FORMAT PARQUET)", [str(part / "part-00000.parquet")])
    con.close()


def write_aqi(root, pollutant="pm25", timeseries_counts=None, connector_id="1"):
    duckdb = parquet_writer()
    timeseries_counts = timeseries_counts or {"218": 1}
    part = root / "history/v2/aqilevels/hourly/data" / f"day_utc={DAY}" / f"connector_id={connector_id}" / f"pollutant_code={pollutant}"
    part.mkdir(parents=True, exist_ok=True)
    rows = []
    for tsid, count in timeseries_counts.items():
        for hour in range(count):
            rows.append((int(connector_id), 100 + int(tsid), int(tsid), pollutant, f"{DAY} {hour % 24:02d}:00:00", 2, 2, "ok", None, "ok", None, DAY))
    con = duckdb.connect()
    con.execute("""
        CREATE TABLE aqi(
          connector_id INTEGER, station_id INTEGER, timeseries_id INTEGER, pollutant_code VARCHAR,
          timestamp_hour_utc TIMESTAMP, daqi_index_level INTEGER, eaqi_index_level INTEGER,
          daqi_calculation_status VARCHAR, daqi_missing_reason VARCHAR,
          eaqi_calculation_status VARCHAR, eaqi_missing_reason VARCHAR, day_utc DATE
        )
    """)
    con.executemany("INSERT INTO aqi VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
    con.execute("COPY aqi TO ? (FORMAT PARQUET)", [str(part / "part-00000.parquet")])
    con.close()


def write_index(root, kind, pollutant="pm25", row_count=1, connector_id="1"):
    part = root / "history/_index_v2" / kind / f"day_utc={DAY}" / f"connector_id={connector_id}" / f"pollutant_code={pollutant}"
    part.mkdir(parents=True, exist_ok=True)
    (part / "manifest.json").write_text(f'{{"row_count": {row_count}}}\n', encoding="utf-8")


def read_summary(out):
    with (out / "summary.csv").open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def test_refuses_non_v2_env(tmp_path):
    root = tmp_path / "r2"
    root.mkdir()
    proc, _ = run_checker(tmp_path, root, version="v1")
    assert proc.returncode != 0
    assert "R2 v2-only" in proc.stderr
    assert "UK_AQ_R2_HISTORY_VERSION=v2" in proc.stderr


def test_accepts_v2_env(tmp_path):
    root = tmp_path / "r2"
    root.mkdir()
    proc, out = run_checker(tmp_path, root)
    assert proc.returncode == 0, proc.stderr
    assert (out / "run_summary.json").exists()


def test_finds_v2_observation_and_aqi_data_paths(tmp_path):
    root = tmp_path / "r2"
    write_obs(root, timeseries_counts={"218": 3})
    write_aqi(root, timeseries_counts={"218": 3})
    write_index(root, "observations_timeseries", row_count=3)
    write_index(root, "aqilevels_hourly_data_timeseries", row_count=3)
    proc, out = run_checker(tmp_path, root, ["--connector-id", "1", "--pollutant", "pm25"])
    assert proc.returncode == 0, proc.stderr
    rows = read_summary(out)
    assert rows[0]["obs_rows"] == "3"
    assert rows[0]["aqi_rows"] == "3"
    assert rows[0]["status"] == "ok"


def test_detects_missing_aqi_data(tmp_path):
    root = tmp_path / "r2"
    write_obs(root)
    write_index(root, "observations_timeseries")
    proc, out = run_checker(tmp_path, root, ["--connector-id", "1", "--pollutant", "pm25"])
    assert proc.returncode == 0, proc.stderr
    assert "missing_aqi_data" in read_summary(out)[0]["status"]


def test_detects_missing_aqi_index(tmp_path):
    root = tmp_path / "r2"
    write_aqi(root)
    proc, out = run_checker(tmp_path, root, ["--connector-id", "1", "--pollutant", "pm25"])
    assert proc.returncode == 0, proc.stderr
    assert "missing_aqi_index" in read_summary(out)[0]["status"]


def test_detects_missing_observation_index(tmp_path):
    root = tmp_path / "r2"
    write_obs(root)
    write_aqi(root)
    write_index(root, "aqilevels_hourly_data_timeseries")
    proc, out = run_checker(tmp_path, root, ["--connector-id", "1", "--pollutant", "pm25"])
    assert proc.returncode == 0, proc.stderr
    assert "missing_obs_index" in read_summary(out)[0]["status"]


def test_detects_partial_aqi_rows(tmp_path):
    root = tmp_path / "r2"
    write_obs(root, timeseries_counts={"218": 24})
    write_aqi(root, timeseries_counts={"218": 13})
    write_index(root, "observations_timeseries", row_count=24)
    write_index(root, "aqilevels_hourly_data_timeseries", row_count=13)
    proc, out = run_checker(tmp_path, root, ["--connector-id", "1", "--pollutant", "pm25"])
    assert proc.returncode == 0, proc.stderr
    assert "stale_or_partial_aqi_data" in read_summary(out)[0]["status"]


def test_pollutant_all_discovers_multiple_pollutants(tmp_path):
    root = tmp_path / "r2"
    write_obs(root, pollutant="pm25")
    write_aqi(root, pollutant="no2")
    proc, out = run_checker(tmp_path, root, ["--connector-id", "1", "--pollutant", "all"])
    assert proc.returncode == 0, proc.stderr
    assert {row["pol"] for row in read_summary(out)} == {"pm25", "no2"}


def test_optional_timeseries_filter(tmp_path):
    root = tmp_path / "r2"
    write_obs(root, timeseries_counts={"218": 2, "219": 4})
    write_aqi(root, timeseries_counts={"218": 2, "219": 4})
    proc, out = run_checker(tmp_path, root, ["--connector-id", "1", "--pollutant", "pm25", "--timeseries-id", "218"])
    assert proc.returncode == 0, proc.stderr
    assert [row["timeseries_id"] for row in read_summary(out)] == ["218"]

    proc, out = run_checker(tmp_path / "all", root, ["--connector-id", "1", "--pollutant", "pm25"])
    assert proc.returncode == 0, proc.stderr
    assert {row["timeseries_id"] for row in read_summary(out)} == {"218", "219"}
