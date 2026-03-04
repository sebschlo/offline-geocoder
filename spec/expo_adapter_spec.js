"use strict";

const createExpoGeocoder = require("../src/expo.js");
const fixtureDb = require("./helpers/fixture_db");

describe("expo adapter", () => {
  let fixture;

  beforeAll(async () => {
    fixture = await fixtureDb.createFixtureDatabase();
  });

  afterAll(() => {
    fixture.cleanup();
  });

  it("runs queries via getAllAsync", async () => {
    const db = fixtureDb.createExpoDb(fixture.databasePath);
    const geocoder = createExpoGeocoder({ db: db });

    const result = await geocoder.reverse(41.89, 12.49);
    expect(result.id).toEqual(3169070);

    await geocoder.close();
  });
});
