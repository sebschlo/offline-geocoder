"use strict";

function withCallback(promise, callback) {
  if (typeof callback === "function") {
    promise.then((result) => callback(undefined, result)).catch((error) => callback(error, undefined));
  }
  return promise;
}

function normalizeId(value) {
  if (typeof value === "string") {
    const match = /^geonames:(\d+)$/i.exec(value.trim());
    if (match) {
      return Number(match[1]);
    }
    return Number(value);
  }
  return value;
}

function formatRow(row) {
  if (!row) {
    return undefined;
  }

  const parts = [row.name];
  if (row.admin1_name && row.admin1_name !== row.name) {
    parts.push(row.admin1_name);
  }
  parts.push(row.country_name);

  return {
    id: Number(row.id),
    name: row.name,
    formatted: parts.join(", "),
    country: {
      id: row.country_id,
      name: row.country_name
    },
    admin1: {
      id: row.admin1_id,
      name: row.admin1_name
    },
    coordinates: {
      latitude: Number(row.latitude),
      longitude: Number(row.longitude)
    }
  };
}

function createGeocoder(adapter) {
  if (!adapter || typeof adapter.all !== "function") {
    throw new Error("Adapter must provide all(sql, params).");
  }

  const selectEverything = `
    SELECT
      id, name, admin1_id, admin1_name, country_id, country_name, latitude, longitude
    FROM everything
  `;

  async function one(sql, params) {
    const rows = await adapter.all(sql, params || []);
    return rows[0];
  }

  async function reverseInternal(latitude, longitude) {
    const scale = Math.pow(Math.cos(latitude * Math.PI / 180), 2);
    const row = await one(
      `
      ${selectEverything}
      WHERE id IN (
        SELECT feature_id
        FROM coordinates
        WHERE latitude BETWEEN ? - 1.5 AND ? + 1.5
          AND longitude BETWEEN ? - 1.5 AND ? + 1.5
        ORDER BY
          ((? - latitude) * (? - latitude)) +
          ((? - longitude) * (? - longitude) * ?)
        LIMIT 1
      )
      LIMIT 1
      `,
      [latitude, latitude, longitude, longitude, latitude, latitude, longitude, longitude, scale]
    );

    return row ? formatRow(row) : {};
  }

  async function findInternal(locationId) {
    const row = await one(`${selectEverything} WHERE id = ? LIMIT 1`, [normalizeId(locationId)]);
    return formatRow(row);
  }

  async function forwardInternal(query) {
    const normalizedQuery = typeof query === "string" ? query.trim() : "";
    if (!normalizedQuery) {
      return undefined;
    }

    const exact = await one(
      `
      ${selectEverything}
      WHERE name = ? COLLATE NOCASE OR asciiname = ? COLLATE NOCASE
      ORDER BY
        CASE
          WHEN name = ? COLLATE NOCASE THEN 0
          WHEN asciiname = ? COLLATE NOCASE THEN 1
          ELSE 2
        END,
        population DESC,
        id ASC
      LIMIT 1
      `,
      [normalizedQuery, normalizedQuery, normalizedQuery, normalizedQuery]
    );

    if (exact) {
      return formatRow(exact);
    }

    const prefix = normalizedQuery + "%";
    const contains = "%" + normalizedQuery + "%";
    const fuzzy = await one(
      `
      ${selectEverything}
      WHERE
        name LIKE ? COLLATE NOCASE OR
        name LIKE ? COLLATE NOCASE OR
        asciiname LIKE ? COLLATE NOCASE OR
        asciiname LIKE ? COLLATE NOCASE
      ORDER BY
        CASE
          WHEN name LIKE ? COLLATE NOCASE THEN 0
          WHEN asciiname LIKE ? COLLATE NOCASE THEN 1
          ELSE 2
        END,
        population DESC,
        LENGTH(name) ASC,
        id ASC
      LIMIT 1
      `,
      [prefix, contains, prefix, contains, prefix, prefix]
    );

    return formatRow(fuzzy);
  }

  const locationApi = {
    find: function(locationId, callback) {
      return withCallback(findInternal(locationId), callback);
    }
  };

  function location() {
    return locationApi;
  }
  location.find = locationApi.find;

  return {
    reverse: function(latitude, longitude, callback) {
      return withCallback(reverseInternal(latitude, longitude), callback);
    },
    forward: function(query, callback) {
      return withCallback(forwardInternal(query), callback);
    },
    location: location,
    close: function() {
      return typeof adapter.close === "function" ? adapter.close() : Promise.resolve();
    }
  };
}

module.exports = {
  createGeocoder: createGeocoder
};
