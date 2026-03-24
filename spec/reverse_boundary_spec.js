const createGeocoder = require('../src/index.js');
const fixtureDb = require('./helpers/fixture_db');

describe('geocoder.reverse boundary mode', () => {
  var fixture;
  var geocoder;

  beforeAll((done) => {
    fixtureDb.createFixtureDatabase().then(function(f) {
      fixture = f;
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

  it('chooses containing locality polygons instead of nearest centroids', (done) => {
    geocoder.reverse(0, -0.5)
      .then(function(result) {
        expect(result.id).toEqual(9100001);
        expect(result.name).toEqual('Westville');
        done();
      });
  });

  it('uses deterministic tie-breakers and ignores neighbourhood placetypes', (done) => {
    geocoder.reverse(0.1, 0.1)
      .then(function(result) {
        expect(result.id).toEqual(9100003);
        expect(result.name).toEqual('Centerville');
        done();
      });
  });

  it('falls back to nearest boundary centroid when no polygon contains the point', (done) => {
    geocoder.reverse(0, 1.5)
      .then(function(result) {
        expect(result.id).toEqual(9100002);
        expect(result.name).toEqual('Eastville');
        done();
      });
  });
});
