const sqlite3 = require('sqlite3');
const fixtureDb = require('./helpers/fixture_db');

describe('generated schema', () => {
  var fixture, db;

  beforeAll((done) => {
    fixtureDb.createFixtureDatabase().then(function(f) {
      fixture = f;
      db = new sqlite3.Database(fixture.databasePath);
      done();
    });
  });

  afterAll((done) => {
    db.close(function() {
      fixture.cleanup();
      done();
    });
  });

  it('has asciiname and population in the everything view', (done) => {
    db.all('PRAGMA table_info(everything)', [], function(err, cols) {
      var names = cols.map(function(c) { return c.name });
      expect(names).toContain('asciiname');
      expect(names).toContain('population');
      done();
    });
  });

  it('creates indexes for reverse and forward lookups', (done) => {
    db.all("PRAGMA index_list('coordinates')", [], function(err, coordIndexes) {
      db.all("PRAGMA index_list('features')", [], function(err, featIndexes) {
        db.all("PRAGMA index_list('place_geohash_cover')", [], function(err, boundaryIndexes) {
          db.all("PRAGMA index_list('place_geohash_lookup')", [], function(err, compactIndexes) {
          var coordNames = coordIndexes.map(function(i) { return i.name });
          var featNames = featIndexes.map(function(i) { return i.name });
          var boundaryNames = boundaryIndexes.map(function(i) { return i.name });
          var compactNames = compactIndexes.map(function(i) { return i.name });

          expect(coordNames).toContain('coordinates_lat_lng');
          expect(featNames).toContain('features_name_nocase');
          expect(featNames).toContain('features_asciiname_nocase');
          expect(featNames).toContain('features_population_desc');
          expect(boundaryNames).toContain('place_geohash_cover_hash_precision');
          expect(boundaryNames).toContain('place_geohash_cover_place_id');
          expect(compactNames).toContain('place_geohash_lookup_place_id');
          done();
          });
        });
      });
    });
  });

  it('includes boundary lookup tables', (done) => {
    db.all("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('places', 'place_geohash_cover', 'place_geometry', 'place_geohash_lookup')", [], function(err, rows) {
      var names = rows.map(function(row) { return row.name });
      expect(names).toContain('places');
      expect(names).toContain('place_geohash_cover');
      expect(names).toContain('place_geometry');
      expect(names).toContain('place_geohash_lookup');
      done();
    });
  });
});
