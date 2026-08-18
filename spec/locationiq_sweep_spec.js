const fs = require('fs');
const os = require('os');
const path = require('path');

const liq = require('../scripts/validate_with_locationiq');

const WORLD_POINTS = [
  { lat: 13.6929, lon: -89.2182, country: 'SV', name: 'San Salvador', population: 525990 },
  { lat: 13.4767, lon: -89.3072, country: 'SV', name: 'Nuevo Cuscatlan', population: 7000 },
  { lat: 14.6349, lon: -90.5069, country: 'GT', name: 'Guatemala City', population: 994938 },
  { lat: 48.1374, lon: 11.5755, country: 'DE', name: 'Munich', population: 1260391 },
  { lat: 55.7522, lon: 37.6156, country: 'RU', name: 'Moscow', population: 10381222 }
];

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-liq-sweep-'));
}

function geonamesRow(id, name, lat, lon, featureClass, country, population) {
  const cols = new Array(19).fill('');
  cols[0] = String(id);
  cols[1] = name;
  cols[2] = name;
  cols[4] = String(lat);
  cols[5] = String(lon);
  cols[6] = featureClass;
  cols[7] = 'PPL';
  cols[8] = country;
  cols[14] = String(population);
  return cols.join('\t');
}

function writePointsFile(dir, points) {
  const file = path.join(dir, 'points.jsonl');
  fs.writeFileSync(file, points.map((p) => JSON.stringify(p)).join('\n') + '\n');
  return file;
}

function sweepOpts(dir, overrides) {
  return Object.assign({
    pointsPath: path.join(dir, 'points.jsonl'),
    cachePath: path.join(dir, 'cache.jsonl'),
    statePath: path.join(dir, 'quota.json'),
    reportPath: path.join(dir, 'report.md'),
    mismatchesPath: path.join(dir, 'mismatches.jsonl'),
    databaseLabel: 'fixture.sqlite',
    apiKey: 'test-key',
    endpoint: 'https://liq.invalid/v1/reverse',
    acceptLanguage: 'en',
    dailyCap: 4500,
    rps: 1000,
    maxRequests: null,
    dryRun: false
  }, overrides || {});
}

function okResponse(address, displayName) {
  return { status: 200, json: { display_name: displayName || '', address } };
}

function makeDeps(fetchHandler, reverseHandler) {
  const deps = {
    calls: [],
    fetchJson: async (url) => {
      deps.calls.push(url);
      return fetchHandler(url, deps.calls.length);
    },
    reverse: async (lat, lon) => (reverseHandler
      ? reverseHandler(lat, lon)
      : { name: 'Testville', country: { id: 'US', name: 'United States' } }),
    sleep: async () => {},
    log: () => {}
  };
  return deps;
}

function readState(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'quota.json'), 'utf8'));
}

