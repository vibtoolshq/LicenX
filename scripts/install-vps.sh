#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
cd "$ROOT"

DOMAIN=""
EMAIL=""
CHECK_ONLY=0
INSTALL_MODE=standalone
HOST_PORT=13001
while (( $# )); do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --check) CHECK_ONLY=1; shift ;;
    --mode) INSTALL_MODE="$2"; shift 2 ;;
    --host-port) HOST_PORT="$2"; shift 2 ;;
    *) echo "Usage: bash scripts/install-vps.sh --domain license.example.com --email owner@example.com [--mode standalone|existing-proxy] [--host-port 13001] [--check]" >&2; exit 2 ;;
  esac
done

if [[ "$INSTALL_MODE" != standalone && "$INSTALL_MODE" != existing-proxy ]]; then echo "Invalid mode" >&2; exit 2; fi
if [[ ! "$HOST_PORT" =~ ^[0-9]+$ ]] || (( HOST_PORT < 1024 || HOST_PORT > 65535 )); then echo "Invalid host port" >&2; exit 2; fi
if [[ ! -r /etc/os-release ]]; then echo "Ubuntu 24.04 required" >&2; exit 1; fi
# shellcheck source=/dev/null
source /etc/os-release
if [[ "$ID" != ubuntu || "$VERSION_ID" != 24.04 ]]; then echo "Only Ubuntu 24.04 LTS supported" >&2; exit 1; fi
if [[ ! "$DOMAIN" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$ ]]; then
  echo "Invalid domain" >&2; exit 1
fi
if [[ ! "$EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
  echo "Invalid email" >&2; exit 1
fi
for tool in docker openssl git; do
  if ! command -v "$tool" >/dev/null; then
    echo "Missing $tool. On Ubuntu 24.04 install Docker Engine and Compose plugin first; see README." >&2
    exit 1
  fi
done
if ! docker compose version >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Docker daemon / Compose plugin unavailable. Install and start Docker first." >&2; exit 1
fi
if [[ ! -f "$ROOT/.env" && "$INSTALL_MODE" == standalone ]]; then
  if command -v ss >/dev/null 2>&1 && ss -H -ltn | awk '{print $4}' | grep -Eq '(^|:)(80|443)$'; then
    echo "Ports 80/443 are occupied. Use existing proxy integration; do not replace services." >&2
    exit 1
  fi
  if [[ "$DOMAIN" != localhost ]] && ! getent ahostsv4 "$DOMAIN" >/dev/null; then
    echo "Domain must resolve before standalone HTTPS installation." >&2; exit 1
  fi
fi
if [[ ! -f "$ROOT/.env" && "$INSTALL_MODE" == existing-proxy ]] && command -v ss >/dev/null 2>&1; then
  if ss -H -ltn | awk '{print $4}' | grep -Eq "(^|:)${HOST_PORT}$"; then
    echo "Host port $HOST_PORT already used; select another --host-port without modifying existing services." >&2
    exit 1
  fi
fi
if [[ "$CHECK_ONLY" -eq 1 ]]; then
  echo "Ubuntu, Docker, Compose, domain, email and port preflight passed (no changes)."
  exit 0
fi

if [[ -f "$ROOT/.env" ]]; then
  if ! grep -Fxq "DOMAIN=$DOMAIN" "$ROOT/.env" || ! grep -Fxq "ACME_EMAIL=$EMAIL" "$ROOT/.env"; then
    echo "Existing installation has different domain/email; refusing to overwrite configuration." >&2
    exit 1
  fi
  chmod 600 "$ROOT/.env"
  if ! grep -q '^OWNER_SETUP_CODE_SHA256=[a-f0-9]\{64\}$' "$ROOT/.env"; then
    echo "Existing .env has no valid owner code hash; refusing to replace or rotate credentials." >&2
    exit 1
  fi
  echo "Existing configuration preserved; no owner credentials rotated."
else
  if [[ -e "$ROOT/.env.owner-setup" ]]; then
    echo "Orphaned owner code file found. Manual review required." >&2; exit 1
  fi
  db_password="$(openssl rand -hex 32)"
  owner_code="$(openssl rand -hex 32)"
  owner_hash="$(printf '%s' "$owner_code" | openssl dgst -sha256 -r | cut -d' ' -f1)"
  tmp_env="$(mktemp "$ROOT/.env.XXXXXXXX")"
  trap 'rm -f "$tmp_env"' EXIT
  cat > "$tmp_env" <<EOF
DOMAIN=$DOMAIN
ACME_EMAIL=$EMAIL
POSTGRES_DB=licenx
POSTGRES_USER=licenx
POSTGRES_PASSWORD=$db_password
DATABASE_URL=postgresql://licenx:$db_password@postgres:5432/licenx?sslmode=disable
OWNER_SETUP_CODE_SHA256=$owner_hash
EOF
  chmod 600 "$tmp_env"
  mv -n "$tmp_env" "$ROOT/.env"
  printf '%s\n' "$owner_code" > "$ROOT/.env.owner-setup"
  chmod 600 "$ROOT/.env.owner-setup"
  unset db_password owner_hash
  if [[ -t 1 ]]; then
    printf '\nOwner setup code (keep private; also saved in .env.owner-setup): %s\n' "$owner_code"
  else
    echo "Owner setup code securely saved to .env.owner-setup (not printed in non-interactive logs)."
  fi
  unset owner_code
fi

if [[ "$INSTALL_MODE" == standalone ]]; then
  docker compose --env-file "$ROOT/.env" --profile standalone-https config --quiet
  docker compose --env-file "$ROOT/.env" --profile standalone-https up --detach --build --wait --wait-timeout 180
  echo "Installation ready: https://$DOMAIN/vcon"
else
  export LICENX_HOST_PORT="$HOST_PORT"
  docker compose --env-file "$ROOT/.env" -f compose.yaml -f deploy/compose.existing-proxy.yaml config --quiet
  docker compose --env-file "$ROOT/.env" -f compose.yaml -f deploy/compose.existing-proxy.yaml up --detach --build --wait --wait-timeout 180
  echo "LicenX isolated stack ready at localhost port $HOST_PORT (HTTP only)."
  echo "Configure a trusted HTTPS route for $DOMAIN via an explicitly approved proxy before public use."
fi
echo "To rerun, use the same --domain and --email; the existing .env and volumes are preserved."
