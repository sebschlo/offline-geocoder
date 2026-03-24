#!/usr/bin/env python3
"""Analyze compact geohash lookup DB size drivers.

Usage:
  python scripts/analyze_compact_index.py \
    --db tmp/wof-fr-it-compact-p5-d3-pop10k-region.sqlite \
    --top 20 \
    --export-place-id 85683531 \
    --export-geojson tmp/region_cells.geojson
"""

from __future__ import annotations

import argparse
import json
import math
import sqlite3
from pathlib import Path
from typing import Dict, Iterable, List, Sequence, Tuple

BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz"
BASE32_MAP = {ch: i for i, ch in enumerate(BASE32)}
PLACETYPE_BY_CODE = {0: "locality", 1: "localadmin", 2: "region"}


def decode_geohash_bbox(geohash: str) -> Tuple[float, float, float, float]:
    lat_min, lat_max = -90.0, 90.0
    lon_min, lon_max = -180.0, 180.0
    even = True

    for ch in geohash.lower():
        value = BASE32_MAP[ch]
        for mask in (16, 8, 4, 2, 1):
            if even:
                lon_mid = (lon_min + lon_max) / 2.0
                if value & mask:
                    lon_min = lon_mid
                else:
                    lon_max = lon_mid
            else:
                lat_mid = (lat_min + lat_max) / 2.0
                if value & mask:
                    lat_min = lat_mid
                else:
                    lat_max = lat_mid
            even = not even

    return (lat_min, lon_min, lat_max, lon_max)


def cell_area_km2(geohash: str) -> float:
    min_lat, min_lon, max_lat, max_lon = decode_geohash_bbox(geohash)
    center_lat = (min_lat + max_lat) / 2.0
    d_lat = abs(max_lat - min_lat)
    d_lon = abs(max_lon - min_lon)

    lat_km = d_lat * 111.32
    lon_km = d_lon * 111.32 * math.cos(math.radians(center_lat))
    return max(0.0, lat_km * lon_km)


def query_all(conn: sqlite3.Connection, sql: str, params: Sequence[object] = ()) -> List[sqlite3.Row]:
    cur = conn.execute(sql, params)
    rows = cur.fetchall()
    cur.close()
    return rows


def compact_has_placetype_code(conn: sqlite3.Connection) -> bool:
    cols = query_all(conn, "PRAGMA table_info(compact_places)")
    names = {row["name"] for row in cols}
    return "placetype_code" in names


def print_summary(conn: sqlite3.Connection, top_n: int) -> None:
    has_code = compact_has_placetype_code(conn)
    placetype_expr = (
        "CASE p.placetype_code WHEN 0 THEN 'locality' WHEN 1 THEN 'localadmin' WHEN 2 THEN 'region' ELSE 'unknown' END"
        if has_code
        else "p.placetype"
    )

    total_rows = query_all(conn, "SELECT COUNT(*) AS c FROM compact_geohash_lookup")[0]["c"]
    total_places = query_all(conn, "SELECT COUNT(*) AS c FROM compact_places")[0]["c"]
    lengths = query_all(
        conn,
        "SELECT LENGTH(geohash) AS precision, COUNT(*) AS c "
        "FROM compact_geohash_lookup GROUP BY precision ORDER BY precision",
    )

    print("=== Compact Index Summary ===")
    print(f"Places: {total_places}")
    print(f"Lookup rows: {total_rows}")
    print("Geohash precision distribution:")
    for row in lengths:
        print(f"  p{row['precision']}: {row['c']}")

    by_type = query_all(
        conn,
        """
        SELECT
          {placetype_expr} AS placetype,
          COUNT(DISTINCT p.id) AS place_count,
          COUNT(*) AS lookup_rows
        FROM compact_geohash_lookup l
        JOIN compact_places p ON p.id = l.place_id
        GROUP BY placetype
        ORDER BY lookup_rows DESC
        """.format(placetype_expr=placetype_expr),
    )
    print("Rows by placetype:")
    for row in by_type:
        pct = (row["lookup_rows"] / total_rows * 100.0) if total_rows else 0.0
        print(
            f"  {row['placetype']}: places={row['place_count']}, "
            f"rows={row['lookup_rows']} ({pct:.1f}%)"
        )

    top_places = query_all(
        conn,
        """
        SELECT
          p.id,
          p.name,
          p.country_id,
          {placetype_expr} AS placetype,
          COUNT(*) AS lookup_rows
        FROM compact_geohash_lookup l
        JOIN compact_places p ON p.id = l.place_id
        GROUP BY p.id
        ORDER BY lookup_rows DESC, p.id ASC
        LIMIT ?
        """.format(placetype_expr=placetype_expr),
        (top_n,),
    )

    print(f"Top {top_n} places by lookup rows:")
    for row in top_places:
        print(
            f"  {row['id']} | {row['placetype']} | {row['country_id']} | "
            f"{row['name']} | rows={row['lookup_rows']}"
        )

    region_area = query_all(
        conn,
        """
        SELECT l.geohash
        FROM compact_geohash_lookup l
        JOIN compact_places p ON p.id = l.place_id
        WHERE {placetype_expr} = 'region'
        """.format(placetype_expr=placetype_expr),
        (),
    )
    total_region_area = sum(cell_area_km2(row["geohash"]) for row in region_area)
    print(f"Approx area represented by region rows (km^2): {total_region_area:,.0f}")


