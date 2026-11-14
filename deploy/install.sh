#!/usr/bin/env bash
# One-command install on a fresh Ubuntu VM (tested target: Oracle Cloud
# Always Free, Ampere A1, Ubuntu 24.04).
#
#   curl -fsSL https://raw.githubusercontent.com/rochano/event-analytics/main/deploy/install.sh | bash
#
# Optional settings (export before running, or edit .env afterwards):
#   DOMAIN=example.com        use ingest.example.com / analytics.example.com
#                             (default: free <ip>.sslip.io names, no DNS needed)
#   ALLOWED_ORIGINS=...       comma list of game sites allowed to send events
# Re-running is safe: secrets in .env are kept.
set -euo pipefail

REPO_URL=${REPO_URL:-https://github.com/rochano/event-analytics.git}
DIR=${DIR:-$HOME/event-analytics}
say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

say "Installing Docker (if needed)"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
fi
sudo systemctl enable --now docker >/dev/null 2>&1 || true
DOCKER="docker"
docker info >/dev/null 2>&1 || DOCKER="sudo docker"

say "Opening ports 80 and 443 in the VM firewall"
# Oracle's Ubuntu images ship iptables rules that reject everything except SSH,
# even when the cloud security list allows the port.
for p in 80 443; do
  sudo iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null ||
    sudo iptables -I INPUT 5 -p tcp --dport "$p" -m state --state NEW -j ACCEPT 2>/dev/null ||
    sudo iptables -I INPUT -p tcp --dport "$p" -j ACCEPT
done
if command -v netfilter-persistent >/dev/null; then sudo netfilter-persistent save >/dev/null 2>&1 || true; fi

say "Getting the code"
command -v git >/dev/null || { sudo apt-get update -qq && sudo apt-get install -y -qq git; }
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone "$REPO_URL" "$DIR"; fi
cd "$DIR"

say "Writing settings (.env)"
rand() { head -c 64 /dev/urandom | tr -dc 'a-zA-Z0-9' | head -c "$1"; }
touch .env && chmod 600 .env
setdef() { grep -q "^$1=" .env || echo "$1=$2" >> .env; }
IP=$(curl -4 -fsS https://api.ipify.org || curl -4 -fsS https://ifconfig.me)
if [ -n "${DOMAIN:-}" ]; then
  setdef INGEST_HOST "ingest.$DOMAIN"; setdef DASH_HOST "analytics.$DOMAIN"
else
  setdef INGEST_HOST "ingest.${IP//./-}.sslip.io"; setdef DASH_HOST "analytics.${IP//./-}.sslip.io"
fi
setdef CLICKHOUSE_PASSWORD "$(rand 32)"
setdef QUERY_API_PASSWORD "$(rand 32)"
setdef WRITE_KEY "pk_$(rand 24)"
setdef READ_KEY "rk_$(rand 24)"
setdef ALLOWED_ORIGINS "${ALLOWED_ORIGINS:-*}"
setdef RETENTION_DAYS 395
set -a; . ./.env; set +a

DC="$DOCKER compose -f docker-compose.yml -f deploy/docker-compose.prod.yml"

say "Starting the database (first start takes a few minutes)"
$DC up -d --build clickhouse
for i in $(seq 1 90); do
  $DC exec -T clickhouse clickhouse-client --password "$CLICKHOUSE_PASSWORD" -q 'SELECT 1 FROM analytics.events LIMIT 1' >/dev/null 2>&1 && break
  sleep 5
done
# schema.sql creates query_api with a dev password; replace it with ours.
$DC exec -T clickhouse clickhouse-client --password "$CLICKHOUSE_PASSWORD" \
  -q "ALTER USER query_api IDENTIFIED WITH sha256_password BY '$QUERY_API_PASSWORD'"

say "Starting everything"
$DC up -d --build
sleep 5
$DC ps

cat <<MSG

==========================================================
 Done. Save these (also in $DIR/.env):

 Dashboard : https://$DASH_HOST/?key=$READ_KEY
 Collector : https://$INGEST_HOST/e
 Write key : $WRITE_KEY   (goes in the game)
 Read key  : $READ_KEY    (opens the dashboard; keep private)

 In the game:
   <script src="https://$DASH_HOST/sdk/analytics.js"></script>
   gstats.init({ key: "$WRITE_KEY", host: "https://$INGEST_HOST" })

 HTTPS certificates can take a minute on first visit.
 Logs:    cd $DIR && $DC logs -f collector
 Update:  re-run this script
==========================================================
MSG
