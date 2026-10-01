# donatelli.tech admin: deploy, backups and recovery

The admin (this repository, the "donatelli edition" of Swiish) is one Node 22 process with a
SQLite database. It holds the owner login, the connections that visitors send from the card,
and the website tools. The public card itself is a static page on Cloudflare Pages
(`https://donatelli.tech/card/`) and keeps working when this server is down; the card then
shows "Details not sent" with an email fallback.

Markers: **[ASSUMPTION]** the owner has not decided this yet; **[VERIFY]** check it on the
first real deploy.

## Hosting assumptions

- **[ASSUMPTION]** One container built from this repository's `Dockerfile`, on a host the
  owner chooses, for example a small VM with Docker Compose. The illustrative name used here
  is `admin.donatelli.tech`.
- **One instance only.** SQLite and the in-memory rate limiters do not share state, so never
  run two copies against the same data.
- **A persistent volume for `/app/data`.** It holds `cards.db` (accounts, connections, audit
  log) and `backups/`. Everything else in the container is disposable.
- **Exactly one TLS reverse-proxy hop** in front of the container (Caddy, nginx, or a
  Cloudflare Tunnel with no inbound ports). The server trusts one `X-Forwarded-For` hop, and
  the login limiter keys on that address: one IPv4 address, or one IPv6 /56 network. Compose
  publishes the port on `127.0.0.1:8095` only, so the proxy must run on the same host.
- **[VERIFY]** After the first deploy, confirm the server sees each visitor's own address (see
  "Check the proxy hop" below).

## First deploy

All commands in this section run in **Bash on the Linux host**, in the directory where the
repository is cloned.

1. Clone the repository.

   ```bash
   git clone https://github.com/Njdonatelli/donatelli.swiish.git && cd donatelli.swiish
   ```

   Success: `Cloning into 'donatelli.swiish'...` and the prompt is inside `donatelli.swiish`.

2. Create `.env` from the example, readable by your user only.

   ```bash
   cp .env.example .env && chmod 600 .env
   ```

   Success: no output.

3. Generate the three secrets into `.env` (each is 48 random bytes, 64 characters).

   ```bash
   for name in JWT_SECRET SETUP_TOKEN CONNECT_INGEST_SECRET; do sed -i "s|^$name=\$|$name=$(openssl rand -base64 48)|" .env; done
   ```

   Check:

   ```bash
   grep -cE '^(JWT_SECRET|SETUP_TOKEN|CONNECT_INGEST_SECRET)=.{64}$' .env
   ```

   Expected output: `3`

4. Open `.env` and set the non-secret values for your host.

   ```bash
   nano .env
   ```

   Set at least `APP_URL=https://<your admin host>` and `FORCE_HTTPS=true`. Set
   `BACKUP_INTERVAL_HOURS=24` to turn on daily backups. Leave `SITE_GITHUB_TOKEN` empty until
   the fine-grained token exists. Save with Ctrl+O, Enter, and exit with Ctrl+X. Every
   variable is described in `.env.example` and in the table below.

5. Build and start the container.

   ```bash
   docker compose up -d --build
   ```

   Success: the last line reads `Container swiish Started`.

6. Wait about 35 seconds for the first health check, then check the status.

   ```bash
   docker compose ps
   ```

   Success: the `STATUS` column shows `Up … (healthy)`.

   ```bash
   curl -s http://127.0.0.1:8095/api/health
   ```

   Expected output: `{"ok":true}`

   If the container keeps restarting, read why:

   ```bash
   docker compose logs --tail 20 swiish
   ```

   A configuration problem prints `Server not started: N configuration problems.` followed by
   one line per problem, each naming the variable and the fix. Correct `.env` and run step 5
   again.

7. Point the TLS proxy at `http://127.0.0.1:8095`, then open `https://<your admin host>/setup`.
   Enter the `SETUP_TOKEN` value from `.env`, the organisation name `donatelli.tech` (its slug
   `donatelli-tech` is what the card relay expects), your own email, and a password of at least
   12 characters. To print the token:

   ```bash
   grep '^SETUP_TOKEN=' .env
   ```

   Expected output: `SETUP_TOKEN=` followed by the 64-character value.

8. Remove the setup token and restart, so the setup form stays locked.

   ```bash
   sed -i 's|^SETUP_TOKEN=.*|SETUP_TOKEN=|' .env && docker compose up -d
   ```

   Success: the last line reads `Container swiish Started`. The setup form now refuses every
   request, even if someone reaches it.

### Check the proxy hop

