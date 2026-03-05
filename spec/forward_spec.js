const createGeocoder = require('../src/index.js');
const fixtureDb = require('./helpers/fixture_db');

describe('geocoder.forward', () => {
  var fixture, geocoder;

  beforeAll((done) => {
    fixtureDb.createFixtureDatabase().then(function(f) {
      fixture = f;
      geocoder = createGeocoder({ database: fixture.databasePath });
      done();
    });
  });

  afterAll(() => {
    fixture.cleanup();
  });

  it('returns the best match for an exact query', (done) => {
    geocoder.forward('Rome')
      .then(function(result) {
        expect(result).toEqual({
          id: 3169070,
          name: 'Rome',
          formatted: 'Rome, Latium, Italy',
          country: { id: 'IT', name: 'Italy' },
          admin1: { id: 7, name: 'Latium' },
          coordinates: { latitude: 41.89193, longitude: 12.51133 }
        });
        done();
      });
  });

  it('falls back to fuzzy matching', (done) => {
    geocoder.forward('angeles')
      .then(function(result) {
        expect(result.id).toEqual(5368361);
        done();
      });
  });

  it('returns undefined when nothing matches', (done) => {
    geocoder.forward('xyzzy-not-a-city')
      .then(function(result) {
        expect(result).toBeUndefined();
        done();
      });
  });
});
