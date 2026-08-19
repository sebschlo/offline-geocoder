const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

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

function cacheEntries(dir) {
  return cacheLines(dir)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        return null;
      }
    })
    .filter((entry) => entry && entry.key);
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
      // With a cap of 3 over 2 countries, both keep their top place and
      // exactly one (shuffle-determined) country gets its second.
      expect(byCountry.US).toBeGreaterThanOrEqual(1);
      expect(byCountry.MX).toBeGreaterThanOrEqual(1);
      expect(byCountry.US + byCountry.MX).toEqual(3);
      expect(result.points.some((p) => p.name === 'US One')).toBeTrue();
      expect(result.points.some((p) => p.name === 'MX One')).toBeTrue();
    });

    it('spreads a cap below the country count over a deterministic non-alphabetical subset', () => {
      const codes = ['AA', 'AB', 'AC', 'AD', 'AE', 'AF', 'AG', 'AH', 'AI', 'AJ'];
      const tsv = codes
        .map((code, i) => geonamesRow(i + 1, code + ' City', i, i, 'P', code, 100))
        .join('\n');

      const first = liq.buildSamplePoints(tsv, 1, 5);
      expect(first.points.length).toEqual(5);
      expect(first.countriesTotal).toEqual(10);
      const selected = first.points.map((p) => p.country);
      // An alphabetical fill would always drop the same alphabet-late
      // countries; the shuffled order must not equal the alphabetical prefix.
      expect(selected).not.toEqual(['AA', 'AB', 'AC', 'AD', 'AE']);
      // ...but it must be deterministic so re-generated points files match.
      const second = liq.buildSamplePoints(tsv, 1, 5);
      expect(second.points.map((p) => p.country)).toEqual(selected);
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

    it('preserves essential Unicode marks while stripping optional vocalization', () => {
      // Devanagari vowel signs are combining marks but essential: stripping
      // them would collapse different names into false agreements.
      expect(liq.normalizeName('किला')).toEqual('किला');
      expect(liq.normalizeName('किला')).not.toEqual(liq.normalizeName('कुल'));
      // Arabic harakat and Hebrew niqqud are optional vocalization: the same
      // name with and without them must compare equal.
      expect(liq.normalizeName('مُحَمَّد')).toEqual(liq.normalizeName('محمد'));
      expect(liq.normalizeName('יְרוּשָׁלַיִם')).toEqual(liq.normalizeName('ירושלים'));
    });

    it('strips combining diacritics only from Latin bases, keeping Cyrillic letters distinct', () => {
      // NFKD decomposes these into base + U+0300-block marks; stripping the
      // mark unconditionally would collapse distinct letters (й→и, ё→е, ї→і).
      expect(liq.normalizeName('й')).not.toEqual(liq.normalizeName('и'));
      expect(liq.normalizeName('ё')).not.toEqual(liq.normalizeName('е'));
      expect(liq.normalizeName('ї')).not.toEqual(liq.normalizeName('і'));
      // Precomposed and decomposed spellings of the same letter still agree.
      expect(liq.normalizeName('й')).toEqual(liq.normalizeName('й'));
      expect(liq.normalizeName('Йошкар-Ола')).toEqual(liq.normalizeName('йошкар ола'));
      // Latin diacritics still fold.
      expect(liq.normalizeName('São Paulo')).toEqual('sao paulo');
    });

    it('keeps Arabic hamza and maddah distinctions while stripping harakat', () => {
      // NFKD decomposes أ/إ/آ into alef + U+0653-0655; those marks are
      // orthographically essential, so distinct names must stay distinct.
      expect(liq.normalizeName('أمل')).not.toEqual(liq.normalizeName('امل'));
      expect(liq.normalizeName('إربد')).not.toEqual(liq.normalizeName('اربد'));
      expect(liq.normalizeName('آزاد')).not.toEqual(liq.normalizeName('ازاد'));
      // Precomposed hamza letters equal their decomposed spellings.
      expect(liq.normalizeName('أ')).toEqual(liq.normalizeName('أ'));
      // True harakat remain optional vocalization.
      expect(liq.normalizeName('مُحَمَّد')).toEqual(liq.normalizeName('محمد'));
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

    it('marks points country_unknown when either side lacks a country code', () => {
      // LocationIQ answered with a matching locality but no country_code:
      // the severe check cannot run, and the name match alone must not be
      // counted as agreement.
      const missingLiq = liq.comparePoint(
        point(),
        { name: 'Zaragoza', country: { id: 'SV' } },
        { status: 200, body: { display_name: 'Zaragoza', address: { city: 'Zaragoza' } } }
      );
      expect(missingLiq.verdict).toEqual('country_unknown');
      expect(missingLiq.match_via).toEqual('city');

      const missingOffline = liq.comparePoint(
        point(),
        { name: 'Zaragoza' },
        { status: 200, body: { display_name: '', address: { city: 'Zaragoza', country_code: 'sv' } } }
      );
      expect(missingOffline.verdict).toEqual('country_unknown');

      // The report treats these as unverifiable, not as agreement.
      const report = liq.buildSweepReport({
        generatedAt: 'now',
        databaseLabel: 'db',
        pointsPath: 'points.jsonl',
        totalPoints: 1,
        unfetched: 0,
        records: [missingLiq],
        quota: { date: '2026-08-18', count: 0 },
        dailyCap: 4500,
        stopReason: null,
        stopDetail: ''
      });
      expect(report).toContain('- Verifiable points: 0 — agreement 0/0 (0.0%)');
      expect(report).toContain('country unknown 1');
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
        expect(cacheEntries(dir).length).toEqual(3);

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
        expect(cacheEntries(dir).length).toEqual(1);
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

    it('fails closed without spending requests when the quota state file is unreadable', async () => {
      const dir = makeTmpDir();
      try {
        writePointsFile(dir, WORLD_POINTS);
        // A truncated write (e.g. the process died mid-save) leaves invalid
        // JSON behind. Resetting to zero here would allow a fresh full cap.
        fs.writeFileSync(path.join(dir, 'quota.json'), '{"date":"2026-');

        const deps = makeDeps(() => okResponse({ city: 'Testville', country_code: 'us' }));
        await expectAsync(liq.runSweep(sweepOpts(dir), deps)).toBeRejectedWithError(/quota state/i);
        expect(deps.calls.length).toEqual(0);

        // Same for structurally invalid but parseable content.
        fs.writeFileSync(path.join(dir, 'quota.json'), JSON.stringify({ foo: 1 }));
        await expectAsync(liq.runSweep(sweepOpts(dir), deps)).toBeRejectedWithError(/quota state/i);
        expect(deps.calls.length).toEqual(0);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('rejects invalid quota options instead of running uncapped', async () => {
      expect(() => liq.parseSweepArgs(['--daily-cap', 'lots'])).toThrowError(/--daily-cap/);
      expect(() => liq.parseSweepArgs(['--daily-cap'])).toThrowError(/--daily-cap/);
      expect(() => liq.parseSweepArgs(['--rps', 'fast'])).toThrowError(/--rps/);
      expect(() => liq.parseSweepArgs(['--max-requests', 'many'])).toThrowError(/--max-requests/);

      // Defense in depth: runSweep itself refuses a NaN cap before fetching.
      const dir = makeTmpDir();
      try {
        writePointsFile(dir, WORLD_POINTS);
        const deps = makeDeps(() => okResponse({ city: 'Testville', country_code: 'us' }));
        await expectAsync(liq.runSweep(sweepOpts(dir, { dailyCap: NaN }), deps)).toBeRejectedWithError(/dailyCap/);
        expect(deps.calls.length).toEqual(0);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('rejects unsupported --reverse-mode values instead of silently mapping them', () => {
      expect(() => liq.parseSweepArgs(['--reverse-mode', 'centriod'])).toThrowError(/--reverse-mode/);
      expect(() => liq.parseSweepArgs(['--reverse-mode'])).toThrowError(/--reverse-mode/);
      expect(liq.parseSweepArgs(['--reverse-mode', 'centroid']).reverseMode).toEqual('centroid');
      expect(liq.parseSweepArgs(['--reverse-mode', 'Boundary']).reverseMode).toEqual('boundary');
    });

    it('rolls quota state over when the UTC day changes mid-run', async () => {
      const dir = makeTmpDir();
      try {
        writePointsFile(dir, WORLD_POINTS);
        // now() is called once at startup, then once per attempt: the first
        // two attempts happen before midnight UTC, the last three after.
        let nowCalls = 0;
        const deps = makeDeps(() => okResponse({ city: 'Testville', country_code: 'us' }));
        deps.now = () => {
          nowCalls += 1;
          return nowCalls <= 3
            ? new Date('2026-01-01T23:59:00Z')
            : new Date('2026-01-02T00:00:30Z');
        };

        const summary = await liq.runSweep(sweepOpts(dir), deps);

        expect(deps.calls.length).toEqual(5);
        expect(summary.stopReason).toBeNull();
        // Requests made after midnight are attributed to the new UTC day, so
        // a later invocation cannot reset a stale date and double the cap.
        const state = readState(dir);
        expect(state.date).toEqual('2026-01-02');
        expect(state.count).toEqual(3);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('repairs a torn cache tail so new entries are never glued onto a fragment', async () => {
      const dir = makeTmpDir();
      try {
        writePointsFile(dir, WORLD_POINTS);
        const seeded = {
          key: liq.sweepCoordKey(WORLD_POINTS[0].lat, WORLD_POINTS[0].lon),
          lat: WORLD_POINTS[0].lat,
          lon: WORLD_POINTS[0].lon,
          status: 200,
          body: { display_name: '', address: { city: 'San Salvador', country_code: 'sv' } }
        };
        // Valid entry followed by a torn final line with no newline, as an
        // interrupted append would leave it.
        fs.writeFileSync(path.join(dir, 'cache.jsonl'), JSON.stringify(seeded) + '\n' + '{"key":"13.4767');

        const deps = makeDeps(() => okResponse({ city: 'Testville', country_code: 'us' }));
        const summary = await liq.runSweep(sweepOpts(dir), deps);

        expect(deps.calls.length).toEqual(4);
        expect(summary.evaluated).toEqual(5);
        expect(cacheEntries(dir).length).toEqual(5);

        // The repaired cache must fully satisfy a second run: zero requests.
        const again = makeDeps(() => okResponse({ city: 'Testville', country_code: 'us' }));
        const summary2 = await liq.runSweep(sweepOpts(dir), again);
        expect(again.calls.length).toEqual(0);
        expect(summary2.evaluated).toEqual(5);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('attributes a request to the new UTC day when the rate-limit wait crosses midnight', async () => {
      const dir = makeTmpDir();
      try {
        writePointsFile(dir, WORLD_POINTS.slice(0, 2));
        // The clock only advances past midnight during the rate-limit sleep
        // before the second request.
        let clock = new Date('2026-01-01T23:59:59Z');
        const deps = makeDeps(() => okResponse({ city: 'Testville', country_code: 'us' }));
        deps.now = () => clock;
        deps.sleep = async () => { clock = new Date('2026-01-02T00:00:01Z'); };

        const summary = await liq.runSweep(sweepOpts(dir, { rps: 1, dailyCap: 1 }), deps);

        // One request on each UTC day is within a cap of 1 per day; recording
        // the post-midnight request against yesterday would either block it
        // or let a later run double-spend the new day.
        expect(deps.calls.length).toEqual(2);
        expect(summary.stopReason).toBeNull();
        const state = readState(dir);
        expect(state.date).toEqual('2026-01-02');
        expect(state.count).toEqual(1);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('warns instead of failing when dry-run finds an unreadable quota state file', async () => {
      const dir = makeTmpDir();
      try {
        writePointsFile(dir, WORLD_POINTS);
        const tornState = '{"date":"2026-';
        fs.writeFileSync(path.join(dir, 'quota.json'), tornState);
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
        expect(summary.quota.count).toBeNull();
        const report = fs.readFileSync(path.join(dir, 'report.md'), 'utf8');
        expect(report).toContain('unknown (quota state unreadable)');
        // The damaged file is left untouched for inspection.
        expect(fs.readFileSync(path.join(dir, 'quota.json'), 'utf8')).toEqual(tornState);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('rejects a network run against a cache built with different request options', async () => {
      const dir = makeTmpDir();
      try {
        writePointsFile(dir, WORLD_POINTS);
        const respond = () => okResponse({ city: 'Testville', country_code: 'us' });

        const first = makeDeps(respond);
        await liq.runSweep(sweepOpts(dir), first);
        expect(first.calls.length).toEqual(5);

        // A different accept-language must not silently reuse the cache.
        const second = makeDeps(respond);
        await expectAsync(liq.runSweep(sweepOpts(dir, { acceptLanguage: 'fr' }), second))
          .toBeRejectedWithError(/accept-language/);
        expect(second.calls.length).toEqual(0);

        // Neither may a different endpoint.
        const third = makeDeps(respond);
        await expectAsync(liq.runSweep(sweepOpts(dir, { endpoint: 'https://eu1.liq.invalid/v1/reverse' }), third))
          .toBeRejectedWithError(/endpoint/);
        expect(third.calls.length).toEqual(0);

        // Matching options keep resuming from the cache.
        const fourth = makeDeps(respond);
        const summary = await liq.runSweep(sweepOpts(dir), fourth);
        expect(fourth.calls.length).toEqual(0);
        expect(summary.evaluated).toEqual(5);

        // Dry runs only evaluate the cache as-is, so options are exempt.
        const fifth = makeDeps(() => {
          throw new Error('dry-run must not touch the network');
        });
        const drySummary = await liq.runSweep(sweepOpts(dir, { acceptLanguage: 'fr', dryRun: true, apiKey: '' }), fifth);
        expect(fifth.calls.length).toEqual(0);
        expect(drySummary.evaluated).toEqual(5);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('optional sqlite3 dependency', () => {
    it('runs the TSV-only sample command without sqlite3 installed', () => {
      const dir = makeTmpDir();
      try {
        const tsvPath = path.join(dir, 'cities.tsv');
        const outPath = path.join(dir, 'points.jsonl');
        fs.writeFileSync(tsvPath, geonamesRow(1, 'Testville', 40.0, -100.0, 'P', 'US', 1000) + '\n');

        const script = path.join(__dirname, '..', 'scripts', 'validate_with_locationiq.js');
        const shim = [
          "const Module = require('module');",
          'const originalLoad = Module._load;',
          'Module._load = function(request, ...rest) {',
          "  if (request === 'sqlite3') {",
          '    const err = new Error("Cannot find module \'sqlite3\'");',
          "    err.code = 'MODULE_NOT_FOUND';",
          '    throw err;',
          '  }',
          '  return originalLoad.call(this, request, ...rest);',
          '};',
          'const liq = require(process.env.LIQ_SCRIPT);',
          "liq.sampleMain(['--geonames', process.env.LIQ_TSV, '--out', process.env.LIQ_OUT])",
          "  .then(() => console.log('SAMPLE_OK'))",
          '  .catch((err) => { console.error(err.message); process.exit(1); });'
        ].join('\n');

        const result = spawnSync('node', ['-e', shim], {
          encoding: 'utf8',
          env: Object.assign({}, process.env, { LIQ_SCRIPT: script, LIQ_TSV: tsvPath, LIQ_OUT: outPath })
        });

        expect(result.status).toEqual(0);
        expect(result.stdout).toContain('SAMPLE_OK');
        const written = fs.readFileSync(outPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        expect(written.length).toEqual(1);
        expect(written[0].name).toEqual('Testville');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
