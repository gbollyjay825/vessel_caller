# Vessel Caller Droplet deployment

The production deployment is isolated from the existing Flex School site:

- Nginx routes `vesselcalls.com` to Vessel Caller on ports `80` and `443`.
- HTTP redirects to HTTPS after the certificate is installed.
- FastAPI listens only on `127.0.0.1:8001`.
- Releases live below `/opt/vessel-caller/releases`.
- `/opt/vessel-caller/current` points at the active release.
- SQLite data persists in `/var/lib/vessel-caller`.
- Secrets and runtime settings live in
  `/etc/vessel-caller/vessel-caller.env`.

The checked-in Nginx and systemd definitions are installed as:

- `/etc/nginx/sites-available/vessel-caller`
- `/etc/systemd/system/vessel-caller.service`

Before the first certificate is issued, install
`nginx-vessel-caller-bootstrap.conf` so the ACME HTTP challenge is reachable.
After Certbot creates `/etc/letsencrypt/live/vesselcalls.com`, install
`nginx-vessel-caller.conf`.

Always run `nginx -t` before reloading Nginx.