[VERIFY] The login limiter allows 5 attempts per 15 minutes per IPv4 address or IPv6 /56
network. To confirm the server sees real visitor addresses rather than the proxy's:

1. On a phone using mobile data (not your Wi-Fi), open the admin login and enter a wrong
   password 6 times. The 6th attempt shows `Too many attempts from this network. Try again at …`.
2. On a laptop on your Wi-Fi, log in with the right password.

If the laptop logs in, each visitor has its own limit and the hop count is right. If the laptop
is also refused, every visitor shares the proxy's address: there is more than one proxy hop in
front of the server. Remove the extra hop or ask for help before going further; the phone's
limit clears after 15 minutes either way.

## Environment reference

Secrets are marked **secret**. Never commit them, never put them in a `REACT_APP_*` variable,
and keep `.env` at mode 600.

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` (Compose pins `production`) | Production turns on every boot check below |
| `PORT` | `3000` | Keep 3000 in Docker; Compose maps it to `127.0.0.1:8095` |
| `APP_URL` | required in production | The https admin origin: email links, the notification link, the allowed origin |
| `ALLOWED_ORIGINS` | the `APP_URL` origin | If set, it must include the `APP_URL` origin |
| `JWT_SECRET` (**secret**) | none | At least 32 characters; the example placeholder is refused |
| `JWT_EXPIRES_IN` | `24h` | Login lifetime; the cookie follows it. Seconds, or a number with `m`, `h` or `d` |
| `SETUP_TOKEN` (**secret**, one-time) | none | Required by `/setup` in production; remove after setup |
| `FORCE_HTTPS` | off | `true` behind the TLS proxy (the health check is exempt) |
| `ADMIN_TIME_ZONE` | `America/Los_Angeles` | Times in the status line and the notification email |
| `DEMO_MODE` | off | Must stay unset: the server refuses to start with it in production |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` (**secret**), `SMTP_FROM` | unset | Optional: reset emails and the new-connection email |
| `SITE_GITHUB_TOKEN` (**secret**) | unset (website tools off) | Fine-grained token: website repo only, Contents and Actions read/write, 90-day expiry |
| `SITE_GITHUB_REPO` | `Njdonatelli/donatelli-website` | |
| `SITE_GITHUB_BRANCH` | `main` | |
| `SITE_PREVIEW_BRANCH` | `admin-preview` | Must differ from `SITE_GITHUB_BRANCH` |
| `SITE_WORKFLOW`, `SITE_ROLLBACK_WORKFLOW` | `site.yml`, `rollback.yml` | |
| `SITE_CONFIG_PATH`, `SITE_SCHEMA_PATH`, `SITE_CREDENTIALS_PATH` | `data/site.json`, `data/site.schema.json`, `outputs/data/credentials.json` | |
| `SITE_LIVE_URL` | `https://donatelli.tech` | `build.json`, the card QR, the preview portrait |
| `SITE_PREVIEW_URL` | `https://admin-preview.donatelli-services.pages.dev` | [VERIFY] the Pages alias |
| `SITE_GITHUB_API_URL` | `https://api.github.com` | Must be https in production |
| `CONNECT_INGEST_SECRET` (**secret**) | unset (ingest answers 503) | At least 32 characters; the same value goes on Cloudflare Pages (Production only) |
| `CONNECT_INGEST_SECRET_PREVIOUS` (**secret**) | unset | Only while rotating the ingest secret |
| `CONNECT_ORG_SLUG` | `donatelli-tech` | |
| `CONNECT_DAILY_CAP` | `200` | Connections accepted per UTC day |
| `CONNECT_NOTIFY_EMAIL` | unset | Optional recipient of the new-connection email, which carries no visitor details |
| `BACKUP_INTERVAL_HOURS` | `0` (off) | Hours between in-process backups, up to 576 |
| `BACKUP_KEEP` | `14` | Backup files kept |

In production the server refuses to start, and lists every problem at once, when `JWT_SECRET`
is shorter than 32 characters or is the placeholder, `DEMO_MODE` is `true`, `APP_URL` is
missing or not https, `SITE_GITHUB_API_URL` is not https, `SITE_PREVIEW_BRANCH` equals
`SITE_GITHUB_BRANCH`, `CONNECT_INGEST_SECRET` is set but shorter than 32 characters, or
`ALLOWED_ORIGINS` leaves out the `APP_URL` origin.

## Updating

Bash on the host, in the repository directory:

```bash
git pull && docker compose up -d --build
```

Success: the last line reads `Container swiish Started`. Database migrations run at every
start, before the server accepts requests.

