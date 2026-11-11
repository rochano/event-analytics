# Deploy on one free VM (Oracle Cloud Always Free)

This runs the whole stack from `docker-compose.yml` on a single machine. It suits personal sites, small games and pilots: no high availability, but nothing is lost if a single service restarts, because events wait in Redpanda or the collector's disk spool.

Free-tier terms change; check the provider's current limits before you sign up. At the time of writing, Oracle's Always Free tier includes Arm (Ampere A1) compute that can be shaped as one VM with 4 OCPU and 24 GB RAM, which is plenty for this stack. Any other VM with 4 vCPU / 8 GB or more works the same way.

## 1. Create the VM

1. Sign up at Oracle Cloud and pick a home region close to your users (for Thailand, Singapore).
2. Create an instance: image **Ubuntu 24.04**, shape **VM.Standard.A1.Flex**, 4 OCPU, 24 GB RAM, boot volume 100 GB or more.
3. Add your SSH key. Note the public IP.
4. In the VCN security list, allow inbound TCP **80** and **443** only (keep 8080/8081/8123/9000/19092 closed to the internet).

## 2. Install Docker and the app

```bash
ssh ubuntu@<public-ip>
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker
git clone https://github.com/rochano/event-analytics.git && cd event-analytics
```

Before starting, edit secrets:

- `docker-compose.yml`: `CLICKHOUSE_PASSWORD`, the `PROJECTS` keys (`pk_...` write key, `rk_...` read key) and allowed origins.
- `clickhouse/schema.sql`: the `query_api` password (and the matching `CLICKHOUSE_PASSWORD` of `queryapi`).
- `COLLECTOR_PUBLIC_URL`: `https://ingest.your-domain.com`.

Bind the service ports to localhost only so they are reachable just through the reverse proxy: change `"8080:8080"` to `"127.0.0.1:8080:8080"`, and the same for 8081, 8123, 9000 and 19092.

```bash
docker compose up -d --build
docker compose ps
```

## 3. HTTPS with Caddy

```bash
sudo apt install -y caddy
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
ingest.your-domain.com {
    reverse_proxy 127.0.0.1:8080
}
analytics.your-domain.com {
    reverse_proxy 127.0.0.1:8081
}
EOF
sudo systemctl reload caddy
```

Point both DNS names at the VM's IP. Caddy gets certificates automatically.

Optional: put the domains behind Cloudflare's free plan (proxied, orange cloud) for DDoS protection and bot filtering. The collector reads the `CF-IPCountry` header for country stats.

## 4. Use it

- Dashboard: `https://analytics.your-domain.com/?key=<read key>`
- SDK: `<script src="https://analytics.your-domain.com/sdk/analytics.js"></script>` then `pulse.init({ key: "<write key>", host: "https://ingest.your-domain.com" })`
- Games and servers: `POST https://ingest.your-domain.com/e` (see [INTEGRATION.md](INTEGRATION.md))

## 5. Operations

| Task | Command |
| --- | --- |
| Logs | `docker compose logs -f collector` |
| Collector counters | `curl -s localhost:8080/metrics` |
| Ingest errors | `docker compose exec clickhouse clickhouse-client --password <pw> -q "SELECT * FROM analytics.ingest_errors ORDER BY ts DESC LIMIT 20"` |
| Disk usage by table | `... -q "SELECT table, formatReadableSize(sum(bytes_on_disk)) FROM system.parts WHERE active GROUP BY table"` |
| Backup | `... -q "BACKUP DATABASE analytics TO File('backup-$(date +%F)')"` after adding a `backups` disk, or snapshot the boot volume |
| Update | `git pull && docker compose up -d --build` |

When one VM is no longer enough, follow the scale-out path in [architecture.md](architecture.md): move ClickHouse and Redpanda to their own nodes first, then add collector instances behind a load balancer.
