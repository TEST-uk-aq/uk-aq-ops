#!/usr/bin/env python3
"""Update WHO guideline reference-table DDL in uk-aq-schema.

Run from the root of TEST-uk-aq/uk-aq-schema.

The script updates the two active canonical SQL files and creates an
existing-database migration. It does not run SQL or perform Git operations.
"""

from __future__ import annotations

from pathlib import Path
import sys

ROOT = Path.cwd()
CANONICAL_FILES = [
    ROOT / "schemas/obs_aqi_db/uk_aq_obs_aqi_db_schema.sql",
    ROOT / "schemas/obs_aqi_db/uk_aq_who_2021_ops_schema.sql",
]
MIGRATION_PATH = ROOT / "schemas/migrations/20260723_001_obs_aqidb_who_guideline_values.sql"

OLD_TABLE = "uk_aq_ops.who_2021_guideline_values"
NEW_TABLE = "uk_aq_ops.who_guideline_values"


def replace_exact(text: str, old: str, new: str, expected: int, label: str) -> str:
    count = text.count(old)
    if count != expected:
        raise RuntimeError(f"{label}: expected {expected} occurrence(s), found {count}")
    return text.replace(old, new)


OLD_TABLE_BLOCK = """create table if not exists uk_aq_ops.who_guideline_values (
  pollutant_code text primary key
    check (pollutant_code in ('pm25', 'pm10', 'no2')),
  pollutant_label text not null,
  who_daily_guideline_ugm3 double precision not null
    check (who_daily_guideline_ugm3 > 0),
  who_yearly_guideline_ugm3 double precision not null
    check (who_yearly_guideline_ugm3 > 0),
  daily_allowance_days integer not null default 4
    check (daily_allowance_days >= 0),
  unit text not null default 'ug/m3',
  guideline_version text not null default 'WHO 2021',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);"""

NEW_TABLE_BLOCK = """create table if not exists uk_aq_ops.who_guideline_values (
  guideline_version text not null default 'WHO 2021',
  pollutant_code text not null
    check (pollutant_code in ('pm25', 'pm10', 'no2')),
  pollutant_label text not null,
  who_daily_guideline_ugm3 double precision not null
    check (who_daily_guideline_ugm3 > 0),
  who_yearly_guideline_ugm3 double precision not null
    check (who_yearly_guideline_ugm3 > 0),
  daily_allowance_days integer not null default 4
    check (daily_allowance_days >= 0),
  unit text not null default 'ug/m3',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (guideline_version, pollutant_code)
);"""

OLD_SEED_BLOCK = """insert into uk_aq_ops.who_guideline_values (
  pollutant_code,
  pollutant_label,
  who_daily_guideline_ugm3,
  who_yearly_guideline_ugm3,
  daily_allowance_days,
  unit,
  guideline_version
)
values
  ('pm25', 'PM2.5', 15, 5, 4, 'ug/m3', 'WHO 2021'),
  ('pm10', 'PM10', 45, 15, 4, 'ug/m3', 'WHO 2021'),
  ('no2', 'NO2', 25, 10, 4, 'ug/m3', 'WHO 2021')
on conflict (pollutant_code) do update
set
  pollutant_label = excluded.pollutant_label,
  who_daily_guideline_ugm3 = excluded.who_daily_guideline_ugm3,
  who_yearly_guideline_ugm3 = excluded.who_yearly_guideline_ugm3,
  daily_allowance_days = excluded.daily_allowance_days,
  unit = excluded.unit,
  guideline_version = excluded.guideline_version,
  updated_at = now();"""

