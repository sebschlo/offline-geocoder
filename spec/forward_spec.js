"use strict";

const createGeocoder = require("../src/index.js");
const fixtureDb = require("./helpers/fixture_db");

describe("geocoder.forward", () => {
  let fixture;
  let geocoder;

  beforeAll(async () => {
    fixture = await fixtureDb.createFixtureDatabase();
    geocoder = createGeocoder({ database: fixture.databasePath });
  });

  afterAll(async () => {
    if (geocoder && typeof geocoder.close === "function") {
      await geocoder.close();
    }

    if (fixture) {
      fixture.cleanup();
    }
  });

  it("returns the best canonical city for an exact query", async () => {
    const result = await geocoder.forward("Rome");

    expect(result).toEqual({
      id: 3169070,
      name: "Rome",
      formatted: "Rome, Latium, Italy",
      country: { id: "IT", name: "Italy" },
      admin1: { id: 7, name: "Latium" },
      coordinates: { latitude: 41.89193, longitude: 12.51133 }
    });
  });

  it("supports fuzzy matches", async () => {
    const result = await geocoder.forward("angeles");
    expect(result && result.id).toEqual(5368361);
  });

  it("returns undefined when no city matches", async () => {
    const result = await geocoder.forward("definitely-not-a-city");
    expect(result).toEqual(undefined);
  });
});
