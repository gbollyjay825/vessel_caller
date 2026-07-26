#!/usr/bin/env bash

configure_libpq_from_env() {
  local variable_name="$1"
  local state_dir="$2"
  local database_url="${!variable_name:-}"
  local pgpass_file="${state_dir}/.pgpass"
  local exports_file="${state_dir}/.libpq-env"

  if [[ -z "${database_url}" ]]; then
    echo "${variable_name} is required" >&2
    return 1
  fi

  LIBPQ_DATABASE_URL="${database_url}" \
  LIBPQ_PGPASSFILE="${pgpass_file}" \
  LIBPQ_EXPORTS_FILE="${exports_file}" \
    python3 - <<'PY'
import os
import shlex
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

parsed = urlparse(os.environ["LIBPQ_DATABASE_URL"])
if parsed.scheme not in {"postgres", "postgresql"}:
    raise SystemExit("Database URL must use postgres:// or postgresql://")
if not all((parsed.hostname, parsed.path, parsed.username)):
    raise SystemExit("Database URL is missing host, database, or user")

host = parsed.hostname
port = str(parsed.port or 5432)
database = unquote(parsed.path.lstrip("/"))
user = unquote(parsed.username)
password = unquote(parsed.password or "")
query = parse_qs(parsed.query)
sslmode = query.get("sslmode", ["prefer"])[0]

def pgpass_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace(":", "\\:")

Path(os.environ["LIBPQ_PGPASSFILE"]).write_text(
    ":".join(pgpass_escape(value) for value in (host, port, database, user, password)) + "\n",
    encoding="utf-8",
)
exports = {
    "PGHOST": host,
    "PGPORT": port,
    "PGDATABASE": database,
    "PGUSER": user,
    "PGSSLMODE": sslmode,
    "PGPASSFILE": os.environ["LIBPQ_PGPASSFILE"],
}
Path(os.environ["LIBPQ_EXPORTS_FILE"]).write_text(
    "".join(f"export {name}={shlex.quote(value)}\n" for name, value in exports.items()),
    encoding="utf-8",
)
PY
  chmod 0600 "${pgpass_file}" "${exports_file}"
  # The file is generated locally from parsed non-secret connection fields.
  # shellcheck disable=SC1090
  source "${exports_file}"
  rm -f "${exports_file}"
}
