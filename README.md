# Offline Geocoder

Node and React Native library for offline geocoding. Designed to be used
offline (for example embedded in a desktop or mobile application) — no web
requests are made to perform a lookup.

## Data

This uses data from the [GeoNames project](http://www.geonames.org/), which is
free to use under the [Creative Commons Attribution 3.0 license](http://creativecommons.org/licenses/by/3.0/).
To enable this to work offline, the data is imported into a SQLite database
which is roughly 12 MB, so easily embeddable within an application.

By default it uses the `cities1000` dataset which contains details of all
worldwide cities with a population of at least 1000 people. Depending on your
needs you may get better performance or accuracy by using one of their other
datasets.

The GeoNames data is limited to city-level granularity, so if you need street
level accuracy this won't work for you. Also most data is only available in
English. Take a look at the
[OpenStreetMap Nominatim project](https://github.com/twain47/Nominatim) for a
similar tool with a lot more features.

The advantages of this working offline are you don't need to pay or obtain a
license key, and it's fast. On my meager laptop I can perform around 300
lookups per second with a single process.

## Installation

```
npm install --save offline-geocoder
```

For Node you also need `sqlite3`:

```
npm install --save sqlite3
```

For Expo / React Native, install `expo-sqlite` instead:

```
npx expo install expo-sqlite
```

You also need to obtain a database which isn't included in the package, to
generate your own take a look at the [Generating the database](#generating-the-database)
section below.

## Usage

When you initialize the library you need to pass the location of the database:

```javascript
const geocoder = require('offline-geocoder')({ database: 'data/geocoder.sqlite' })
```

To enable boundary-aware reverse geocoding, pass `reverseMode: 'boundary'`
(default is `centroid` for backward compatibility):

```javascript
const geocoder = require('offline-geocoder')({
  database: 'data/geocoder.sqlite',
  reverseMode: 'boundary',
  boundary: { basePrecision: 4, maxPrecision: 7 }
})
```

### Reverse Geocoding

To perform a reverse geocode lookup just pass the coordinates:

```javascript
geocoder.reverse(41.89, 12.49)
  .then(function(result) {
    console.log(result)
  })
  .catch(function(error) {
    console.error(error)
  })
```

Which outputs:

```
{ id: 3169070,
  name: 'Rome',
  formatted: 'Rome, Latium, Italy',
  country: { id: 'IT', name: 'Italy' },
  admin1: { id: 7, name: 'Latium' },
  coordinates: { latitude: 41.89193, longitude: 12.51133 } }
```

The library also has a callback interface:

```javascript
geocoder.reverse(41.89, 12.49, function(error, result) {
  console.log(result)
})
```

Boundary mode keeps the same return payload shape and supports two boundary
storage modes:
- compact lookup (`compact_places` + `compact_geohash_lookup`)
- full polygon mode (`places` + `place_geohash_cover` + `place_geometry`)

### Forward Geocoding

Forward geocoding matches a city name to its canonical entry. Requires a
database generated with the updated schema (see below).

```javascript
geocoder.forward('rome')
  .then(function(result) {
    console.log(result)
  })
```

Returns `undefined` when no match is found, or when using an older database
without the required columns.

### Location Lookup

Look up a city by its GeoNames id:

```javascript
geocoder.location().find(3169070)
geocoder.location.find('geonames:3169070')
```

Returns `undefined` when the id doesn't exist. Both numeric ids and
`geonames:<id>` strings are accepted — use the prefixed form as a stable
grouping key across datasets.

## Expo / React Native

The React Native entrypoint avoids Node-only modules:

```javascript
const createGeocoder = require('offline-geocoder/expo')

const db = await SQLite.openDatabaseAsync('geocoder.sqlite')
const geocoder = createGeocoder({ db: db })

geocoder.reverse(41.89, 12.49)
  .then(function(result) {
    console.log(result)
  })
```

You'll need to bundle the SQLite database file with your app assets and copy
it to a location accessible by `expo-sqlite` on first launch.

## Generating the database

The repo includes a script to generate a SQLite database from GeoNames dumps:

```bash
./scripts/generate_geonames.sh data/geocoder.sqlite
```

Environment variables for customization:

| Variable | Default | Description |
|---|---|---|
| `GEONAMES_DATASET` | `cities1000` | GeoNames dump file to use |
| `GEONAMES_WORKDIR` | current directory | Working directory for temp files |
| `GEONAMES_DOWNLOAD` | `1` | Set to `0` to skip downloads |
| `GEONAMES_FEATURE_CODES` | `PPLA,PPLA2,PPLA3,PPLA4,PPLA5,PPLC` | Feature codes to keep |
| `GEONAMES_MIN_POPULATION` | `0` | Minimum population filter |
| `GEONAMES_INCLUDE_ADMIN1` | `1` | Set to `0` to skip admin1 data |

The default feature codes exclude `PPL` which can include neighbourhood-like
populated places. The schema is defined in [`scripts/schema.sql`](scripts/schema.sql).

### Generating a Boundary Index

Build boundary-aware reverse lookup tables from a polygon source (GeoJSON
FeatureCollection/Feature or newline-delimited GeoJSON):

```bash
node scripts/generate_boundary_index.js \
  --database data/geocoder.sqlite \
  --input data/localities.geojson \
  --index-mode compact \
  --include-region true \
  --min-population 10000 \
  --base-precision 4 \
  --max-precision 7
```

You can also run `npm run build:boundary -- --database ... --input ...`.

You can point the builder directly at directories of WOF GeoJSON files:

```bash
node scripts/generate_boundary_index.js \
  --database data/geocoder.sqlite \
  --input-dir tmp/wof-build/extracted/fr/.../data \
  --index-mode compact \
  --include-region true \
  --min-population 10000 \
  --base-precision 4 \
  --max-precision 7 \
  --drop-contained-localities true
```

`--drop-contained-localities true` removes `locality` polygons that are fully
contained in larger localities within the same country/admin1 group. This is
intended to suppress duplicate neighbourhood-like localities while keeping
small isolated places (for example islands) that are not contained.

Builder notes:

- Keeps current records only (drops deprecated/superseded where source metadata is present)
- Includes `locality` placetypes by default (`localadmin` optional via `--include-localadmin true`)
- Optional `region` fallback polygons via `--include-region true`
- `--min-population` applies to `locality` only, so low-pop localities can roll up to broader admin areas when `region` is included
- Point-only capital localities are retained (single-cell locality fallback) so country/admin capitals are not dropped by polygon-only filtering
- Per-placetype precision caps are supported:
  - `--locality-max-precision`
  - `--localadmin-max-precision`
  - `--region-max-precision`
  - `--region-sparse-max-precision` + `--region-sparse-min-area-km2` for very large sparse regions (for example geohash-3 in Amazon-like interiors)
- `--promote-locality-over-region` (default `true`) prefers locality labels in shared parent cells when there is no competing locality (keeps city labels sticky against region-only outskirts)
- Dominant-city rollup keeps broad city labels sticky in mixed city/suburb cells unless there is competing major-city pressure:
  - `--dominant-locality-population` (default `100000`)
  - `--dominant-locality-ratio` (default `3`)
- Excludes neighbourhood-like placetypes from default reverse output
- `--index-mode compact` (default) stores only geohash-to-place mappings (`compact_geohash_lookup`) and no runtime geometry payloads.
  Compact schema uses `compact_places(id,name,country_id,admin1_id,placetype_code,latitude,longitude)`.
- `--index-mode full` stores geohash cover + geometry for runtime point-in-polygon

### Building From Who's On First (WOF)

Use the WOF helper script to download country admin repos and build in one step:

```bash
WOF_COUNTRIES=FR,IT \
WOF_BASE_PRECISION=4 \
WOF_MAX_PRECISION=5 \
WOF_INCLUDE_REGION=1 \
WOF_MIN_POPULATION=10000 \
./scripts/generate_wof_boundary.sh data/geocoder.sqlite
```

Equivalent npm script:

```bash
npm run build:wof -- data/geocoder.sqlite
```

Useful WOF build env vars:

- `WOF_COUNTRIES` comma-separated country codes (default `FR,IT`)
- `WOF_WORKDIR` working directory for downloads/extracted files (default `tmp/wof-build`)
- `WOF_DOWNLOAD=0` reuse existing archives only
- `WOF_REF` branch/ref to download (default `master`)
- `WOF_LOCALITY_MAX_PRECISION` locality precision cap
- `WOF_REGION_MAX_PRECISION` region precision cap (default `4`)
- `WOF_REGION_SPARSE_MAX_PRECISION` sparse very-large-region precision (default `3`)
- `WOF_REGION_SPARSE_MIN_AREA_KM2` area threshold for sparse region precision (default `80000`)
- `WOF_PROMOTE_LOCALITY_OVER_REGION=1|0` prefer locality labels over region in shared parent cells (default `1`)
- `WOF_DOMINANT_LOCALITY_POPULATION` major-locality threshold for dominant-city rollup (default `100000`)
- `WOF_DOMINANT_LOCALITY_RATIO` dominant-vs-next locality population ratio (default `3`)
- `WOF_GEOMETRY_DECIMALS` round coordinates before storage/indexing (for example `4`)
- `WOF_MIN_POPULATION` filter out places below threshold (for example `10000`)
- `WOF_INCLUDE_REGION=1|0` include/exclude region fallback boundaries
- `WOF_MAX_PLACES` cap places for experiment runs
- `WOF_DROP_CONTAINED_LOCALITIES=1|0` enable/disable contained-locality pruning

Boundary runtime modes:

- `reverseMode: 'centroid'` (default): legacy nearest-centroid reverse lookup
- `reverseMode: 'boundary'`: boundary tables lookup.
  - Uses compact `compact_geohash_lookup` when present (fast geohash-to-place).
  - Falls back to full polygon-aware tables when compact rows are absent.

### External Reverse Validation (LocationIQ)

Use this script to compare local reverse results against LocationIQ at sampled
coordinates, with persistent SQLite caching so requests are not repeated:

```bash
LOCATIONIQ_API_KEY=... node scripts/validate_with_locationiq.js \
  --database tmp/wof-fr-it-compact-p5-d3-pop10k-region.sqlite \
  --samples 300 \
  --export-csv tmp/locationiq-validation-fr-it.csv
```

It creates/updates:

- `sample_points` (coordinates sampled from your geohash table)
- `locationiq_cache` (raw LocationIQ responses keyed by coordinate)
- `validation_results` (local vs LocationIQ comparison verdicts)

Cache DB path is automatic (default behavior): `tmp/locationiq-validation-<database-basename>.sqlite`.

## License

This library is licensed under [the MIT license](https://github.com/lucaspiller/offline-geocoder/blob/master/LICENSE).

You don't need to give this library attribution, but you must do so for
GeoNames if you use their data!
