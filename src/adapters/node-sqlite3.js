"use strict";

function resolveSqlite3(customSqlite3) {
  if (customSqlite3) {
    return customSqlite3;
  }

  try {
    return require("sqlite3");
  } catch (error) {
    error.message = "sqlite3 dependency is required for Node usage. Install it in your app (`npm install sqlite3`).";
    throw error;
  }
}

function createNodeSqliteAdapter(options) {
  const adapterOptions = options || {};
  const sqlite3 = resolveSqlite3(adapterOptions.sqlite3);
  const Database = sqlite3.Database || (sqlite3.verbose && sqlite3.verbose().Database);

  if (!Database) {
    throw new Error("Invalid sqlite3 module. Expected sqlite3.Database.");
  }

  const db = adapterOptions.db || new Database(adapterOptions.database);

  return {
    all: function(sql, params) {
      const boundParams = Array.isArray(params) ? params : [];

      return new Promise(function(resolve, reject) {
        db.all(sql, boundParams, function(error, rows) {
          if (error) {
            reject(error);
            return;
          }

          resolve(rows || []);
        });
      });
    },
    close: function() {
      if (typeof db.close !== "function") {
        return Promise.resolve();
      }

      return new Promise(function(resolve, reject) {
        db.close(function(error) {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
    raw: db
  };
}

module.exports = {
  createNodeSqliteAdapter: createNodeSqliteAdapter
};
