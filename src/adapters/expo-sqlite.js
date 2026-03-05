'use strict'

function createExpoSqliteAdapter(db) {
  if (!db || typeof db.getAllAsync !== 'function') {
    throw new Error('Expected an expo-sqlite database with getAllAsync()')
  }

  return {
    all: function (sql, params) {
      return db.getAllAsync(sql, params || [])
    },
    close: function () {
      return typeof db.closeAsync === 'function' ? db.closeAsync() : Promise.resolve()
    },
    raw: db
  }
}

module.exports = { createExpoSqliteAdapter: createExpoSqliteAdapter }
