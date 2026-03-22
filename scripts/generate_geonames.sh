#!/bin/bash
set -euo pipefail

# Generates a geocoder SQLite database from GeoNames dump files.
# Usage:
#   ./scripts/generate_geonames.sh [output_db_path]
#
# Environment variables:
#   GEONAMES_DATASET     cities dump name without extension (default: cities1000)
#   GEONAMES_WORKDIR     working dir for output and temp files (default: current dir)
#   GEONAMES_DOWNLOAD    set to 0 to skip downloads and use existing local files
#   GEONAMES_FEATURE_CODES comma-separated GeoNames feature codes to keep
#                         (default: PPL,PPLA,PPLA2,PPLA3,PPLA4,PPLA5,PPLC)
#   GEONAMES_MIN_POPULATION minimum population to keep (default: 0)
#   GEONAMES_PPL_MIN_POPULATION minimum population to keep for plain PPL
#                         populated places (default: 10000)
#   GEONAMES_PPL_DEDUP set to 0 to disable deduplication of neighborhood-like
#                         PPL records near nearby administrative seats (default: 1)
#   GEONAMES_PPL_DEDUP_NEAR_KM suppress any PPL this close to a same-admin2
#                         seat/capital centroid (default: 2)
#   GEONAMES_PPL_DEDUP_NAME_NEAR_KM suppress PPL with city-like related names
#                         within this distance of a same-admin2 seat/capital
#                         centroid (default: 12)
#   GEONAMES_INCLUDE_ADMIN1 set to 0 to skip admin1 import entirely (default: 1)

GEONAMES_DATASET="${GEONAMES_DATASET:-cities1000}"
GEONAMES_WORKDIR="${GEONAMES_WORKDIR:-$(pwd)}"
GEONAMES_DOWNLOAD="${GEONAMES_DOWNLOAD:-1}"
GEONAMES_FEATURE_CODES="${GEONAMES_FEATURE_CODES:-PPL,PPLA,PPLA2,PPLA3,PPLA4,PPLA5,PPLC}"
GEONAMES_MIN_POPULATION="${GEONAMES_MIN_POPULATION:-0}"
GEONAMES_PPL_MIN_POPULATION="${GEONAMES_PPL_MIN_POPULATION:-10000}"
GEONAMES_PPL_DEDUP="${GEONAMES_PPL_DEDUP:-1}"
GEONAMES_PPL_DEDUP_NEAR_KM="${GEONAMES_PPL_DEDUP_NEAR_KM:-2}"
GEONAMES_PPL_DEDUP_NAME_NEAR_KM="${GEONAMES_PPL_DEDUP_NAME_NEAR_KM:-12}"
GEONAMES_INCLUDE_ADMIN1="${GEONAMES_INCLUDE_ADMIN1:-1}"
OUTPUT="${1:-db.sqlite}"