## Backups

With `BACKUP_INTERVAL_HOURS=24` the server writes a consistent snapshot (`VACUUM INTO`) to
`./data/backups/cards-<UTC time>.db` once a day and keeps the newest `BACKUP_KEEP` files. The
first backup runs one interval after the start, not at boot, so a restart loop cannot push the
good backups out.

Take a backup now (Bash on the host):

```bash
docker compose exec swiish node scripts/backup-db.js
```

Expected output: `Backup written: data/backups/cards-<UTC time>.db (keeping 14, removed 0 older).`

What the owner must know:

- **Deleted connections live on in backups** until those files rotate out: up to
  `BACKUP_KEEP` × `BACKUP_INTERVAL_HOURS` (14 days with the values above). An erase request is
  complete on the live database at once and in the backups after that period.
- **Backups stay on this host.** Copying them off the host, encrypted and on a schedule you
  control, is your choice and is not set up here.

### Restore the newest backup

Bash on the host, in the repository directory. The copy runs in a one-off container because
the files in `./data` belong to the container's root user. The current database is kept as
`data/cards.db.before-restore`.

```bash
docker compose stop swiish && docker compose run --rm --no-deps swiish sh -c 'cp data/cards.db data/cards.db.before-restore && cp "data/backups/$(ls -1 data/backups | tail -n 1)" data/cards.db' && docker compose start swiish
```

Success: the output ends with `Container swiish Started`. Anything recorded after that backup
is gone from the live database; if the admin shows the login page, log in again.

## Recovery

Every command in this section runs in Bash on the host, in the repository directory.

### Password reset without email

Without SMTP, reset the owner password from the host shell:

```bash
read -r -p 'Admin email: ' ADMIN_EMAIL && docker compose exec swiish node scripts/set-password.js "$ADMIN_EMAIL"
```

The script asks for the new password twice without showing it. Success:
`Password changed for <email>. Every existing session is signed out; log in with the new password.`
An unknown address prints `No user with that email.`; a password under 12 characters or a
mismatch changes nothing and says why. Each reset is recorded in the audit log as
`password_reset_cli`.

### Sign out every session

In the admin, open Account → Sessions → `Sign out everywhere`. It ends every session,
including the current one. Changing or resetting the password does the same for all other
sessions. Rotating `JWT_SECRET` also signs everyone out, but is only needed if the secret leaked.

### Rotate the ingest secret

1. Generate a new value:

   ```bash
   openssl rand -base64 48
   ```

   Expected output: one 64-character line.
2. In `.env`, move the current `CONNECT_INGEST_SECRET` value to
   `CONNECT_INGEST_SECRET_PREVIOUS` and set the new value as `CONNECT_INGEST_SECRET`. Then
   restart:

   ```bash
   docker compose up -d
   ```

   Success: `Container swiish Started`. Both values are accepted now.
3. Set the new value on Cloudflare Pages (Production) as `CONNECT_INGEST_SECRET` and redeploy
   the site.
4. Clear `CONNECT_INGEST_SECRET_PREVIOUS` in `.env` and restart the same way
   (`docker compose up -d`, success: `Container swiish Started`).

### The server will not start

```bash
docker compose logs --tail 50 swiish
```

- `Server not started: N configuration problems.` lists each variable to fix in `.env`.
- `Migration failed:` means the database could not be migrated; the lines above it name the
  migration and the SQLite error. If the database file itself is damaged, restore the newest
  backup (above) and start again.

## Logs

- Docker keeps the container output in rotated JSON files (3 files of 10 MB each).
- The admin's own log (`server.log`, readable by the owner under `/api/admin/logs`) never
  receives visitor details, tokens or secrets. It lives inside the container and is lost when
  the container is recreated; the database and backups are on the volume.

## Local development

For working on the code, not for hosting. Bash/Zsh on macOS or Linux with Node 22, in the
repository directory:

```bash
npm ci
```

Success: `added … packages` with no `npm error` lines.

```bash
cp .env.example .env && sed -i.bak "s|^JWT_SECRET=\$|JWT_SECRET=$(openssl rand -base64 48)|" .env && rm .env.bak
```

Success: no output. With `NODE_ENV` empty the server runs in development mode: no setup token,
cookies over plain http, `http://localhost:3000` as the origin.

```bash
npm run dev
```

Success, after the first build (about a minute): `[SERVER] Server running on port 3000`. Open
`http://localhost:3000/setup`. Stop with Ctrl+C.

```bash
npm test
```

Success: the summary ends with `# fail 0`.