NEW_SEED_BLOCK = """insert into uk_aq_ops.who_guideline_values (
  guideline_version,
  pollutant_code,
  pollutant_label,
  who_daily_guideline_ugm3,
  who_yearly_guideline_ugm3,
  daily_allowance_days,
  unit
)
values
  ('WHO 2021', 'pm25', 'PM2.5', 15, 5, 4, 'ug/m3'),
  ('WHO 2021', 'pm10', 'PM10', 45, 15, 4, 'ug/m3'),
  ('WHO 2021', 'no2', 'NO2', 25, 10, 4, 'ug/m3')
on conflict (guideline_version, pollutant_code) do update
set
  pollutant_label = excluded.pollutant_label,
  who_daily_guideline_ugm3 = excluded.who_daily_guideline_ugm3,
  who_yearly_guideline_ugm3 = excluded.who_yearly_guideline_ugm3,
  daily_allowance_days = excluded.daily_allowance_days,
  unit = excluded.unit,
  updated_at = now();"""


def transform(text: str, path: Path) -> str:
    if OLD_TABLE not in text:
        raise RuntimeError(f"{path}: old table reference not found")

    text = text.replace(OLD_TABLE, NEW_TABLE)
    text = replace_exact(text, OLD_TABLE_BLOCK, NEW_TABLE_BLOCK, 1, f"{path}: table definition")
    text = replace_exact(
        text,
        "comment on table uk_aq_ops.who_guideline_values is\n  'Private WHO 2021 health-based guideline reference values for UK AQ derived calculations. These are not UK legal limits.';",
        "comment on table uk_aq_ops.who_guideline_values is\n  'Private versioned WHO health-based guideline reference values for UK AQ derived calculations. These are not UK legal limits.';",
        1,
        f"{path}: table comment",
    )
    text = replace_exact(text, OLD_SEED_BLOCK, NEW_SEED_BLOCK, 1, f"{path}: seed block")
    text = replace_exact(
        text,
        "  pollutant_code text not null references uk_aq_ops.who_guideline_values(pollutant_code),",
        "  guideline_version text not null default 'WHO 2021'\n    check (guideline_version = 'WHO 2021'),\n  pollutant_code text not null,",
        3,
        f"{path}: result-table version columns",
    )

    for primary_key in [
        "  primary key (day_utc, connector_id, timeseries_id),",
        "  primary key (as_of_day_utc, connector_id, timeseries_id),",
        "  primary key (calendar_year, period_type, connector_id, timeseries_id),",
    ]:
        text = replace_exact(
            text,
            primary_key,
            primary_key
            + "\n  foreign key (guideline_version, pollutant_code)"
            + "\n    references uk_aq_ops.who_guideline_values(guideline_version, pollutant_code),",
            1,
            f"{path}: composite foreign key after {primary_key}",
        )

    text = text.replace(
        "who_2021_guideline_values_touch_updated_at",
        "who_guideline_values_touch_updated_at",
    )
    text = replace_exact(
        text,
        "      'who_2021_guideline_values',",
        "      'who_guideline_values',",
        1,
        f"{path}: RLS table list",
    )
    text = replace_exact(
        text,
        "left join uk_aq_ops.who_guideline_values g\n      on g.pollutant_code = code",
        "left join uk_aq_ops.who_guideline_values g\n      on g.pollutant_code = code\n     and g.guideline_version = 'WHO 2021'",
        3,
        f"{path}: supported-pollutant checks",
    )
    text = replace_exact(
        text,
        "join uk_aq_ops.who_guideline_values g\n    on g.pollutant_code = et.pollutant_code",
        "join uk_aq_ops.who_guideline_values g\n    on g.pollutant_code = et.pollutant_code\n   and g.guideline_version = 'WHO 2021'",
        1,
        f"{path}: daily guideline join",
    )
    text = replace_exact(
        text,
        "join uk_aq_ops.who_guideline_values g\n    on g.pollutant_code = a.pollutant_code",
        "join uk_aq_ops.who_guideline_values g\n    on g.pollutant_code = a.pollutant_code\n   and g.guideline_version = 'WHO 2021'",
        2,
        f"{path}: summary guideline joins",
    )
    text = replace_exact(
        text,
        "from uk_aq_ops.who_guideline_values g\n    where g.pollutant_code = any(v_pollutant_codes)",
        "from uk_aq_ops.who_guideline_values g\n    where g.guideline_version = 'WHO 2021'\n      and g.pollutant_code = any(v_pollutant_codes)",
        1,
        f"{path}: pollutant-order filter",
    )

    if "who_2021_guideline_values" in text:
        raise RuntimeError(f"{path}: old table name remains")
    if text.count("references uk_aq_ops.who_guideline_values(guideline_version, pollutant_code)") != 3:
        raise RuntimeError(f"{path}: expected three composite foreign keys")
    if text.count("g.guideline_version = 'WHO 2021'") != 7:
        raise RuntimeError(f"{path}: expected seven WHO 2021 lookup filters")
    return text