function cacheLines(dir) {
  const file = path.join(dir, 'cache.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim());
}

function point(overrides) {
  return Object.assign({
    key: '13.4767,-89.3072',
    lat: 13.4767,
    lon: -89.3072,
    country: 'SV',
    name: 'Sample Place'
  }, overrides || {});
}

describe('locationiq sweep', () => {
  describe('sample generator', () => {
    it('selects the top places per country by population and emits point fields', () => {
      const tsv = [
        geonamesRow(1, 'Smallville', 40.1, -100.1, 'P', 'US', 100),
        geonamesRow(2, 'Bigville', 40.2, -100.2, 'P', 'US', 500),
        geonamesRow(3, 'Midville', 40.3, -100.3, 'P', 'US', 300),
        geonamesRow(4, 'Pueblo Grande', 20.1, -99.1, 'P', 'MX', 400),
        geonamesRow(5, 'Pueblo Chico', 20.2, -99.2, 'P', 'MX', 50)
      ].join('\n');

      const result = liq.buildSamplePoints(tsv, 2, null);

      expect(result.parsed).toEqual(5);
      expect(result.skipped).toEqual(0);
      expect(result.points.map((p) => p.name)).toEqual([
        'Pueblo Grande', 'Pueblo Chico', 'Bigville', 'Midville'
      ]);
      expect(result.points[0]).toEqual({
        lat: 20.1, lon: -99.1, country: 'MX', name: 'Pueblo Grande', population: 400
      });
    });

    it('applies a total cap round-robin by rank so every country keeps coverage', () => {
      const tsv = [
        geonamesRow(1, 'US One', 40.1, -100.1, 'P', 'US', 500),
        geonamesRow(2, 'US Two', 40.2, -100.2, 'P', 'US', 400),
        geonamesRow(3, 'MX One', 20.1, -99.1, 'P', 'MX', 300),
        geonamesRow(4, 'MX Two', 20.2, -99.2, 'P', 'MX', 200)
      ].join('\n');

      const result = liq.buildSamplePoints(tsv, 2, 3);

      expect(result.points.length).toEqual(3);
      const byCountry = result.points.reduce((acc, p) => {
        acc[p.country] = (acc[p.country] || 0) + 1;
        return acc;
      }, {});
      expect(byCountry.US).toEqual(1);
      expect(byCountry.MX).toEqual(2);
      expect(result.points.some((p) => p.name === 'US One')).toBeTrue();
      expect(result.points.some((p) => p.name === 'US Two')).toBeFalse();
    });

    it('skips non-P feature classes and malformed rows', () => {
      const tsv = [
        geonamesRow(1, 'Cityville', 40.1, -100.1, 'P', 'US', 100),
        geonamesRow(2, 'Some Region', 41.0, -101.0, 'A', 'US', 99999),
        geonamesRow(3, 'Bad Latitude', 999, -100.0, 'P', 'US', 100),
        'too\tfew\tcolumns'
      ].join('\n');

      const result = liq.buildSamplePoints(tsv, 25, null);

      expect(result.parsed).toEqual(1);
      expect(result.skipped).toEqual(3);
      expect(result.points.map((p) => p.name)).toEqual(['Cityville']);
    });
  });

  describe('name comparison', () => {
    it('normalizes case, diacritics and non-Latin scripts', () => {
      expect(liq.normalizeName('Kilómetro 18')).toEqual('kilometro 18');
      expect(liq.normalizeName('MÜNCHEN')).toEqual('munchen');
      expect(liq.normalizeName('São Paulo')).toEqual('sao paulo');
      expect(liq.normalizeName('Москва')).toEqual('москва');
    });

    it('agrees when the offline name matches a locality field after normalization', () => {
      const record = liq.comparePoint(
        point({ name: 'Kilómetro 18' }),
        { name: 'Kilómetro 18', country: { id: 'SV' } },
        { status: 200, body: { display_name: 'Kilometro 18, El Salvador', address: { village: 'Kilometro 18', country_code: 'sv' } } }
      );

      expect(record.verdict).toEqual('agree');
      expect(record.match_via).toEqual('village');
    });

    it('agrees when the offline name matches the county or state instead of the locality', () => {
      const countyRecord = liq.comparePoint(
        point(),
        { name: 'Sacatepéquez', country: { id: 'GT' } },
        { status: 200, body: { display_name: '', address: { city: 'Antigua Guatemala', county: 'Sacatepequez', country_code: 'gt' } } }
      );
      expect(countyRecord.verdict).toEqual('agree');
      expect(countyRecord.match_via).toEqual('county');

      const stateRecord = liq.comparePoint(
        point(),
        { name: 'La Libertad', country: { id: 'SV' } },
        { status: 200, body: { display_name: '', address: { city: 'Zaragoza', state: 'La Libertad', country_code: 'sv' } } }
      );
      expect(stateRecord.verdict).toEqual('agree');
      expect(stateRecord.match_via).toEqual('state');
    });

    it('flags country mismatches as severe even when the names agree', () => {
      const record = liq.comparePoint(
        point({ country: 'GT' }),
        { name: 'Tecún Umán', country: { id: 'GT' } },
        { status: 200, body: { display_name: '', address: { city: 'Tecun Uman', country_code: 'mx' } } }
      );

      expect(record.verdict).toEqual('country_mismatch');
    });

    it('classifies name mismatches and empty answers', () => {
      const nameMismatch = liq.comparePoint(
        point(),
        { name: 'Zaragoza', country: { id: 'SV' } },
        { status: 200, body: { display_name: 'Nuevo Cuscatlan, La Libertad, El Salvador', address: { city: 'Nuevo Cuscatlan', country_code: 'sv' } } }
      );
      expect(nameMismatch.verdict).toEqual('name_mismatch');

      const offlineEmpty = liq.comparePoint(
        point(),
        null,
        { status: 200, body: { display_name: '', address: { city: 'Somewhere', country_code: 'sv' } } }
      );
      expect(offlineEmpty.verdict).toEqual('offline_empty');

      const liqEmpty = liq.comparePoint(
        point(),
        { name: 'Zaragoza', country: { id: 'SV' } },
        { status: 404, body: { error: 'Unable to geocode' } }
      );
      expect(liqEmpty.verdict).toEqual('liq_empty');

      const bothEmpty = liq.comparePoint(
        point(),
        null,
        { status: 404, body: { error: 'Unable to geocode' } }
      );
      expect(bothEmpty.verdict).toEqual('both_empty');
    });
  });

  describe('runSweep', () => {
    it('stops at the daily cap, persists quota state, and resumes when the cap allows', async () => {
      const dir = makeTmpDir();
      try {
        writePointsFile(dir, WORLD_POINTS);
        const respond = () => okResponse({ city: 'Testville', country_code: 'us' }, 'Testville');

        const first = makeDeps(respond);
        const summary = await liq.runSweep(sweepOpts(dir, { dailyCap: 3 }), first);
        expect(first.calls.length).toEqual(3);
        expect(first.calls[0]).toContain('key=test-key');
        expect(first.calls[0]).toContain('accept-language=en');
        expect(summary.stopReason).toEqual('daily_cap');
        expect(summary.requestsThisRun).toEqual(3);
        expect(cacheLines(dir).length).toEqual(3);

        const state = readState(dir);
        expect(state.date).toEqual(liq.utcDateString(new Date()));
        expect(state.count).toEqual(3);

        // Same UTC day, same cap: a new invocation must not spend any requests.
        const second = makeDeps(respond);
        const summary2 = await liq.runSweep(sweepOpts(dir, { dailyCap: 3 }), second);
        expect(second.calls.length).toEqual(0);
        expect(summary2.stopReason).toEqual('daily_cap');
        expect(readState(dir).count).toEqual(3);

        // A raised cap resumes, fetching only the uncached points.
        const third = makeDeps(respond);
        const summary3 = await liq.runSweep(sweepOpts(dir, { dailyCap: 10 }), third);
        expect(third.calls.length).toEqual(2);
        expect(summary3.stopReason).toBeNull();
        expect(summary3.evaluated).toEqual(5);
        expect(readState(dir).count).toEqual(5);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('never re-queries points that already have a cached response', async () => {
      const dir = makeTmpDir();
      try {
        writePointsFile(dir, WORLD_POINTS);
        const cached = {
          key: liq.sweepCoordKey(WORLD_POINTS[0].lat, WORLD_POINTS[0].lon),
          lat: WORLD_POINTS[0].lat,
          lon: WORLD_POINTS[0].lon,
          status: 200,
          body: { display_name: 'San Salvador, El Salvador', address: { city: 'San Salvador', country_code: 'sv' } }
        };
        fs.writeFileSync(path.join(dir, 'cache.jsonl'), JSON.stringify(cached) + '\n');

        const deps = makeDeps(() => okResponse({ city: 'Testville', country_code: 'us' }));
        const summary = await liq.runSweep(sweepOpts(dir), deps);

        expect(deps.calls.length).toEqual(4);
        expect(deps.calls.some((url) => url.includes('lat=13.6929'))).toBeFalse();
        expect(summary.evaluated).toEqual(5);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('resets the persisted quota count on a new UTC day', async () => {
      const dir = makeTmpDir();
      try {
        writePointsFile(dir, WORLD_POINTS);
        fs.writeFileSync(path.join(dir, 'quota.json'), JSON.stringify({ date: '2000-01-01', count: 4500 }) + '\n');

        const deps = makeDeps(() => okResponse({ city: 'Testville', country_code: 'us' }));
        const summary = await liq.runSweep(sweepOpts(dir), deps);

        expect(deps.calls.length).toEqual(5);
        expect(summary.stopReason).toBeNull();
        const state = readState(dir);
        expect(state.date).toEqual(liq.utcDateString(new Date()));
        expect(state.count).toEqual(5);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('backs off and stops cleanly on HTTP 429 without caching the failure', async () => {
      const dir = makeTmpDir();
      try {
        writePointsFile(dir, WORLD_POINTS);
        const deps = makeDeps((url, callNumber) => {
          if (callNumber === 1) return okResponse({ city: 'Testville', country_code: 'us' });
          return { status: 429, json: { error: 'Rate Limited Second' } };
        });

        const summary = await liq.runSweep(sweepOpts(dir), deps);

        expect(deps.calls.length).toEqual(2);
        expect(summary.stopReason).toEqual('rate_limited');
        expect(cacheLines(dir).length).toEqual(1);
        expect(summary.evaluated).toEqual(1);
        // The failed attempt still counts against the persisted quota.
        expect(readState(dir).count).toEqual(2);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('evaluates the cache without any network calls in dry-run mode', async () => {
      const dir = makeTmpDir();
      try {
        writePointsFile(dir, WORLD_POINTS);
        const cached = {
          key: liq.sweepCoordKey(WORLD_POINTS[0].lat, WORLD_POINTS[0].lon),
          lat: WORLD_POINTS[0].lat,
          lon: WORLD_POINTS[0].lon,
          status: 200,
          body: { display_name: '', address: { city: 'Testville', country_code: 'us' } }
        };
        fs.writeFileSync(path.join(dir, 'cache.jsonl'), JSON.stringify(cached) + '\n');

        const deps = makeDeps(() => {
          throw new Error('dry-run must not touch the network');
        });
        const summary = await liq.runSweep(sweepOpts(dir, { dryRun: true, apiKey: '' }), deps);

        expect(deps.calls.length).toEqual(0);
        expect(summary.evaluated).toEqual(1);
        expect(summary.unfetched).toEqual(4);
        expect(fs.existsSync(path.join(dir, 'report.md'))).toBeTrue();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('writes the per-country Markdown report and the mismatch JSONL', async () => {
      const dir = makeTmpDir();
      try {
        writePointsFile(dir, [
          { lat: 13.6929, lon: -89.2182, country: 'SV', name: 'San Salvador' },
          { lat: 13.4767, lon: -89.3072, country: 'SV', name: 'Nuevo Cuscatlan' },
          { lat: 14.6349, lon: -90.5069, country: 'GT', name: 'Guatemala City' }
        ]);

        const responses = {
          '13.6929': okResponse({ city: 'San Salvador', country_code: 'sv' }, 'San Salvador, El Salvador'),
          '13.4767': okResponse({ city: 'Nuevo Cuscatlan', country_code: 'sv' }, 'Nuevo Cuscatlan, El Salvador'),
          '14.6349': okResponse({ city: 'Guatemala City', country_code: 'gt' }, 'Guatemala City, Guatemala')
        };
        const offline = {
          '13.6929': { name: 'San Salvador', country: { id: 'SV' } },
          '13.4767': { name: 'Zaragoza', country: { id: 'SV' } },
          '14.6349': { name: 'Tapachula', country: { id: 'MX' } }
        };
        const deps = makeDeps(
          (url) => responses[new URL(url).searchParams.get('lat')],
          (lat) => offline[String(lat)]
        );

        const summary = await liq.runSweep(sweepOpts(dir), deps);

        expect(summary.evaluated).toEqual(3);
        expect(summary.verdictCounts).toEqual({ agree: 1, name_mismatch: 1, country_mismatch: 1 });
        expect(summary.mismatchCount).toEqual(2);

        const report = fs.readFileSync(path.join(dir, 'report.md'), 'utf8');
        expect(report).toContain('- Verifiable points: 3 — agreement 1/3 (33.3%)');
        expect(report).toContain('| GT | 1 | 1 | 0.0% | 1 | 0 |');
        expect(report).toContain('| SV | 2 | 2 | 50.0% | 0 | 1 |');
        // GT (100% mismatch) must rank above SV (50% mismatch).
        expect(report.indexOf('| GT |')).toBeLessThan(report.indexOf('| SV |'));
        expect(report).toContain('## Worst examples');
        expect(report).toContain('country_mismatch');
        expect(report).toContain('14.6349');

        const mismatches = fs.readFileSync(path.join(dir, 'mismatches.jsonl'), 'utf8')
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line));
        expect(mismatches.length).toEqual(2);
        expect(mismatches.map((m) => m.verdict).sort()).toEqual(['country_mismatch', 'name_mismatch']);
        const severe = mismatches.find((m) => m.verdict === 'country_mismatch');
        expect(severe.offline_name).toEqual('Tapachula');
        expect(severe.liq_name).toEqual('Guatemala City');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
