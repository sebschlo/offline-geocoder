"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const sqlite3 = require("sqlite3");

const schemaSql = fs.readFileSync(path.join(__dirname, "../../scripts/schema.sql"), "utf8");

const fixtureSql = `
INSERT INTO countries(id, name) VALUES ('IT', 'Italy'), ('FR', 'France'), ('US', 'United States');
INSERT INTO admin1(country_id, id, name) VALUES
  ('IT', 7, 'Latium'),
  ('FR', 11, 'Ile-de-France'),
  ('US', 36, 'New York'),
  ('US', 5, 'California');
INSERT INTO features(id, name, asciiname, country_id, admin1_id, population) VALUES
  (3169070, 'Rome', 'Rome', 'IT', 7, 2873000),
  (2988507, 'Paris', 'Paris', 'FR', 11, 2138551),
  (5128581, 'New York City', 'New York City', 'US', 36, 8175133),
  (5368361, 'Los Angeles', 'Los Angeles', 'US', 5, 3792621);
INSERT INTO coordinates(feature_id, latitude, longitude) VALUES
  (3169070, 41.89193, 12.51133),
  (2988507, 48.85341, 2.3488),
  (5128581, 40.71427, -74.00597),
  (5368361, 34.05223, -118.24368);
`;

function exec(db, sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (error) => (error ? reject(error) : resolve()));
  });
}

function close(db) {
  return new Promise((resolve, reject) => {
    db.close((error) => (error ? reject(error) : resolve()));
  });
}

async function createFixtureDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offline-geocoder-"));
  const databasePath = path.join(dir, "fixture.sqlite");
  const db = new sqlite3.Database(databasePath);

  await exec(db, schemaSql);
  await exec(db, fixtureSql);
  await close(db);

  return {
    databasePath: databasePath,
    cleanup: function() {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

function createExpoDb(databasePath) {
  const db = new sqlite3.Database(databasePath);
  return {
    getAllAsync: function(sql, params) {
      return new Promise((resolve, reject) => {
        db.all(sql, params || [], (error, rows) => (error ? reject(error) : resolve(rows || [])));
      });
    },
    closeAsync: function() {
      return close(db);
    }
  };
}

module.exports = {
  createFixtureDatabase: createFixtureDatabase,
  createExpoDb: createExpoDb
};
