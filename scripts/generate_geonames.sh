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

GEONAMES_DATASET="${GEONAMES_DATASET:-cities1000}"
GEONAMES_WORKDIR="${GEONAMES_WORKDIR:-$(pwd)}"
GEONAMES_DOWNLOAD="${GEONAMES_DOWNLOAD:-1}"
OUTPUT="${1:-db.sqlite}"

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
download_if_missing "${ADMIN1_FILE}" "https://download.geonames.org/export/dump/${ADMIN1_FILE}"
download_if_missing "${COUNTRY_FILE}" "https://download.geonames.org/export/dump/${COUNTRY_FILE}"

echo "Preparing TSV files in ${TMP_DIR}..."
awk 'BEGIN { FS="\t"; OFS=";" }
{
  gsub("\"", "", $2);
  gsub(";", "", $2);
  gsub("\"", "", $3);
  gsub(";", "", $3);
  population = ($15 == "" ? 0 : $15);
  print $1,$2,$3,$9,$11,population
}' "${SOURCE_DIR}/${DATA_FILE}" > "${TMP_DIR}/features.tsv"

awk 'BEGIN { FS="\t"; OFS=";" }
{
  print $1,$5,$6
}' "${SOURCE_DIR}/${DATA_FILE}" > "${TMP_DIR}/coordinates.tsv"

awk 'BEGIN { FS="\t"; OFS=";" }
{
  split($1, id, ".");
  gsub("\"", "", $2);
  gsub(";", "", $2);
  print id[1],id[2],$2
}' "${SOURCE_DIR}/${ADMIN1_FILE}" > "${TMP_DIR}/admin1.tsv"

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
