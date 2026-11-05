#!/usr/bin/env bash
# One-off setup: our own Photon geocoder (address/place search) on the Oracle box, so WayGo's
# /api/places stops leaning on the public Photon and Nominatim servers (their policies limit
# heavy and commercial use; Nominatim forbids search-as-you-type outright).
#
#   ssh ubuntu@152.67.98.226 'bash -s' < scripts/setup-photon.sh
#
# What it does:
#  - Photon 1.3.0 + the Australia/Oceania index (~1.9 GB download) in ~/photon, as the
#    `photon` systemd service, listening on 127.0.0.1:2322 only
#  - Caddy on port 80 (already open in the OCI security list) passing /photon/* to Photon,
#    but only for requests carrying the X-WayGo-Key header; everything else gets a 404
#  - opens port 80 in iptables (persisted), like 8080 for OTP
#  - prints PHOTON_URL and PHOTON_KEY to set in Vercel (then redeploy the API)
# Re-running is safe: downloads are skipped when present, the key is kept.
set -euo pipefail

PH=/home/ubuntu/photon
JAR_URL=https://github.com/komoot/photon/releases/download/1.3.0/photon-1.3.0.jar
DB_URL=https://download1.graphhopper.com/public/australia-oceania/photon-db-australia-oceania-1.0-latest.tar.bz2

sudo apt-get update -qq
sudo apt-get install -y -qq lbzip2 caddy iptables-persistent >/dev/null

mkdir -p "$PH" && cd "$PH"
[ -s photon.jar ] || curl -sSfL -o photon.jar "$JAR_URL"
if [ ! -d photon_data ]; then
    echo "Downloading and unpacking the index (a few minutes)…"
    curl -sSfL "$DB_URL" | lbzip2 -dc | tar x
fi

sudo tee /etc/systemd/system/photon.service >/dev/null <<EOF
[Unit]
Description=Photon geocoder (WayGo address search)
After=network.target

[Service]
User=ubuntu
WorkingDirectory=$PH
ExecStart=/usr/bin/java -Xmx3G -jar $PH/photon.jar serve -data-dir $PH -listen-ip 127.0.0.1 -listen-port 2322
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

# Shared secret between the WayGo API and Caddy: generated once, kept on re-runs
KEY_FILE=$PH/waygo-key
[ -s "$KEY_FILE" ] || openssl rand -hex 24 > "$KEY_FILE"
KEY=$(cat "$KEY_FILE")

sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
:80 {
    @photon {
        path /photon/*
        header X-WayGo-Key $KEY
    }
    handle @photon {
        uri strip_prefix /photon
        reverse_proxy 127.0.0.1:2322
    }
    respond 404
}
EOF

sudo iptables -C INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 5 -p tcp --dport 80 -j ACCEPT
sudo netfilter-persistent save >/dev/null

sudo systemctl daemon-reload
sudo systemctl enable --now photon
sudo systemctl restart caddy

echo "Waiting for Photon to start…"
for i in $(seq 1 60); do curl -sf "http://127.0.0.1:2322/api?q=Suncorp%20Stadium&limit=1" >/dev/null && break; sleep 5; done
curl -s "http://127.0.0.1:2322/api?q=Suncorp%20Stadium&limit=1" | head -c 300; echo

echo
echo "Set these in Vercel (translink-api project → Settings → Environment Variables), then redeploy:"
echo "  PHOTON_URL=http://$(curl -s ifconfig.me)/photon"
echo "  PHOTON_KEY=$KEY"