MIGRATION_PRELUDE = """-- Target: Obs AQI DB
-- Description: Rename the WHO guideline reference table, version its key,
-- and preserve the WHO 2021 derived tables.
-- TEST migration. Safe to rerun after successful completion.

begin;

create schema if not exists uk_aq_ops;

do $$
begin
  if to_regclass('uk_aq_ops.who_2021_guideline_values') is not null
     and to_regclass('uk_aq_ops.who_guideline_values') is not null then
    raise exception 'Both who_2021_guideline_values and who_guideline_values exist; resolve before applying migration';
  elsif to_regclass('uk_aq_ops.who_2021_guideline_values') is not null then
    alter table uk_aq_ops.who_2021_guideline_values
      rename to who_guideline_values;
  end if;
end
$$;

create table if not exists uk_aq_ops.who_guideline_values (
  guideline_version text not null default 'WHO 2021',
  pollutant_code text not null
    check (pollutant_code in ('pm25', 'pm10', 'no2')),
  pollutant_label text not null,
  who_daily_guideline_ugm3 double precision not null
    check (who_daily_guideline_ugm3 > 0),
  who_yearly_guideline_ugm3 double precision not null
    check (who_yearly_guideline_ugm3 > 0),
  daily_allowance_days integer not null default 4
    check (daily_allowance_days >= 0),
  unit text not null default 'ug/m3',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table uk_aq_ops.who_guideline_values
  add column if not exists guideline_version text;

update uk_aq_ops.who_guideline_values
set guideline_version = 'WHO 2021'
where guideline_version is null or btrim(guideline_version) = '';

alter table uk_aq_ops.who_guideline_values
  alter column guideline_version set default 'WHO 2021',
  alter column guideline_version set not null;

do $$
declare
  r record;
  v_primary_key text;
begin
  for r in
    select conrelid::regclass as relation_name, conname
    from pg_constraint
    where contype = 'f'
      and confrelid = 'uk_aq_ops.who_guideline_values'::regclass
  loop
    execute format('alter table %s drop constraint %I', r.relation_name, r.conname);
  end loop;

  select conname
    into v_primary_key
  from pg_constraint
  where conrelid = 'uk_aq_ops.who_guideline_values'::regclass
    and contype = 'p';

  if v_primary_key is not null then
    execute format(
      'alter table uk_aq_ops.who_guideline_values drop constraint %I',
      v_primary_key
    );
  end if;

  alter table uk_aq_ops.who_guideline_values
    add constraint who_guideline_values_pkey
    primary key (guideline_version, pollutant_code);
end
$$;

insert into uk_aq_ops.who_guideline_values (
  guideline_version,
  pollutant_code,
  pollutant_label,
  who_daily_guideline_ugm3,
  who_yearly_guideline_ugm3,
  daily_allowance_days,
  unit
)
values
  ('WHO 2021', 'pm25', 'PM2.5', 15, 5, 4, 'ug/m3'),
  ('WHO 2021', 'pm10', 'PM10', 45, 15, 4, 'ug/m3'),
  ('WHO 2021', 'no2', 'NO2', 25, 10, 4, 'ug/m3')
on conflict (guideline_version, pollutant_code) do update
set
  pollutant_label = excluded.pollutant_label,
  who_daily_guideline_ugm3 = excluded.who_daily_guideline_ugm3,
  who_yearly_guideline_ugm3 = excluded.who_yearly_guideline_ugm3,
  daily_allowance_days = excluded.daily_allowance_days,
  unit = excluded.unit,
  updated_at = now();

do $$
declare
  v_table text;
  v_constraint text;
begin
  foreach v_table in array array[
    'who_2021_daily_status',
    'who_2021_rolling_year_status',
    'who_2021_calendar_year_status'
  ]
  loop
    if to_regclass(format('uk_aq_ops.%I', v_table)) is not null then
      execute format(
        'alter table uk_aq_ops.%I add column if not exists guideline_version text',
        v_table
      );
      execute format(
        'update uk_aq_ops.%I set guideline_version = ''WHO 2021'' where guideline_version is null or btrim(guideline_version) = ''''',
        v_table
      );
      execute format(
        'alter table uk_aq_ops.%I alter column guideline_version set default ''WHO 2021'', alter column guideline_version set not null',
        v_table
      );

      v_constraint := v_table || '_guideline_version_check';
      if not exists (
        select 1
        from pg_constraint
        where conrelid = format('uk_aq_ops.%I', v_table)::regclass
          and conname = v_constraint
      ) then
        execute format(
          'alter table uk_aq_ops.%I add constraint %I check (guideline_version = ''WHO 2021'')',
          v_table,
          v_constraint
        );
      end if;

      v_constraint := v_table || '_guideline_version_pollutant_fkey';
      if not exists (
        select 1
        from pg_constraint
        where conrelid = format('uk_aq_ops.%I', v_table)::regclass
          and conname = v_constraint
      ) then
        execute format(
          'alter table uk_aq_ops.%I add constraint %I foreign key (guideline_version, pollutant_code) references uk_aq_ops.who_guideline_values(guideline_version, pollutant_code)',
          v_table,
          v_constraint
        );
      end if;
    end if;
  end loop;
end
$$;

drop trigger if exists who_2021_guideline_values_touch_updated_at
  on uk_aq_ops.who_guideline_values;
drop policy if exists who_2021_guideline_values_service_role
  on uk_aq_ops.who_guideline_values;

comment on table uk_aq_ops.who_guideline_values is
  'Private versioned WHO health-based guideline reference values for UK AQ derived calculations. These are not UK legal limits.';

-- The updated canonical WHO schema follows so all existing functions,
-- triggers, policies and grants are recreated against the new table.
"""