def export_place_geojson(
    conn: sqlite3.Connection,
    place_id: int,
    output_path: Path,
    limit: int | None = None,
) -> None:
    has_code = compact_has_placetype_code(conn)
    if has_code:
        place_rows = query_all(
            conn,
            """
            SELECT
              id,
              name,
              country_id,
              admin1_id,
              CASE placetype_code
                WHEN 0 THEN 'locality'
                WHEN 1 THEN 'localadmin'
                WHEN 2 THEN 'region'
                ELSE 'unknown'
              END AS placetype
            FROM compact_places
            WHERE id = ?
            """,
            (place_id,),
        )
    else:
        place_rows = query_all(
            conn,
            "SELECT id, name, country_id, admin1_id, placetype FROM compact_places WHERE id = ?",
            (place_id,),
        )
    if not place_rows:
        raise SystemExit(f"place_id={place_id} not found in compact_places")
    place = place_rows[0]

    sql = "SELECT geohash FROM compact_geohash_lookup WHERE place_id = ? ORDER BY geohash"
    params: List[object] = [place_id]
    if limit is not None and limit > 0:
        sql += " LIMIT ?"
        params.append(limit)

    geohash_rows = query_all(conn, sql, tuple(params))

    features: List[Dict[str, object]] = []
    for row in geohash_rows:
        geoh = row["geohash"]
        min_lat, min_lon, max_lat, max_lon = decode_geohash_bbox(geoh)
        polygon = [
            [min_lon, min_lat],
            [max_lon, min_lat],
            [max_lon, max_lat],
            [min_lon, max_lat],
            [min_lon, min_lat],
        ]
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "place_id": place["id"],
                    "name": place["name"],
                    "placetype": place["placetype"],
                    "country_id": place["country_id"],
                    "admin1_id": place["admin1_id"],
                    "geohash": geoh,
                    "precision": len(geoh),
                },
                "geometry": {"type": "Polygon", "coordinates": [polygon]},
            }
        )

    payload = {"type": "FeatureCollection", "features": features}
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload), encoding="utf-8")

    print(
        f"Wrote {len(features)} cell polygons for place_id={place_id} "
        f"({place['name']}) to {output_path}"
    )


def export_all_geojson(conn: sqlite3.Connection, output_path: Path, limit: int | None = None) -> None:
    has_code = compact_has_placetype_code(conn)
    if has_code:
        sql = """
            SELECT
              l.geohash AS geohash,
              p.id AS place_id,
              p.name AS name,
              p.country_id AS country_id,
              p.admin1_id AS admin1_id,
              CASE p.placetype_code
                WHEN 0 THEN 'locality'
                WHEN 1 THEN 'localadmin'
                WHEN 2 THEN 'region'
                ELSE 'unknown'
              END AS placetype
            FROM compact_geohash_lookup l
            JOIN compact_places p ON p.id = l.place_id
            ORDER BY l.geohash
        """
    else:
        sql = """
            SELECT
              l.geohash AS geohash,
              p.id AS place_id,
              p.name AS name,
              p.country_id AS country_id,
              p.admin1_id AS admin1_id,
              p.placetype AS placetype
            FROM compact_geohash_lookup l
            JOIN compact_places p ON p.id = l.place_id
            ORDER BY l.geohash
        """

    params: List[object] = []
    if limit is not None and limit > 0:
        sql += " LIMIT ?"
        params.append(limit)

    rows = query_all(conn, sql, tuple(params))

    features: List[Dict[str, object]] = []
    for row in rows:
        geoh = row["geohash"]
        min_lat, min_lon, max_lat, max_lon = decode_geohash_bbox(geoh)
        polygon = [
            [min_lon, min_lat],
            [max_lon, min_lat],
            [max_lon, max_lat],
            [min_lon, max_lat],
            [min_lon, min_lat],
        ]
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "place_id": row["place_id"],
                    "name": row["name"],
                    "placetype": row["placetype"],
                    "country_id": row["country_id"],
                    "admin1_id": row["admin1_id"],
                    "geohash": geoh,
                    "precision": len(geoh),
                },
                "geometry": {"type": "Polygon", "coordinates": [polygon]},
            }
        )

    payload = {"type": "FeatureCollection", "features": features}
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload), encoding="utf-8")
    print(f"Wrote {len(features)} cell polygons to {output_path}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Analyze compact geohash lookup DB")
    parser.add_argument("--db", required=True, help="Path to SQLite DB with compact_* tables")
    parser.add_argument("--top", type=int, default=20, help="Show top N places by lookup rows")
    parser.add_argument("--export-place-id", type=int, default=None, help="Place id to export as cell polygons")
    parser.add_argument(
        "--export-geojson",
        default="tmp/compact_place_cells.geojson",
        help="GeoJSON output path (used with --export-place-id)",
    )
    parser.add_argument(
        "--export-limit",
        type=int,
        default=None,
        help="Optional max number of geohash cells to export",
    )
    parser.add_argument(
        "--export-all-geojson",
        default=None,
        help="Write all geohash cells with place metadata to this GeoJSON path",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    db_path = Path(args.db)
    if not db_path.exists():
        raise SystemExit(f"DB not found: {db_path}")

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        tables = {row["name"] for row in query_all(conn, "SELECT name FROM sqlite_master WHERE type='table'")}
        if "compact_places" not in tables or "compact_geohash_lookup" not in tables:
            raise SystemExit("DB does not contain compact_places + compact_geohash_lookup")

        print_summary(conn, args.top)

        if args.export_place_id is not None:
            export_place_geojson(
                conn,
                place_id=args.export_place_id,
                output_path=Path(args.export_geojson),
                limit=args.export_limit,
            )

        if args.export_all_geojson:
            export_all_geojson(
                conn,
                output_path=Path(args.export_all_geojson),
                limit=args.export_limit,
            )
    finally:
        conn.close()


if __name__ == "__main__":
    main()
