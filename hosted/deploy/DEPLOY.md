# Standing the Ripcord frontend up on a droplet

A dedicated, throwaway box. Build locally, copy the `hosted/` tree onto a fresh DigitalOcean droplet, run
one Node process behind Caddy for TLS, and that's it.

DO's smallest droplet ($4/mo, 512 MB / 1 vCPU / 10 GB) is plenty: one Node process serving a single page and
a 600 KB image, and forwarding read-only RPC calls. Idle it sits around 60 MB for Node and 20 MB for Caddy.

## What the box needs

Node 20 or later, for `view-proxy.js`.

`READ_RPC`, the URL of your read-only Ethereum endpoint. It is a remote service; the node itself does not run
on this droplet. Set it in `/etc/ripcord.env`. This is the one value that stays out of the repo and lives
only on the box.

A domain pointed at the droplet, for TLS via Caddy.

No PAT, no wallet key, no SSH-into-app key. Nothing here signs or submits, so no signing key belongs on the
box. A PAT only matters if you clone a private repo rather than copying the folder up.

## Steps

```bash
# 1. as root on the fresh droplet: user, node, caddy
adduser --system --group ripcord
apt-get update && apt-get install -y ca-certificates curl gnupg apt-transport-https debian-keyring debian-archive-keyring
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs
# caddy lives in its own apt repo, not Ubuntu's:
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy

# 2. copy the code up (from your machine). only hosted/ is needed to serve it.
#    rsync carries gitignored files too, so this works whether or not it is a repo.
rsync -a ./hosted/ root@DROPLET_IP:/opt/ripcord/hosted/
#    (on the droplet:)
chown -R ripcord:ripcord /opt/ripcord

# 3. the one value that stays off the repo: your remote read endpoint
cat >/etc/ripcord.env <<'EOF'
READ_RPC=https://your-read-endpoint
PORT=8899
EOF
chmod 600 /etc/ripcord.env

# 4. service
cp /opt/ripcord/hosted/deploy/ripcord.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now ripcord
systemctl status ripcord --no-pager

# 5. TLS + reverse proxy (edit the domain in the Caddyfile first).
#    no domain yet? use nip.io: set the site address to <DROPLET_IP>.nip.io and
#    caddy gets a real Let's Encrypt cert with no DNS setup at all.
cp /opt/ripcord/hosted/deploy/Caddyfile /etc/caddy/Caddyfile
systemctl reload caddy

# 6. firewall: only 80/443 and ssh
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
```

Visit `https://your-domain`. The page loads straight in, reads through `/read` (which forwards to `READ_RPC`,
and that upstream is never named to the client), and anything the operator submits goes from their browser to
a relay they type in.

## Updating

```bash
rsync -a ./hosted/ root@DROPLET_IP:/opt/ripcord/hosted/
ssh root@DROPLET_IP systemctl restart ripcord   # HTML/JS are served no-cache
```

## Notes

`READ_RPC` is the only value kept off GitHub. It is not in the repo; it lives only in `/etc/ripcord.env` on
the droplet. The client never sees it, since the page talks to same-origin `/read` and the proxy forwards
server-side.

The proxy refuses any non-read RPC method, so the endpoint behind `READ_RPC` cannot be turned into a
submission path through this box, even if someone tries.

Treat it as a throwaway box. Rebuild it, rotate its SSH access, and change `READ_RPC` on whatever cadence
suits you; none of that is the app's job.
