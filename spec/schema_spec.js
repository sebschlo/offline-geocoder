"use strict";

const sqlite3 = require("sqlite3");
const fixtureDb = require("./helpers/fixture_db");

function all(db, sql, params) {
  const boundParams = Array.isArray(params) ? params : [];

  return new Promise((resolve, reject) => {
    db.all(sql, boundParams, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(rows || []);
    });
  });
}

function close(db) {
  return new Promise((resolve, reject) => {
    db.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

describe("generated schema", () => {
  let fixture;
  let db;

  beforeAll(async () => {
    fixture = await fixtureDb.createFixtureDatabase();
    db = new sqlite3.Database(fixture.databasePath);
  });

  afterAll(async () => {
    if (db) {
      await close(db);
    }

    if (fixture) {
      fixture.cleanup();
    }
  });

  it("includes forward-search columns in the everything view", async () => {
    const columns = await all(db, "PRAGMA table_info(everything)");
    const columnNames = columns.map((column) => column.name);

    expect(columnNames).toContain("asciiname");
    expect(columnNames).toContain("population");
  });

  it("includes indexes for reverse and forward lookups", async () => {
    const coordinateIndexes = await all(db, "PRAGMA index_list('coordinates')");
    const featureIndexes = await all(db, "PRAGMA index_list('features')");

    const coordinateIndexNames = coordinateIndexes.map((index) => index.name);
    const featureIndexNames = featureIndexes.map((index) => index.name);

    expect(coordinateIndexNames).toContain("coordinates_lat_lng");
    expect(featureIndexNames).toContain("features_name_nocase");
    expect(featureIndexNames).toContain("features_asciiname_nocase");
    expect(featureIndexNames).toContain("features_population_desc");
  });
});
