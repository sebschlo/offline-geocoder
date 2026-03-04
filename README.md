# Offline Geocoder

Offline city-level geocoding for Node and Expo/React Native.

- Fully offline: no network requests.
- Reverse lookup: coordinates -> nearest city.
- Forward lookup: query -> best canonical city.
- Stable identifiers for grouping: `geonames:<id>`.

GeoNames data is licensed under [CC BY 3.0](http://creativecommons.org/licenses/by/3.0/).

## Installation

```bash
npm install offline-geocoder
```

For Node usage, also install `sqlite3` in your app:

```bash
npm install sqlite3
```

For Expo usage, install Expo SQLite in your app:

```bash
npx expo install expo-sqlite
```

## API

All lookups are deterministic and return the same normalized shape:

```js
{
  id: 3169070,
  name: "Rome",
  formatted: "Rome, Latium, Italy",
  country: { id: "IT", name: "Italy" },
  admin1: { id: 7, name: "Latium" },
  coordinates: { latitude: 41.89193, longitude: 12.51133 }
}
```

Methods:

- `reverse(latitude, longitude)` -> nearest city, or `{}` when no match
- `forward(query)` -> best canonical city, or `undefined` when no match
- `location.find(id)` -> city by id, or `undefined`

`location.find` accepts either numeric ids (`3169070`) or stable ids (`"geonames:3169070"`).  
For grouping keys, use `geonames:${result.id}`.

## Node usage

```js
const createGeocoder = require("offline-geocoder");

const geocoder = createGeocoder({ database: "data/geocoder.sqlite" });

const city = await geocoder.reverse(41.89, 12.49);
const canonical = await geocoder.forward("rome");
const byId = await geocoder.location.find("geonames:3169070");
```

## Expo / React Native usage

The React Native entrypoint avoids Node-only modules.

```js
import createExpoGeocoder from "offline-geocoder";
import * as SQLite from "expo-sqlite";

const db = await SQLite.openDatabaseAsync("geocoder.sqlite");
const geocoder = createExpoGeocoder({ db });

const city = await geocoder.reverse(41.89, 12.49);
const canonical = await geocoder.forward("rome");
```

### Bundling the DB in Expo

1. Generate a SQLite DB file (see next section).
2. Add the DB to your app assets (for example `assets/geocoder.sqlite`).
3. Copy it to `SQLite/` in app storage on first launch (if not already copied).
4. Open the copied DB via `expo-sqlite`.

This library does not copy files for you and does not include online fallbacks.

## Generating the database

The repo includes an updated generator for current GeoNames dumps.

```bash
./scripts/generate_geonames.sh data/geocoder.sqlite
```

Optional environment variables:

- `GEONAMES_DATASET` (`cities1000` by default)
- `GEONAMES_WORKDIR` (output/work directory)
- `GEONAMES_DOWNLOAD=0` to use existing local files only (place them in `.geonames-build/source` under `GEONAMES_WORKDIR`)

Schema definition is in [`scripts/schema.sql`](scripts/schema.sql), including indexes for:

- Reverse lookup (`coordinates_lat_lng`)
- Forward lookup (`features_name_nocase`, `features_asciiname_nocase`, `features_population_desc`)

## Migration notes (from the old API)

- `forward(query)` was added.
- Use `geonames:${result.id}` as the stable grouping key.
- `location.find(id)` is available directly.
- Package now has an Expo/RN entrypoint (`react-native` export).
- Node runtime no longer hardcodes `sqlite3` in shared code paths; Node uses a dedicated adapter.

## License

MIT for this library, GeoNames attribution required for data usage.
