# Database compatibility contract

This library ships inside applications together with a pre-built SQLite
database. The two are versioned independently: an app update can pair new
reader code with an old bundled database, and a regenerated database can be
opened by older reader code. **Both directions must keep working.** This
document is the contract that makes that possible.

## The contract

Schema changes must be **additive only**:

- **Never** rename, repurpose, drop, or change the meaning, type, or
  nullability of an existing shipped column or table.
- New columns must be nullable (or have a default) and may only be added to
  the end of a table with `ALTER TABLE ... ADD COLUMN`.
- New tables are always allowed.

Readers (`src/reverse.js`, `src/forward.js`, `src/location.js`):

- Select and consume columns **by name** — never rely on column order,
  position, or count, so extra columns in a newer database are invisible.
- Feature-detect optional tables and columns at runtime (see
  `getBoundarySchemaStatus` in `src/reverse.js`, which probes
  `sqlite_master`) and degrade gracefully when a generation is absent.
- Must not require any column that older shipped databases lack.

Builders (`scripts/generate_boundary_index.js` and friends):

- When appending to an existing database, upgrade older schemas in place
  with `ALTER TABLE ... ADD COLUMN` (nullable), never by rebuilding or
  rewriting existing tables.
- New columns are builder-side metadata until every shipped reader release
  that might open the database knows about them; readers treat `NULL` as
  the pre-upgrade behavior.

## Known schema generations

Every generation that ever shipped stays supported. Newest first:

| # | Generation | Tables | Notes |
|---|---|---|---|
| 4 | Compact v2 + population/area | `compact_places` (+ nullable `population`, `area`) + `compact_geohash_lookup` | Extra columns rank append/merge conflicts in the builder; readers ignore them. Older compact v2 databases are upgraded in place on `--append`. |
| 3 | Compact v2 | `compact_places` + `compact_geohash_lookup` | Seven-column `compact_places` (`id`, `name`, `country_id`, `admin1_id`, `placetype_code`, `latitude`, `longitude`). This is the generation bundled in shipped apps. No stored country display name — the reader uses `country_id` and resolves the admin1 name via a self-join on the region row. |
| 2 | Compact legacy | `places` + `place_geohash_lookup` | Full-width `places` table with a flat geohash-to-place lookup; the reader joins `countries`/`admin1` for display names. |
| 1 | Full boundary | `places` + `place_geohash_cover` + `place_geometry` | Runtime point-in-polygon over stored geometry. `place_geohash_lookup` exists but may be empty; the reader tries the compact lookup first and falls through to the polygon path. |

All generations may additionally carry the GeoNames base tables
(`features`, `coordinates`, `countries`, `admin1` and the `everything`
view) used by centroid mode, forward geocoding, and id lookup.

## Enforcement

Every shipped schema generation has a **permanent fixture** in
[`spec/reader_compatibility_spec.js`](spec/reader_compatibility_spec.js).
Each fixture builds a database with the frozen schema of its generation —
deliberately not derived from `scripts/schema.sql` or the builder, which
move forward over time — and asserts that reverse lookups in boundary mode
return the expected results.

Rules for contributors:

- **Never modify an existing generation fixture.** They pin history; a
  change that requires editing one is a compatibility break by definition.
- When you ship a new schema generation: add a new fixture block to
  `spec/reader_compatibility_spec.js` and a new row to the table above.
- Reader changes must keep every existing fixture green.
