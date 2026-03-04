"use strict";

const geocoder = require("./core/geocoder");
const expoAdapter = require("./adapters/expo-sqlite");

function createExpoGeocoder(options) {
  const geocoderOptions = options || {};

  if (geocoderOptions.adapter) {
    return geocoder.createGeocoder(geocoderOptions.adapter);
  }

  const db = geocoderOptions.db || geocoderOptions.database;
  if (!db) {
    throw new Error("Pass an opened expo-sqlite db via { db }.");
  }

  return geocoder.createGeocoder(expoAdapter.createExpoSqliteAdapter(db));
}

module.exports = createExpoGeocoder;
module.exports.createExpoGeocoder = createExpoGeocoder;
module.exports.createExpoSqliteAdapter = expoAdapter.createExpoSqliteAdapter;
module.exports.createGeocoder = geocoder.createGeocoder;
