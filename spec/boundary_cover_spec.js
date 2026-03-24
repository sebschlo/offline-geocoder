const geohash = require('../src/geohash');
const boundaryCover = require('../src/boundary_cover');

describe('boundary geohash cover', () => {
  it('marks fully contained geohash cells as full', () => {
    const cell = geohash.decodeBbox('s000');
    const exactCellPolygon = {
      type: 'Polygon',
      coordinates: [[
        [cell.minLon, cell.minLat],
        [cell.maxLon, cell.minLat],
        [cell.maxLon, cell.maxLat],
        [cell.minLon, cell.maxLat],
        [cell.minLon, cell.minLat]
      ]]
    };

    const cover = boundaryCover.buildGeohashCoverForGeometry(exactCellPolygon, {
      basePrecision: 4,
      maxPrecision: 6
    });

    expect(cover).toContain(jasmine.objectContaining({
      geohash: 's000',
      precision: 4,
      coverageType: 'full'
    }));
  });

  it('subdivides partial cells until max precision', () => {
    const cell = geohash.decodeBbox('s000');
    const diagonalPolygon = {
      type: 'Polygon',
      coordinates: [[
        [cell.minLon, cell.minLat],
        [cell.maxLon, cell.minLat],
        [cell.minLon, cell.maxLat],
        [cell.minLon, cell.minLat]
      ]]
    };

    const cover = boundaryCover.buildGeohashCoverForGeometry(diagonalPolygon, {
      basePrecision: 4,
      maxPrecision: 5
    });

    expect(cover.some((entry) => entry.precision === 5)).toBeTrue();

    const uniqueKeys = new Set(cover.map((entry) => `${entry.geohash}|${entry.precision}`));
    expect(uniqueKeys.size).toEqual(cover.length);
  });
});