def main() -> int:
    missing = [path for path in CANONICAL_FILES if not path.is_file()]
    if missing:
        for path in missing:
            print(f"Missing expected file: {path}", file=sys.stderr)
        return 2

    if MIGRATION_PATH.exists():
        print(f"Refusing to overwrite existing migration: {MIGRATION_PATH}", file=sys.stderr)
        return 2

    transformed: dict[Path, str] = {}
    try:
        for path in CANONICAL_FILES:
            transformed[path] = transform(path.read_text(encoding="utf-8"), path)
    except (OSError, RuntimeError) as exc:
        print(f"Patch validation failed: {exc}", file=sys.stderr)
        return 1

    for path, text in transformed.items():
        path.write_text(text, encoding="utf-8")
        print(f"Updated {path.relative_to(ROOT)}")

    focused = transformed[CANONICAL_FILES[1]]
    MIGRATION_PATH.write_text(
        MIGRATION_PRELUDE + "\n" + focused.rstrip() + "\n\ncommit;\n",
        encoding="utf-8",
    )
    print(f"Created {MIGRATION_PATH.relative_to(ROOT)}")

    for path in [*CANONICAL_FILES, MIGRATION_PATH]:
        text = path.read_text(encoding="utf-8")
        if OLD_TABLE in text:
            raise RuntimeError(f"{path}: old table name remains")
        if NEW_TABLE not in text:
            raise RuntimeError(f"{path}: new table name missing")
        if "primary key (guideline_version, pollutant_code)" not in text:
            raise RuntimeError(f"{path}: composite reference-table key missing")

    print("Structural checks passed.")
    print("No SQL was applied and no Git operation was performed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
