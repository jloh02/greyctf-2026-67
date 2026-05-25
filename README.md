<!--
Copy this README.md when starting a new challenge.

Required sections are Name, Description, Author, and Flag.

Read the Whale section below if the challenge needs per-team/per-user instances.
-->

# Name
67

# Description

Can you 67 on a merry christmas?

# Author
jloh02

# Flag
`grey{676676767676767_0110_0111_0110_0111_736978736576656E}`

# Challenge

Play flappy bird with 67 hand gestures

# Diagnostics

The hand-tracking diagnostic route is disabled by default. Start the frontend
with `DIAGNOSTIC_PAGE=true` to expose `/diagnostics`:

```sh
DIAGNOSTIC_PAGE=true npm run start:frontend
```

Open `http://127.0.0.1:4173/diagnostics` to view live hand-height, delta, threshold,
cross-count, and jump-trigger markers.

For Docker Compose, pass `DIAGNOSTIC_PAGE=true`; Compose forwards it to the
backend container, which serves `/diagnostics` when enabled.

# Local Development

The local stack lives in
[docker-compose.local.yml](/Users/jloh02/Documents/Programming/i26-q/docker-compose.local.yml).
Run:

```sh
docker compose -f docker-compose.local.yml up -d backend
```

The app will be available at:

```sh
http://127.0.0.1:8787
```

# HTTPS Deployment

The default [docker-compose.yml](/Users/jloh02/Documents/Programming/i26-q/docker-compose.yml)
is the production stack. It adds Nginx in front of the backend for TLS
termination, so a dedicated server can simply run `docker compose up -d`.

Set these environment variables before starting:

```sh
export SERVER_NAME=your-domain.example
export CERTBOT_DOMAIN=$SERVER_NAME
export HTTPS_PORT=4173
```

For the first issuance, start only the backend from the production file:

```sh
docker compose up -d backend
```

Nginx expects host-managed Let's Encrypt files at:

```sh
/etc/letsencrypt/live/$CERTBOT_DOMAIN/fullchain.pem
/etc/letsencrypt/live/$CERTBOT_DOMAIN/privkey.pem
```

For HTTP-01 validation with host Certbot, use the shared webroot:

```sh
sudo certbot certonly --webroot -w "$(pwd)/certbot/www" -d "$CERTBOT_DOMAIN"
docker compose up -d webserver
```

After the certificate exists, normal startup is:

```sh
docker compose up -d
```