# Resolve to absolute so the later cd into GEONAMES_WORKDIR doesn't break it
case "${OUTPUT}" in
  /*) ;;
  *) OUTPUT="$(pwd)/${OUTPUT}" ;;
esac

DATA_FILE="${GEONAMES_DATASET}.txt"
ADMIN1_FILE="admin1CodesASCII.txt"
COUNTRY_FILE="countryInfo.txt"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCHEMA_FILE="${SCRIPT_DIR}/schema.sql"
TMP_DIR="${GEONAMES_WORKDIR}/.geonames-build"
SOURCE_DIR="${TMP_DIR}/source"

mkdir -p "${GEONAMES_WORKDIR}" "${TMP_DIR}" "${SOURCE_DIR}"

download_if_missing() {
  local file="$1"
  local url="$2"

  if [[ -f "${SOURCE_DIR}/${file}" ]]; then
    echo "Using existing ${file}"
    return
  fi

  if [[ "${GEONAMES_DOWNLOAD}" != "1" ]]; then
    echo "Missing ${file} and GEONAMES_DOWNLOAD=${GEONAMES_DOWNLOAD}." >&2
    echo "Provide local files in ${SOURCE_DIR} or enable downloads." >&2
    exit 1
  fi

  echo "Downloading ${file}..."
  curl -fsSL "${url}" -o "${SOURCE_DIR}/${file}"
}

download_and_extract_dataset_if_missing() {
  if [[ -f "${SOURCE_DIR}/${DATA_FILE}" ]]; then
    echo "Using existing ${DATA_FILE}"
    return
  fi

  if [[ "${GEONAMES_DOWNLOAD}" != "1" ]]; then
    echo "Missing ${DATA_FILE} and GEONAMES_DOWNLOAD=${GEONAMES_DOWNLOAD}." >&2
    echo "Provide local files in ${SOURCE_DIR} or enable downloads." >&2
    exit 1
  fi

  local zip_file="${GEONAMES_DATASET}.zip"
  echo "Downloading ${zip_file}..."
  curl -fsSL "https://download.geonames.org/export/dump/${zip_file}" -o "${SOURCE_DIR}/${zip_file}"
  unzip -o -q "${SOURCE_DIR}/${zip_file}" -d "${SOURCE_DIR}"
}

download_and_extract_dataset_if_missing
download_if_missing "${COUNTRY_FILE}" "https://download.geonames.org/export/dump/${COUNTRY_FILE}"
if [[ "${GEONAMES_INCLUDE_ADMIN1}" == "1" ]]; then
  download_if_missing "${ADMIN1_FILE}" "https://download.geonames.org/export/dump/${ADMIN1_FILE}"
fi

echo "Preparing TSV files in ${TMP_DIR}..."
echo "Feature codes: ${GEONAMES_FEATURE_CODES}"
echo "Minimum population: ${GEONAMES_MIN_POPULATION}"
echo "Minimum population for PPL: ${GEONAMES_PPL_MIN_POPULATION}"
echo "PPL dedupe enabled: ${GEONAMES_PPL_DEDUP}"
echo "PPL dedupe near radius (km): ${GEONAMES_PPL_DEDUP_NEAR_KM}"
echo "PPL dedupe related-name radius (km): ${GEONAMES_PPL_DEDUP_NAME_NEAR_KM}"
echo "Include admin1: ${GEONAMES_INCLUDE_ADMIN1}"
rm -f "${TMP_DIR}/features.tsv" "${TMP_DIR}/coordinates.tsv"
awk -v feature_codes="${GEONAMES_FEATURE_CODES}" -v min_population="${GEONAMES_MIN_POPULATION}" -v ppl_min_population="${GEONAMES_PPL_MIN_POPULATION}" -v ppl_dedup="${GEONAMES_PPL_DEDUP}" -v ppl_dedup_near_km="${GEONAMES_PPL_DEDUP_NEAR_KM}" -v ppl_dedup_name_near_km="${GEONAMES_PPL_DEDUP_NAME_NEAR_KM}" -v include_admin1="${GEONAMES_INCLUDE_ADMIN1}" -v features_out="${TMP_DIR}/features.tsv" -v coordinates_out="${TMP_DIR}/coordinates.tsv" 'BEGIN {
  FS="\t";
  OFS=";";
  pi = 3.141592653589793;
  anchor_codes["PPLC"] = 1;
  anchor_codes["PPLA"] = 1;
  anchor_codes["PPLA2"] = 1;
  anchor_codes["PPLA3"] = 1;
  anchor_codes["PPLA4"] = 1;
  anchor_codes["PPLA5"] = 1;
  split(feature_codes, raw_codes, ",");
  for (i in raw_codes) {
    code = raw_codes[i];
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", code);
    if (code != "") {
      allowed_codes[code] = 1;
    }
  }
}
function normalize_name(value, lowered) {
  lowered = tolower(value);
  gsub(/[^a-z0-9]+/, " ", lowered);
  gsub(/^ +| +$/, "", lowered);
  gsub(/ +/, " ", lowered);
  return lowered;
}
function admin_key(country, admin1, admin2) {
  return country "|" admin1 "|" admin2;
}
function add_anchor(key, latitude, longitude, normalized_name, idx) {
  idx = ++anchor_count[key];
  anchor_lat[key, idx] = latitude + 0;
  anchor_lon[key, idx] = longitude + 0;
  anchor_name[key, idx] = normalized_name;
}
function distance_km(lat1, lon1, lat2, lon2, lat_km, lon_km, avg_lat_rad, dlat, dlon) {
  lat_km = 111.32;
  avg_lat_rad = ((lat1 + lat2) / 2.0) * pi / 180.0;
  lon_km = 111.32 * cos(avg_lat_rad);
  dlat = (lat1 - lat2) * lat_km;
  dlon = (lon1 - lon2) * lon_km;
  return sqrt(dlat * dlat + dlon * dlon);
}
function contains_phrase(haystack, needle, padded) {
  if (haystack == "" || needle == "") {
    return 0;
  }
  padded = " " haystack " ";
  return index(padded, " " needle " ") > 0;
}
function names_related(name_a, name_b) {
  if (name_a == "" || name_b == "") {
    return 0;
  }
  if (name_a == name_b) {
    return 1;
  }
  return contains_phrase(name_a, name_b) || contains_phrase(name_b, name_a);
}
function should_suppress_ppl(record_index, key, count, candidate_lat, candidate_lon, candidate_name, anchor_index, distance) {
  if (ppl_dedup != "1") {
    return 0;
  }
  count = anchor_count[key];
  if (count == 0) {
    return 0;
  }

  candidate_lat = record_lat[record_index];
  candidate_lon = record_lon[record_index];
  candidate_name = record_normalized_name[record_index];

  for (anchor_index = 1; anchor_index <= count; anchor_index++) {
    distance = distance_km(candidate_lat, candidate_lon, anchor_lat[key, anchor_index], anchor_lon[key, anchor_index]);
    if (distance <= ppl_dedup_near_km) {
      return 1;
    }
    if (distance <= ppl_dedup_name_near_km && names_related(candidate_name, anchor_name[key, anchor_index])) {
      return 1;
    }
  }

  return 0;
}
{
  if (!($8 in allowed_codes)) {
    next;
  }

  population = ($15 == "" ? 0 : $15);
  if (population < min_population) {
    next;
  }
  if ($8 == "PPL" && population < ppl_min_population) {
    next;
  }

  feature_name = $2;
  asciiname = $3;
  gsub("\"", "", feature_name);
  gsub(";", "", feature_name);
  gsub("\"", "", asciiname);
  gsub(";", "", asciiname);

  id = $1;
  latitude = $5 + 0;
  longitude = $6 + 0;
  feature_code = $8;
  country_id = $9;
  admin1_id = (include_admin1 == "1" ? $11 : "");
  admin2_id = $12;
  normalized_name = normalize_name(asciiname != "" ? asciiname : feature_name);

  record_count++;
  record_id[record_count] = id;
  record_name[record_count] = feature_name;
  record_asciiname[record_count] = asciiname;
  record_country[record_count] = country_id;
  record_admin1[record_count] = admin1_id;
  record_admin2[record_count] = admin2_id;
  record_population[record_count] = population;
  record_lat[record_count] = latitude;
  record_lon[record_count] = longitude;
  record_feature_code[record_count] = feature_code;
  record_normalized_name[record_count] = normalized_name;

  if (feature_code in anchor_codes && admin2_id != "") {
    add_anchor(admin_key(country_id, admin1_id, admin2_id), latitude, longitude, normalized_name);
  }
}
END {
  suppressed_ppl_count = 0;

  for (i = 1; i <= record_count; i++) {
    if (record_feature_code[i] == "PPL" && record_admin2[i] != "") {
      key = admin_key(record_country[i], record_admin1[i], record_admin2[i]);
      if (should_suppress_ppl(i, key)) {
        suppressed_ppl_count++;
        continue;
      }
    }

    print record_id[i],record_name[i],record_asciiname[i],record_country[i],record_admin1[i],record_population[i] >> features_out;
    print record_id[i],record_lat[i],record_lon[i] >> coordinates_out;
  }

  if (ppl_dedup == "1") {
    print "Suppressed PPL duplicates: " suppressed_ppl_count > "/dev/stderr";
  }
}' "${SOURCE_DIR}/${DATA_FILE}"

if [[ "${GEONAMES_INCLUDE_ADMIN1}" == "1" ]]; then
  awk 'BEGIN { FS="\t"; OFS=";" }
  {
    split($1, id, ".");
    gsub("\"", "", $2);
    gsub(";", "", $2);
    print id[1],id[2],$2
  }' "${SOURCE_DIR}/${ADMIN1_FILE}" > "${TMP_DIR}/admin1.tsv"
else
  : > "${TMP_DIR}/admin1.tsv"
fi

grep -vE '^#' "${SOURCE_DIR}/${COUNTRY_FILE}" | awk 'BEGIN { FS="\t"; OFS=";" }
{
  gsub("\"", "", $5);
  gsub(";", "", $5);
  print $1,$5
}' > "${TMP_DIR}/countries.tsv"

rm -f "${OUTPUT}"
echo "Building ${OUTPUT}..."

{
  cat "${SCHEMA_FILE}"
  cat <<'SQL'
.separator ";"
.import .geonames-build/coordinates.tsv coordinates
.import .geonames-build/features.tsv features
.import .geonames-build/admin1.tsv admin1
.import .geonames-build/countries.tsv countries
SQL
} | (
  cd "${GEONAMES_WORKDIR}" &&
  sqlite3 "${OUTPUT}"
)

COUNT="$(sqlite3 "${OUTPUT}" "SELECT COUNT(*) FROM features;")"
echo "Created ${OUTPUT} with ${COUNT} features."
