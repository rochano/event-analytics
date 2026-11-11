# Deploy on one free VM (Oracle Cloud Always Free)

This runs the whole stack from `docker-compose.yml` on a single machine. It suits personal sites, small games and pilots: no high availability, but nothing is lost if a single service restarts, because events wait in Redpanda or the collector's disk spool.

Free-tier terms change; check the provider's current limits before you sign up. At the time of writing, Oracle's Always Free tier includes Arm (Ampere A1) compute that can be shaped as one VM with 4 OCPU and 24 GB RAM, which is plenty for this stack. Any other VM with 4 vCPU / 8 GB or more works the same way.

## 1. Create the VM

1. Sign up at Oracle Cloud and pick a home region close to your users (for Thailand, Singapore).
2. Create an instance: image **Ubuntu 24.04**, shape **VM.Standard.A1.Flex**, 4 OCPU, 24 GB RAM, boot volume 100 GB or more.
3. Add your SSH key. Note the public IP.
4. In the VCN security list, allow inbound TCP **80** and **443** only (keep 8080/8081/8123/9000/19092 closed to the internet).

## 2. Install with one command

SSH in and run the installer:

```bash
ssh -i <your-key> ubuntu@<public-ip>
curl -fsSL https://raw.githubusercontent.com/rochano/event-analytics/main/deploy/install.sh | bash
```

It installs Docker, opens ports 80/443 in the VM firewall (Oracle's Ubuntu image blocks them even when the security list allows them), generates passwords and keys into `~/event-analytics/.env`, starts the stack with `deploy/docker-compose.prod.yml` (only Caddy is exposed; every other port stays private) and prints your links and keys.

With no domain, it uses free `sslip.io` names that point at your IP, for example `https://analytics.1-2-3-4.sslip.io`, and Caddy gets real HTTPS certificates for them. To use your own domain, point `ingest.<domain>` and `analytics.<domain>` at the VM and run with `DOMAIN=<domain>`.

To accept events only from your games, set the allowed origins (a `*.` wildcard covers preview deploys):

```bash
ALLOWED_ORIGINS="https://tavern-knights.pages.dev,https://*.tavern-knights.pages.dev,https://rochano.github.io" \
  bash ~/event-analytics/deploy/install.sh
```

Re-running the script is safe: it keeps the existing `.env` (edit that file to change a value, then re-run).

## 3. Use it

The installer prints these with your real values:

- Dashboard: `https://<analytics host>/?key=<read key>` (works on a phone)
- SDK: load `https://<analytics host>/sdk/analytics.js`, then `pulse.init({ key: "<write key>", host: "https://<ingest host>" })`
- Games and servers: `POST https://<ingest host>/e` (see [INTEGRATION.md](INTEGRATION.md))

Optional: put your own domain behind Cloudflare's free plan (proxied) for DDoS protection and bot filtering. The collector reads the `CF-IPCountry` header for country stats.

## 4. Operations

Run these in `~/event-analytics` after `set -a; . ./.env; set +a; DC="docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml"`:

| Task | Command |
| --- | --- |
| Status | `$DC ps` |
| Logs | `$DC logs -f collector` |
| Collector counters | `$DC exec caddy wget -qO- http://collector:8080/metrics` |
| Ingest errors | `$DC exec clickhouse clickhouse-client --password "$CLICKHOUSE_PASSWORD" -q "SELECT * FROM analytics.ingest_errors ORDER BY ts DESC LIMIT 20"` |
| Disk usage by table | `... -q "SELECT table, formatReadableSize(sum(bytes_on_disk)) FROM system.parts WHERE active GROUP BY table"` |
| Backup | snapshot the boot volume in the Oracle console, or `BACKUP DATABASE analytics ...` after adding a `backups` disk |
| Update | `bash deploy/install.sh` |

When one VM is no longer enough, follow the scale-out path in [architecture.md](architecture.md): move ClickHouse and Redpanda to their own nodes first, then add collector instances behind a load balancer.
