const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const sqlite3 = require('sqlite3');

function runScript(scriptPath, outputPath, env) {
  return new Promise(function(resolve, reject) {
    execFile(scriptPath, [outputPath], { env: env }, function(err, stdout, stderr) {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }

      resolve({ stdout: stdout, stderr: stderr });
    });
  });
}

function queryAll(dbPath, sql) {
  return new Promise(function(resolve, reject) {
    var db = new sqlite3.Database(dbPath);
    db.all(sql, [], function(err, rows) {
      db.close(function(closeErr) {
        if (err || closeErr) {
          reject(err || closeErr);
          return;
        }

        resolve(rows || []);
      });
    });
  });
}

function geonamesRow(fields) {
  return fields.join('\t') + '\n';
}

describe('scripts/generate_geonames.sh', () => {
  var tmpDir;
  var sourceDir;
  var dbPath;
  var scriptPath = path.join(__dirname, '../scripts/generate_geonames.sh');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-build-'));
    sourceDir = path.join(tmpDir, '.geonames-build', 'source');
    dbPath = path.join(tmpDir, 'geocoder.sqlite');

    fs.mkdirSync(sourceDir, { recursive: true });

    fs.writeFileSync(path.join(sourceDir, 'cities1000.txt'), [
      geonamesRow(['3028808', 'Cannes', 'Cannes', '', '43.55135', '7.01275', 'P', 'PPL', 'FR', '', '93', '', '', '', '74545', '', '', 'Europe/Paris', '2024-01-01']),
      geonamesRow(['9990001', 'Tiny Hamlet', 'Tiny Hamlet', '', '43.60000', '7.10000', 'P', 'PPL', 'FR', '', '93', '', '', '', '2500', '', '', 'Europe/Paris', '2024-01-01']),
      geonamesRow(['9990002', 'Admin Seat', 'Admin Seat', '', '41.00000', '15.00000', 'P', 'PPLA3', 'IT', '', '04', '', '', '', '1026', '', '', 'Europe/Rome', '2024-01-01'])
    ].join(''));

    fs.writeFileSync(path.join(sourceDir, 'admin1CodesASCII.txt'), [
      'FR.93\tProvence-Alpes-Cote d\'Azur\tProvence-Alpes-Cote d\'Azur\t0\n',
      'IT.04\tCampania\tCampania\t0\n'
    ].join(''));

    fs.writeFileSync(path.join(sourceDir, 'countryInfo.txt'), [
      '#ISO\tISO3\tISO-Numeric\tfips\tCountry\tCapital\tArea(in sq km)\tPopulation\tContinent\ttld\tCurrencyCode\tCurrencyName\tPhone\tPostal Code Format\tPostal Code Regex\tLanguages\tgeonameid\tneighbours\tEquivalentFipsCode\n',
      'FR\tFRA\t250\tFR\tFrance\tParis\t0\t0\tEU\t.fr\tEUR\tEuro\t33\t\t\tfr\t0\t\t\n',
      'IT\tITA\t380\tIT\tItaly\tRome\t0\t0\tEU\t.it\tEUR\tEuro\t39\t\t\tit\t0\t\t\n'
    ].join(''));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('keeps larger PPL cities while filtering smaller PPL localities by default', async () => {
    await runScript(scriptPath, dbPath, Object.assign({}, process.env, {
      GEONAMES_WORKDIR: tmpDir,
      GEONAMES_DOWNLOAD: '0'
    }));

    var rows = await queryAll(dbPath, 'SELECT name, population FROM features ORDER BY id');
    expect(rows).toEqual([
      { name: 'Cannes', population: 74545 },
      { name: 'Admin Seat', population: 1026 }
    ]);
  });

  it('allows smaller PPL entries when GEONAMES_PPL_MIN_POPULATION is lowered', async () => {
    await runScript(scriptPath, dbPath, Object.assign({}, process.env, {
      GEONAMES_WORKDIR: tmpDir,
      GEONAMES_DOWNLOAD: '0',
      GEONAMES_PPL_MIN_POPULATION: '2000'
    }));

    var rows = await queryAll(dbPath, 'SELECT name FROM features ORDER BY id');
    expect(rows).toEqual([
      { name: 'Cannes' },
      { name: 'Tiny Hamlet' },
      { name: 'Admin Seat' }
    ]);
  });
});
