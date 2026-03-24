const createGeocoder = require('../src/index.js');
const fixtureDb = require('./helpers/fixture_db');

describe('geocoder.reverse', () => {
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

  it('performs reverse geocoding on a latitude and longitude', (done) => {
    geocoder.reverse(41.89, 12.49)
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

  it("resolves an empty object when a location can't be found", (done) => {
    geocoder.reverse(80, 80)
      .then(function(result) {
        expect(result).toEqual({});
        done();
      });
  });
});
