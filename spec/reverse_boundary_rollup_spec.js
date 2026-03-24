const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const createGeocoder = require('../src/index.js');

describe('geocoder.reverse boundary mode (locality roll-up)', () => {
  var dir;
  var dbPath;
  var geocoder;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-rollup-'));
    const inputPath = path.join(dir, 'rollup.geojson');
    dbPath = path.join(dir, 'rollup.sqlite');

    fs.writeFileSync(inputPath, JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 4001,
          properties: {
            name: 'Macro Region',
            placetype: 'region',
            country_id: 'US',
            admin1_id: 5,
            is_current: 1
          },
          geometry: {
            type: 'Polygon',
            coordinates: [[[-6, -6], [6, -6], [6, 6], [-6, 6], [-6, -6]]]
          }
        },
        {
          type: 'Feature',
          id: 4002,
          properties: {
            name: 'Tiny Hamlet',
            placetype: 'locality',
            country_id: 'US',
            admin1_id: 5,
            population: 800,
            is_current: 1
          },
          geometry: {
            type: 'Polygon',
            coordinates: [[[-0.8, -0.8], [0.8, -0.8], [0.8, 0.8], [-0.8, 0.8], [-0.8, -0.8]]]
          }
        },
        {
          type: 'Feature',
          id: 4003,
          properties: {
            name: 'Big City',
            placetype: 'locality',
            country_id: 'US',
            admin1_id: 5,
            population: 90000,
            is_current: 1
          },
          geometry: {
            type: 'Polygon',
            coordinates: [[[2, 2], [3.5, 2], [3.5, 3.5], [2, 3.5], [2, 2]]]
          }
        }
      ]
    }));

    const result = spawnSync('node', [
      path.join(__dirname, '..', 'scripts', 'generate_boundary_index.js'),
      '--database', dbPath,
      '--input', inputPath,
      '--index-mode', 'compact',
      '--include-region', 'true',
      '--min-population', '5000',
      '--base-precision', '4',
      '--max-precision', '5'
    ], { encoding: 'utf8' });

    expect(result.status).toEqual(0);

    geocoder = createGeocoder({
      database: dbPath,
      reverseMode: 'boundary',
      boundary: {
        basePrecision: 4,
        maxPrecision: 5
      }
    });
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns region for low-pop locality area when locality is rolled up', (done) => {
    geocoder.reverse(0, 0)
      .then(function(result) {
        expect(result.id).toEqual(4001);
        expect(result.name).toEqual('Macro Region');
        done();
      });
  });

  it('keeps higher-pop locality labels where available', (done) => {
    geocoder.reverse(2.7, 2.7)
      .then(function(result) {
        expect(result.id).toEqual(4003);
        expect(result.name).toEqual('Big City');
        done();
      });
  });
});
