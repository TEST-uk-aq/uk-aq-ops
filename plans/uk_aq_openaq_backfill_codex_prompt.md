OpenAQ Backfill Codex Prompt

Please implement OpenAQ historical backfill in the UK AQ backfill Cloud Run worker, following the existing Sensor.Community (SCOMM) backfill pattern as closely as practical.

Context and locked decisions
	•	Network: OpenAQ
	•	Historical source for phase 1: AWS archive only
	•	Do not use OpenAQ API fallback in phase 1
	•	Candidate UK station universe: use the existing OpenAQ stations list that already contains all UK stations ever seen
	•	OpenAQ ID mapping is:
	•	stations.station_ref = OpenAQ location_id
	•	station_timeseries.timeseries_ref = OpenAQ sensor_id
This matches the documented storage mapping in the project notes.
	•	Requested run input should accept a UTC start day and UTC end day, just like SCOMM backfill
	•	If start and end are the same date, process one day only
	•	If different, process all days inclusive, one day at a time
	•	Actual source file unit is one OpenAQ location-day file from AWS
	•	Include met fields in this backfill
	•	Output must be processed into the normal UK AQ R2 format, matching what the existing ingest/processing pipeline would produce
	•	This must not invent a special backfill-only R2 schema or shape
	•	Match existing SCOMM backfill behavior and conventions wherever possible
	•	Support UK_AQ_BACKFILL_FORCE_REPLACE=true|false, matching existing SCOMM semantics as closely as possible
	•	When running run_job.ts locally only, support optional raw file mirroring into the local Dropbox-synced folder, matching SCOMM-style behavior as closely as practical

Primary goal

Add OpenAQ historical backfill support to the current backfill Cloud Run worker so it can ingest OpenAQ historical AWS archive data for a UTC date range and write processed outputs into the normal UK AQ R2 history format.

OpenAQ archive structure

The archive structure is:

s3://openaq-data-archive/records/csv.gz/locationid=<LOCATION_ID>/year=<YYYY>/month=<MM>/location-<LOCATION_ID>-<YYYYMMDD>.csv.gz

Examples:
	•	records/csv.gz/locationid=100/year=2016/month=03/location-100-20160320.csv.gz

This means:
	•	archive partition key is location_id
	•	files are per location per UTC day
	•	processing should loop days, and within each day process all candidate OpenAQ location_ids for that day

Behavior to implement

1. Add OpenAQ support to the backfill worker
	•	Extend the existing backfill worker so OpenAQ can be selected as a connector/source in the same overall style as SCOMM
	•	Reuse existing helper patterns, ledger/checkpoint patterns, logging patterns, and env conventions where practical
	•	Avoid large unrelated refactors unless needed to fit OpenAQ cleanly

2. Date range behavior
	•	Accept UTC start day and UTC end day
	•	Process all days inclusive
	•	Process one UTC day at a time
	•	Within each day, process all candidate OpenAQ locations for that day
	•	Keep execution ordering simple and deterministic

3. Candidate location selection
	•	Use the existing OpenAQ stations list already maintained by the project as the candidate UK location universe
	•	Do not query OpenAQ API to discover stations during backfill
	•	Do not try to discover day-specific UK station lists from the archive
	•	Treat the existing UK stations list as the authoritative candidate location_id universe for phase 1
	•	The candidate ID for OpenAQ backfill is station_ref, which for OpenAQ is location_id

4. Raw source fetch path
	•	AWS only in phase 1
	•	For each candidate location_id and target UTC day, derive the expected OpenAQ archive object path
	•	If the file exists, download it
	•	If it does not exist, treat that location-day as no source data for that day, following the nearest existing SCOMM-style behavior for missing candidate files
	•	Do not add API fallback in phase 1
	•	Use anonymous/public AWS archive access as appropriate for this bucket

5. Raw local mirror behavior for local runs
	•	Match SCOMM backfill raw mirroring behavior as closely as practical
	•	This raw mirror behavior should only apply when running run_job.ts locally
	•	Add an OpenAQ-specific raw mirror env var equivalent to the SCOMM one:
	•	UK_AQ_BACKFILL_OPENAQ_RAW_MIRROR_ROOT
	•	The intended local root will be:

/Users/mikehinford/Library/CloudStorage/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_Backfill_raw_files/openaq

	•	Mirror path layout under that root should be:

day_utc=YYYY-MM-DD/location-<location_id>-<YYYYMMDD>.csv.gz

	•	Behavior should be:
	•	if mirrored raw file already exists locally, reuse it
	•	otherwise download from AWS and save it there
	•	Keep this mirror optional and non-critical to the main backfill pipeline

6. Force replace behavior
	•	Support UK_AQ_BACKFILL_FORCE_REPLACE=true|false
	•	Match SCOMM backfill semantics as closely as possible
	•	If false, skip already-produced outputs using the same style of decision logic as SCOMM
	•	If true, rebuild/replace for the relevant OpenAQ work units in the same style as SCOMM

7. Processing and transformation
	•	Parse the OpenAQ location-day archive files
	•	Transform the source data into the same canonical downstream shape expected by the UK AQ pipeline
	•	Then write outputs into the same normal R2 format as if the data had been ingested and processed normally
	•	Do not introduce a special OpenAQ backfill R2 format
	•	Preserve alignment with existing OpenAQ ingest mapping where practical
	•	Respect:
	•	station_ref = OpenAQ location_id
	•	timeseries_ref = OpenAQ sensor_id
	•	Include met fields
	•	Process the historical source so resulting R2 output matches existing project conventions and downstream expectations

8. Pollutants / fields
	•	Include the main pollutant fields already used for OpenAQ
	•	Include met fields too
	•	Keep behavior aligned with existing OpenAQ ingest conventions wherever practical
	•	Avoid silently dropping met fields in this phase

9. DB and retention behavior
	•	Follow the existing backfill framework behavior and conventions as closely as possible
	•	Preserve the established project approach around retention and history output rather than inventing a separate OpenAQ-only rule set
	•	Where SCOMM backfill already has a pattern for outside-retention handling, mirror that pattern as closely as practical for OpenAQ
	•	The important requirement is that historical backfill still produces the normal expected R2 output

10. Logging, checkpoints, and reporting
	•	Follow existing SCOMM/backfill logging and progress reporting patterns as closely as possible
	•	Make logs clear enough to show:
	•	target day
	•	location_id
	•	whether raw source file was found
	•	whether a local mirrored file was reused
	•	whether output was skipped due to force_replace=false logic
	•	whether output was processed and written successfully
	•	any failures
	•	Reuse existing backfill checkpoint/ledger patterns where practical rather than inventing a new disconnected OpenAQ-only mechanism

11. Code reuse
	•	Reuse existing OpenAQ ingest mapping/transform logic where practical rather than duplicating complex mapping behavior
	•	Reuse existing SCOMM backfill patterns for day loops, overwrite/skip logic, local raw mirroring, logging, and output writes
	•	Keep the implementation as small and consistent as possible while still being clean

12. Naming / consistency
	•	Note that older discussion may refer to source_to_all, but the current name is source_to_r2
	•	Use current naming in new code and comments
	•	Keep comments accurate and current

What I want changed
	•	Update the backfill Cloud Run worker and any closely related supporting files needed to add OpenAQ backfill
	•	Add or update env handling for OpenAQ raw local mirror support
	•	Add or update any helper functions needed for:
	•	OpenAQ AWS object path derivation
	•	local raw mirror path derivation
	•	OpenAQ day-by-day backfill execution
	•	parsing OpenAQ archive files
	•	writing normal UK AQ R2 outputs
	•	Keep changes focused and scoped

Constraints
	•	Do not add OpenAQ API fallback in phase 1
	•	Do not redesign the entire backfill framework
	•	Do not create a second historical output format
	•	Do not assume station_ref is sensor_id; for OpenAQ it is location_id, and timeseries_ref is sensor_id
	•	Do not make local Dropbox mirroring part of the required production path
	•	Do not over-query external systems unnecessarily

Please do the following in your response
	1.	Briefly summarize the implementation plan
	2.	List the files you changed
	3.	Explain any env vars added or reused
	4.	Explain any assumptions made where SCOMM behavior was not directly reusable
	5.	Flag any places where you had to choose the nearest equivalent because OpenAQ archive shape differs from SCOMM