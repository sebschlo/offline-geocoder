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
#                         (default: PPLA,PPLA2,PPLA3,PPLA4,PPLA5,PPLC)
#                         Note: PPL can include neighborhood-like entries.
#   GEONAMES_MIN_POPULATION minimum population to keep (default: 0)
#   GEONAMES_INCLUDE_ADMIN1 set to 0 to skip admin1 import entirely (default: 1)

GEONAMES_DATASET="${GEONAMES_DATASET:-cities1000}"
GEONAMES_WORKDIR="${GEONAMES_WORKDIR:-$(pwd)}"
GEONAMES_DOWNLOAD="${GEONAMES_DOWNLOAD:-1}"
GEONAMES_FEATURE_CODES="${GEONAMES_FEATURE_CODES:-PPLA,PPLA2,PPLA3,PPLA4,PPLA5,PPLC}"
GEONAMES_MIN_POPULATION="${GEONAMES_MIN_POPULATION:-0}"
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
echo "Include admin1: ${GEONAMES_INCLUDE_ADMIN1}"
rm -f "${TMP_DIR}/features.tsv" "${TMP_DIR}/coordinates.tsv"
awk -v feature_codes="${GEONAMES_FEATURE_CODES}" -v min_population="${GEONAMES_MIN_POPULATION}" -v include_admin1="${GEONAMES_INCLUDE_ADMIN1}" -v features_out="${TMP_DIR}/features.tsv" -v coordinates_out="${TMP_DIR}/coordinates.tsv" 'BEGIN {
  FS="\t";
  OFS=";";
  split(feature_codes, raw_codes, ",");
  for (i in raw_codes) {
    code = raw_codes[i];
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", code);
    if (code != "") {
      allowed_codes[code] = 1;
    }
  }
}
{
  if (!($8 in allowed_codes)) {
    next;
  }

  population = ($15 == "" ? 0 : $15);
  if (population < min_population) {
    next;
  }

  gsub("\"", "", $2);
  gsub(";", "", $2);
  gsub("\"", "", $3);
  gsub(";", "", $3);
  admin1_id = (include_admin1 == "1" ? $11 : "");
  print $1,$2,$3,$9,admin1_id,population >> features_out;
  print $1,$5,$6 >> coordinates_out;
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
