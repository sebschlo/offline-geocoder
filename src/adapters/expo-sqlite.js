"use strict";

function createExpoSqliteAdapter(db) {
  if (!db || typeof db.getAllAsync !== "function") {
    throw new Error("Expo adapter expects a database with getAllAsync(sql, params).");
  }

  return {
    all: function(sql, params) {
      return db.getAllAsync(sql, params || []);
    },
    close: function() {
      return typeof db.closeAsync === "function" ? db.closeAsync() : Promise.resolve();
    },
    raw: db
  };
}

module.exports = {
  createExpoSqliteAdapter: createExpoSqliteAdapter
};
