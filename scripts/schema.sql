CREATE TABLE coordinates(
  feature_id INTEGER PRIMARY KEY,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL
);

CREATE TABLE features(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  asciiname TEXT,
  country_id TEXT NOT NULL,
  admin1_id INTEGER,
  population INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE admin1(
  country_id TEXT NOT NULL,
  id INTEGER NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (country_id, id)
);

CREATE TABLE countries(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE VIEW everything AS
  SELECT
    features.id AS id,
    features.name AS name,
    features.asciiname AS asciiname,
    features.population AS population,
    admin1.id AS admin1_id,
    admin1.name AS admin1_name,
    countries.id AS country_id,
    countries.name AS country_name,
    coordinates.latitude AS latitude,
    coordinates.longitude AS longitude
  FROM features
    LEFT JOIN countries ON features.country_id = countries.id
    LEFT JOIN admin1 ON features.country_id = admin1.country_id AND features.admin1_id = admin1.id
    JOIN coordinates ON features.id = coordinates.feature_id;

CREATE INDEX coordinates_lat_lng ON coordinates (latitude, longitude);
CREATE INDEX features_name_nocase ON features (name COLLATE NOCASE);
CREATE INDEX features_asciiname_nocase ON features (asciiname COLLATE NOCASE);
CREATE INDEX features_population_desc ON features (population DESC);

CREATE TABLE places(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  country_id TEXT NOT NULL,
  admin1_id INTEGER,
  placetype TEXT NOT NULL,
  centroid_lat REAL NOT NULL,
  centroid_lon REAL NOT NULL,
  bbox_min_lat REAL NOT NULL,
  bbox_min_lon REAL NOT NULL,
  bbox_max_lat REAL NOT NULL,
  bbox_max_lon REAL NOT NULL,
  priority_rank INTEGER NOT NULL DEFAULT 0,
  area REAL NOT NULL DEFAULT 0,
  country_name TEXT,
  admin1_name TEXT
);

CREATE TABLE place_geohash_cover(
  geohash TEXT NOT NULL,
  precision INTEGER NOT NULL,
  place_id INTEGER NOT NULL,
  coverage_type TEXT NOT NULL CHECK (coverage_type IN ('full', 'partial')),
  PRIMARY KEY (geohash, precision, place_id),
  FOREIGN KEY (place_id) REFERENCES places(id)
);

CREATE TABLE place_geometry(
  place_id INTEGER PRIMARY KEY,
  encoding TEXT NOT NULL DEFAULT 'json',
  geometry BLOB NOT NULL,
  FOREIGN KEY (place_id) REFERENCES places(id)
);

CREATE TABLE place_geohash_lookup(
  geohash TEXT PRIMARY KEY,
  place_id INTEGER NOT NULL,
  FOREIGN KEY (place_id) REFERENCES places(id)
);

CREATE INDEX place_geohash_cover_hash_precision ON place_geohash_cover (geohash, precision);
CREATE INDEX place_geohash_cover_place_id ON place_geohash_cover (place_id);
CREATE INDEX places_placetype ON places (placetype);
CREATE INDEX place_geometry_place_id ON place_geometry (place_id);
CREATE INDEX place_geohash_lookup_place_id ON place_geohash_lookup (place_id);
