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
