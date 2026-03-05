'use strict'

function resolveSqlite3(custom) {
  if (custom) return custom

  try {
    return require('sqlite3')
  } catch (err) {
    err.message = 'sqlite3 is required for Node usage. Install it with `npm install sqlite3`.'
    throw err
  }
}

function createNodeSqliteAdapter(options) {
  var opts = options || {}
  var sqlite3 = resolveSqlite3(opts.sqlite3)
  var Database = sqlite3.Database || (sqlite3.verbose && sqlite3.verbose().Database)

  if (!Database) {
    throw new Error('Invalid sqlite3 module — expected sqlite3.Database')
  }

  var db = opts.db || new Database(opts.database)

  return {
    all: function (sql, params) {
      var bound = Array.isArray(params) ? params : []
      return new Promise(function (resolve, reject) {
        db.all(sql, bound, function (err, rows) {
          if (err) reject(err)
          else resolve(rows || [])
        })
      })
    },
    close: function () {
      if (typeof db.close !== 'function') return Promise.resolve()
      return new Promise(function (resolve, reject) {
        db.close(function (err) {
          if (err) reject(err)
          else resolve()
        })
      })
    },
    raw: db
  }
}

module.exports = { createNodeSqliteAdapter: createNodeSqliteAdapter }
