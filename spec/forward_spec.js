'use strict'

var createGeocoder = require('../src/index.js')
var fixtureDb = require('./helpers/fixture_db')

describe('geocoder.forward', function () {
  var fixture, geocoder

  beforeAll(function () {
    return fixtureDb.createFixtureDatabase().then(function (f) {
      fixture = f
      geocoder = createGeocoder({ database: fixture.databasePath })
    })
  })

  afterAll(function () {
    return geocoder.close().then(function () { fixture.cleanup() })
  })

  it('returns the best match for an exact query', function () {
    return geocoder.forward('Rome').then(function (result) {
      expect(result).toEqual({
        id: 3169070,
        name: 'Rome',
        formatted: 'Rome, Latium, Italy',
        country: { id: 'IT', name: 'Italy' },
        admin1: { id: 7, name: 'Latium' },
        coordinates: { latitude: 41.89193, longitude: 12.51133 }
      })
    })
  })

  it('falls back to fuzzy matching', function () {
    return geocoder.forward('angeles').then(function (result) {
      expect(result.id).toEqual(5368361)
    })
  })

  it('returns undefined when nothing matches', function () {
    return geocoder.forward('xyzzy-not-a-city').then(function (result) {
      expect(result).toBeUndefined()
    })
  })
})
