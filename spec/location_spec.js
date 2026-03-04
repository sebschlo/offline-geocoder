"use strict";

const createGeocoder = require("../src/index.js");
const fixtureDb = require("./helpers/fixture_db");

describe("geocoder.location", () => {
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

  describe(".find", () => {
    it("performs a lookup by numeric id", async () => {
      const result = await geocoder.location.find(3169070);

      expect(result).toEqual({
        id: 3169070,
        name: "Rome",
        formatted: "Rome, Latium, Italy",
        country: { id: "IT", name: "Italy" },
        admin1: { id: 7, name: "Latium" },
        coordinates: { latitude: 41.89193, longitude: 12.51133 }
      });
    });

    it("supports geonames-prefixed stable ids", async () => {
      const result = await geocoder.location.find("geonames:3169070");
      expect(result && result.id).toEqual(3169070);
    });

    it("resolves undefined when a location cannot be found", async () => {
      const result = await geocoder.location.find(-1);
      expect(result).toEqual(undefined);
    });
  });
});
