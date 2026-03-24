"use strict";

const fs = require('fs')
const os = require('os')
const path = require('path')
const sqlite3 = require('sqlite3')

const boundaryCover = require('../../src/boundary_cover')
const geometry = require('../../src/geometry')

const schemaSql = fs.readFileSync(path.join(__dirname, '../../scripts/schema.sql'), 'utf8')

const fixtureSql = `
INSERT INTO countries(id, name) VALUES ('IT', 'Italy'), ('FR', 'France'), ('US', 'United States');
INSERT INTO admin1(country_id, id, name) VALUES
  ('IT', 7, 'Latium'),
  ('FR', 11, 'Ile-de-France'),
  ('US', 36, 'New York'),
  ('US', 5, 'California');
INSERT INTO features(id, name, asciiname, country_id, admin1_id, population) VALUES
  (3169070, 'Rome', 'Rome', 'IT', 7, 2873000),
  (2988507, 'Paris', 'Paris', 'FR', 11, 2138551),
  (5128581, 'New York City', 'New York City', 'US', 36, 8175133),
  (5368361, 'Los Angeles', 'Los Angeles', 'US', 5, 3792621),
  (9100001, 'Westville', 'Westville', 'US', 5, 50000),
  (9100002, 'Eastville', 'Eastville', 'US', 5, 60000),
  (9100003, 'Centerville', 'Centerville', 'US', 5, 20000),
  (9100004, 'Midtown', 'Midtown', 'US', 5, 1000);
INSERT INTO coordinates(feature_id, latitude, longitude) VALUES
  (3169070, 41.89193, 12.51133),
  (2988507, 48.85341, 2.3488),
  (5128581, 40.71427, -74.00597),
  (5368361, 34.05223, -118.24368),
  (9100001, 0, -2),
  (9100002, 0, 0.2),
  (9100003, 0, 0.1),
  (9100004, 0, 0.05);
`

const boundaryFixtures = [
  {
    id: 9100001,
    name: 'Westville',
    countryId: 'US',
    admin1Id: 5,
    placetype: 'locality',
    priorityRank: 20,
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [-1, -1],
        [0, -1],
        [0, 1],
        [-1, 1],
        [-1, -1]
      ]]
    }
  },
  {
    id: 9100002,
    name: 'Eastville',
    countryId: 'US',
    admin1Id: 5,
    placetype: 'locality',
    priorityRank: 30,
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [0, -1],
        [1, -1],
        [1, 1],
        [0, 1],
        [0, -1]
      ]]
    }
  },
  {
    id: 9100003,
    name: 'Centerville',
    countryId: 'US',
    admin1Id: 5,
    placetype: 'locality',
    priorityRank: 10,
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [-0.2, -0.2],
        [0.2, -0.2],
        [0.2, 0.2],
        [-0.2, 0.2],
        [-0.2, -0.2]
      ]]
    }
  },
  {
    id: 9100004,
    name: 'Midtown',
    countryId: 'US',
    admin1Id: 5,
    placetype: 'neighbourhood',
    priorityRank: 1,
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [-0.15, -0.15],
        [0.15, -0.15],
        [0.15, 0.15],
        [-0.15, 0.15],
        [-0.15, -0.15]
      ]]
    }
  }
]

function exec(db, sql) {
  return new Promise(function(resolve, reject) {
    db.exec(sql, function(err) { err ? reject(err) : resolve() })
  })
}

function run(db, sql, params) {
  return new Promise(function(resolve, reject) {
    db.run(sql, params || [], function(err) { err ? reject(err) : resolve() })
  })
}

function close(db) {
  return new Promise(function(resolve, reject) {
    db.close(function(err) { err ? reject(err) : resolve() })
  })
}

async function seedBoundaryData(db) {
  await exec(db, 'BEGIN')

  try {
    var compactByHash = Object.create(null)

    for (var i = 0; i < boundaryFixtures.length; i++) {
      var place = boundaryFixtures[i]
      var normalizedGeometry = geometry.normalizeGeometry(place.geometry)
      var bbox = geometry.geometryBbox(normalizedGeometry)
      var area = geometry.geometryArea(normalizedGeometry)
      var cover = boundaryCover.buildGeohashCoverForGeometry(normalizedGeometry, {
        basePrecision: 4,
        maxPrecision: 7
      })

      await run(db, `
        INSERT INTO places(
          id, name, country_id, admin1_id, placetype,
          centroid_lat, centroid_lon,
          bbox_min_lat, bbox_min_lon, bbox_max_lat, bbox_max_lon,
          priority_rank, area, country_name, admin1_name
        )
        SELECT
          f.id,
          f.name,
          ?,
          ?,
          ?,
          c.latitude,
          c.longitude,
          ?, ?, ?, ?,
          ?, ?,
          'United States',
          'California'
        FROM features f
        JOIN coordinates c ON c.feature_id = f.id
        WHERE f.id = ?
      `, [
        place.countryId,
        place.admin1Id,
        place.placetype,
        bbox.minLat,
        bbox.minLon,
        bbox.maxLat,
        bbox.maxLon,
        place.priorityRank,
        area,
        place.id
      ])

      await run(db, `
        INSERT INTO place_geometry(place_id, encoding, geometry)
        VALUES (?, 'json', ?)
      `, [place.id, JSON.stringify(normalizedGeometry)])

      for (var j = 0; j < cover.length; j++) {
        await run(db, `
          INSERT INTO place_geohash_cover(geohash, precision, place_id, coverage_type)
          VALUES (?, ?, ?, ?)
        `, [cover[j].geohash, cover[j].precision, place.id, cover[j].coverageType])

        if (place.placetype === 'locality' || place.placetype === 'localadmin') {
          var existing = compactByHash[cover[j].geohash]
          if (!existing || place.priorityRank < existing.priorityRank || (place.priorityRank === existing.priorityRank && place.id < existing.placeId)) {
            compactByHash[cover[j].geohash] = {
              placeId: place.id,
              priorityRank: place.priorityRank
            }
          }
        }
      }
    }

    var hashes = Object.keys(compactByHash)
    for (var h = 0; h < hashes.length; h++) {
      var hash = hashes[h]
      await run(db, `
        INSERT INTO place_geohash_lookup(geohash, place_id)
        VALUES (?, ?)
      `, [hash, compactByHash[hash].placeId])
    }

    await exec(db, 'COMMIT')
  } catch (err) {
    await exec(db, 'ROLLBACK')
    throw err
  }
}

function createFixtureDatabase() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-'))
  var dbPath = path.join(dir, 'fixture.sqlite')
  var db = new sqlite3.Database(dbPath)

  return exec(db, schemaSql)
    .then(function() { return exec(db, fixtureSql) })
    .then(function() { return seedBoundaryData(db) })
    .then(function() { return close(db) })
    .then(function() {
      return {
        databasePath: dbPath,
        cleanup: function() {
          fs.rmSync(dir, { recursive: true, force: true })
        }
      }
    })
}

// Minimal shim that looks like an expo-sqlite database so we can test the
// Expo adapter without pulling in the real package.
function createExpoDb(dbPath) {
  var db = new sqlite3.Database(dbPath)
  return {
    getAllAsync: function(sql, params) {
      return new Promise(function(resolve, reject) {
        db.all(sql, params || [], function(err, rows) {
          err ? reject(err) : resolve(rows || [])
        })
      })
    },
    closeAsync: function() { return close(db) }
  }
}

module.exports = {
  createFixtureDatabase: createFixtureDatabase,
  createExpoDb: createExpoDb
}
