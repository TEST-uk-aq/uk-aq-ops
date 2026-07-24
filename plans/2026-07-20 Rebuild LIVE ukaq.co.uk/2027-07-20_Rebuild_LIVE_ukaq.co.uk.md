That approach sounds cleaner than trying to “move” the existing LIVE system in place.

You are really proposing a **parallel rebuild of LIVE on the new domain and Cloudflare account**, using the existing LIVE v1 history and database as migration sources.

## Restricting the pollutants

I would restrict **R2 observations v2 to the main four**:

* `pm25`
* `pm10`
* `no2`
* `o3`

I would not reduce it to only three unless you are certain ozone will not be used.

Ozone is already part of the current website and integrity work, and it is an important pollutant for summer air pollution. Supporting four rather than three adds very little complexity once the structure is pollutant-partitioned.

The main simplification should be:

> R2 v2 observations are an explicitly limited public-history product, not a complete archive of every `observed_properties.code`.

That is simpler and clearer than pretending it is all-property history while only parts of the system actually support those properties.

You should then make the same rule explicit in TEST and LIVE:

```text
UK_AQ_R2_V2_OBSERVATION_PROPERTY_CODES=pm25,pm10,no2,o3
```

The migration script, prune workflow, indexes, integrity checks and documentation should all use the same central allow-list.

Anything outside the allow-list should:

* remain available in the operational database if ingested
* not be written into R2 observations v2
* be logged as intentionally excluded
* not cause the history job to fail

That avoids silent omissions while keeping the R2 product deliberately narrow.

## Your proposed migration model

I think this is the right overall shape:

```text
Existing CIC LIVE system
├── LIVE Supabase v1 database
├── LIVE CIC Cloudflare R2 v1
└── uk-aq-beta.chronicillnesschannel.co.uk

                migration sources
                         ↓

New UKAQ LIVE system
├── new Supabase LIVE database using v2 schema
├── new R2 bucket in the ukaq.co.uk Cloudflare account
├── R2 v2 history rebuilt from CIC LIVE v1 data
├── LIVE-uk-aq repositories populated from TEST-uk-aq
└── beta.ukaq.co.uk
```

This gives you a proper cutover boundary. The current LIVE system can continue operating while the new system is built and checked.

## Recommended order

### 1. Finalise TEST as the source system

Before copying code into `LIVE-uk-aq`, settle the four-pollutant policy in TEST.

That includes:

* shared allow-list
* prune daily v2 writer
* v2 index builder
* integrity jobs
* Dropbox backup
* migration script
* system documentation

This is important because otherwise LIVE will immediately diverge from TEST during migration.

### 2. Create the new LIVE Cloudflare resources

In the `ukaq.co.uk` Cloudflare account:

* create the LIVE R2 history bucket
* create R2 API credentials scoped only to that bucket
* create the required custom-domain or Worker bindings
* configure `beta.ukaq.co.uk`
* create any scheduler Workers and secrets needed by LIVE

The migration script should require the exact LIVE bucket and account endpoint rather than merely accepting any non-TEST destination.

### 3. Create the new LIVE Supabase v2 database

I would create a **new Supabase project or database**, rather than upgrade the current LIVE database in place.

Apply the current `TEST-uk-aq-schema` migrations to produce a clean v2 database.

Then migrate the required LIVE data into it, including:

* connectors
* networks
* stations
* timeseries
* observed properties
* phenomena and units where still used
* configuration and display metadata
* any user or authentication data that must be retained
* required operational state

Observations need a separate decision. You may not need to copy all historical observations into the new operational database if R2 v2 becomes the authoritative history and the database only needs the configured retention window.

A sensible approach would be:

* copy metadata and configuration fully
* copy only recent operational observations needed for website continuity
* rebuild older history into R2 v2 from the existing CIC v1 archive

### 4. Build new LIVE R2 v2 history

Use the LIVE CIC Dropbox mirror as the source and upload to the new LIVE R2 bucket.

The migration script should be amended to:

* use the four-property allow-list
* support an explicit LIVE destination
* validate the new Cloudflare account ID and bucket
* reject TEST credentials
* report excluded properties and row counts
* report missing timeseries metadata
* use the current v2 Parquet and manifest builders
* default to dry-run
* require an explicit LIVE write flag

The normal LIVE workflow can then begin adding:

```text
history/v2/core
```

and new daily observations once the new LIVE services start.

### 5. Populate the LIVE repositories from TEST

Copy the proven TEST repository state into corresponding `LIVE-uk-aq` repositories.

Avoid manually copying only selected files. The safer model is to use TEST as the baseline and then apply a small, documented set of LIVE configuration differences:

* domains
* Supabase URLs and keys
* R2 endpoint and bucket
* Cloudflare account and Worker bindings
* scheduler configuration
* repository/environment names
* Dropbox roots
* logging labels
* retention settings where intentionally different

Ideally, code stays identical and only environment configuration differs.

### 6. Start the new LIVE backend before the public cutover

Start the new LIVE system on `beta.ukaq.co.uk` while the existing CIC LIVE system remains available.

At this stage:

* ingests write to the new Supabase database
* prune daily writes to the new R2 v2 bucket
* core snapshots populate R2 v2
* website reads from the new services
* integrity checks run against the new bucket and database

Because this is the new LIVE system, I would initially treat `beta.ukaq.co.uk` as a controlled production shake-down rather than immediately redirecting the existing domain.

### 7. Cut over

After real operations show that the new system is working:

* stop old CIC LIVE schedulers and writers
* perform any final recent-data sync
* confirm the new system has caught up
* direct users to `beta.ukaq.co.uk`
* retain the old CIC bucket and database read-only for rollback and archival purposes

## One important naming point

Calling the new system `beta.ukaq.co.uk` while it is also the new LIVE system may cause confusion later.

It could mean either:

1. the production system is intentionally branded as beta; or
2. it is a temporary beta endpoint before eventually becoming `ukaq.co.uk`.

Both are valid, but the deployment and documentation should use explicit internal names such as:

```text
environment: LIVE
public_status: beta
domain: beta.ukaq.co.uk
```

That prevents code and workflows from accidentally treating it as TEST merely because the hostname contains `beta`.

## My recommendation

Use the four pollutants, not three.

Build a new LIVE v2 system alongside the existing CIC LIVE system:

* new Cloudflare account and R2 bucket
* new Supabase v2 database
* new `LIVE-uk-aq` repositories based on TEST
* historical observations rebuilt from CIC LIVE v1
* new data populated by the v2 workflows
* public launch at `beta.ukaq.co.uk`

This is more controlled and easier to roll back than modifying the existing LIVE infrastructure in place.
