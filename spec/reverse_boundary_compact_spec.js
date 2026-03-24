const sqlite3 = require('sqlite3');
const createGeocoder = require('../src/index.js');
const fixtureDb = require('./helpers/fixture_db');

function exec(db, sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => (err ? reject(err) : resolve()));
  });
}

function close(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
}

describe('geocoder.reverse boundary mode (compact geohash lookup)', () => {
  var fixture;
  var geocoder;

  beforeAll((done) => {
    fixtureDb.createFixtureDatabase().then(async function(f) {
      fixture = f;

      const db = new sqlite3.Database(fixture.databasePath);
      try {
        // Force compact-only runtime path in this fixture.
        await exec(db, 'DELETE FROM place_geohash_cover; DELETE FROM place_geometry;');
      } finally {
        await close(db);
      }

      geocoder = createGeocoder({
        database: fixture.databasePath,
        reverseMode: 'boundary',
        boundary: {
          basePrecision: 4,
          maxPrecision: 7
        }
      });

      done();
    });
  });

  afterAll(() => {
    fixture.cleanup();
  });

  it('uses compact geohash lookup for containing areas', (done) => {
    geocoder.reverse(0, -0.5)
      .then(function(result) {
        expect(result.id).toEqual(9100001);
        expect(result.name).toEqual('Westville');
        done();
      });
  });

  it('falls back to nearest boundary centroid when no compact hash matches', (done) => {
    geocoder.reverse(0, 1.5)
      .then(function(result) {
        expect(result.id).toEqual(9100002);
        expect(result.name).toEqual('Eastville');
        done();
      });
  });
});
