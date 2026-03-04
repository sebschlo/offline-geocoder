"use strict";

const path = require("path");
const geocoder = require("./core/geocoder");
const nodeAdapter = require("./adapters/node-sqlite3");

function defaultDatabasePath() {
  return path.join(__dirname, "../data/db.sqlite");
}

function createNodeGeocoder(options) {
  const geocoderOptions = options || {};

  if (geocoderOptions.adapter) {
    return geocoder.createGeocoder(geocoderOptions.adapter);
  }

  const adapter = nodeAdapter.createNodeSqliteAdapter({
    database: geocoderOptions.database || defaultDatabasePath(),
    db: geocoderOptions.db,
    sqlite3: geocoderOptions.sqlite3
  });

  return geocoder.createGeocoder(adapter);
}

module.exports = createNodeGeocoder;
module.exports.createNodeGeocoder = createNodeGeocoder;
module.exports.createGeocoder = geocoder.createGeocoder;
module.exports.createNodeSqliteAdapter = nodeAdapter.createNodeSqliteAdapter;
