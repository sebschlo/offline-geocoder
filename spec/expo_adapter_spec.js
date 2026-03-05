const createExpoGeocoder = require('../src/expo.js');
const fixtureDb = require('./helpers/fixture_db');

describe('expo adapter', () => {
  var fixture;

  beforeAll((done) => {
    fixtureDb.createFixtureDatabase().then(function(f) {
      fixture = f;
      done();
    });
  });

  afterAll(() => {
    fixture.cleanup();
  });

  it('runs queries through the getAllAsync shim', (done) => {
    var db = fixtureDb.createExpoDb(fixture.databasePath);
    var geocoder = createExpoGeocoder({ db: db });

    geocoder.reverse(41.89, 12.49)
      .then(function(result) {
        expect(result.id).toEqual(3169070);
        done();
      });
  });
});
