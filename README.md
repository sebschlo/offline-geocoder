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

## License

This library is licensed under [the MIT license](https://github.com/lucaspiller/offline-geocoder/blob/master/LICENSE).

You don't need to give this library attribution, but you must do so for
GeoNames if you use their data!
