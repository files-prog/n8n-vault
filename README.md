# n8n-vault · despliegue en Entirety

**https://vault.entirety.biz** (DigitalOcean, `/root/n8n-vault`, contenedor en 127.0.0.1:3444).

- **Seguridad**: la app ya trae sesión aleatoria con caducidad (8 h), cookie `HttpOnly`/`Secure`/`SameSite`, CSRF, límite de intentos de login, bcrypt y CSP. Este repo añade el sitio nginx con 10 intentos/min en `/auth/login`, límites por IP, timeouts y HSTS.
- **Desplegar**: `bash deploy/remoto.sh` desde tu portátil instala el sitio nginx; con `--build` además reconstruye el contenedor si cambiaste código. Copia en `/root/backups/n8n-vault/<fecha>/`; deshacer: `sudo bash /tmp/n8n-vault/deploy/rollback.sh`.

---

# n8n Vault

Secure version history for self-hosted n8n. Automatic change detection, meaningful diffs,
one-click rollback — behind real authentication.

- **Only changes are stored.** Every 60 seconds Vault fingerprints each workflow; a new
  version is created only when content actually changed. Unchanged workflows are skipped
  entirely.
- **Push your changes from the editor.** Every workflow in n8n gets a **Save version**
  button: finish editing, click it, describe what you did, done. The version carries your
  name and your note. (Auto-sync still runs in the background as a safety net, so nothing
  is ever lost even if someone forgets to save.)
- **Diffs that speak n8n.** Each version shows which nodes were added, removed or modified —
  down to the exact parameter — plus a raw JSON diff one click deeper.
- **Rollback, safely.** Restore any version to n8n. The restore itself becomes a new
  version, so history is never rewritten and a rollback can be rolled back.
- **Locked down.** Sign-in required everywhere, roles (viewer / editor / admin), optional
  Google Workspace SSO, CSRF protection, login rate limiting, full audit trail.
- **Upgrade-proof.** Talks only to n8n's stable public API. Upgrading n8n never requires
  changes here.

See `ARCHITECTURE.md` for the full design document.

---

## Quick start

### 1. Create an n8n API key

In n8n: **Settings → n8n API → Create an API key**. Copy it.

### 2. Configure

Create a `.env` file next to `docker-compose.yml`:

```env
N8N_API_KEY=your-n8n-api-key
VAULT_APP_URL=https://vault.your-company.com   # or http://localhost:3444 to try it out
VAULT_ADMIN_EMAIL=you@your-company.com
VAULT_ADMIN_PASSWORD=choose-a-strong-password
```

The admin account is created on first start only; remove the password from `.env` afterwards.

### 3. Run

```bash
docker compose up -d --build
```

Open the Vault URL, sign in, and you'll see your workflows appear after the first sync
(within a minute). That's it — versioning is now automatic.

### 4. (Recommended) The buttons inside n8n

Add the `sub_filter` snippet from `nginx/n8n-proxy.conf` to your reverse proxy. Every
workflow in the n8n editor then shows two buttons in the bottom-right corner:

- **Save version** — push the changes you just made: a dialog asks what you did, and the
  version is saved with your note and your name (only if something actually changed).
- **History** — jump straight to that workflow's timeline in Vault.

No n8n fork, no plugin — upgrading n8n never breaks it.

### 5. (Optional) Google Workspace sign-in

Create an OAuth client in Google Cloud Console (type *Web application*, redirect URI
`https://vault.your-company.com/auth/google/callback`), then add:

```env
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_ALLOWED_DOMAIN=your-company.com   # members auto-join as viewers
```

---

## Roles

| | viewer | editor | admin |
|---|---|---|---|
| Browse history & diffs, download versions | ✔ | ✔ | ✔ |
| Sync now, add notes, **restore versions** | | ✔ | ✔ |
| Manage users, audit log | | | ✔ |

## Configuration reference

| Variable | Default | Description |
|---|---|---|
| `N8N_URL` | `http://n8n:5678` | n8n base URL (inside the Docker network). |
| `N8N_API_KEY` | — | Required. From n8n Settings → n8n API. |
| `APP_URL` | `http://localhost:3444` | Public URL of Vault (used for cookies & OAuth). |
| `SYNC_INTERVAL_SECONDS` | `60` | How often to check for changes (min 15). |
| `SESSION_TTL_HOURS` | `8` | Idle session lifetime (sliding). |
| `SESSION_ABSOLUTE_HOURS` | `168` | Hard session cap. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | — | Bootstrap admin (first start only). |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | Enable Google sign-in. |
| `GOOGLE_ALLOWED_DOMAIN` | — | Auto-provision this domain's users as viewers. |
| `DATA_DIR` | `/app/data` | Where the SQLite database lives. |

## Backups

Everything lives in one SQLite file inside the `vault_data` volume. A nightly copy of that
volume is a complete backup.

## Development & tests

```bash
npm install
npm test          # 25-check end-to-end suite against a mock n8n API
```

## A note on versioning the n8n instance itself

Vault versions your **workflows**. The n8n **instance version** is versioned where it
belongs: the pinned image tag in `docker-compose.yml` (`n8nio/n8n:1.122.5`). Keep that file
in a small git repo and every upgrade is an auditable commit.

## Cambiar algo
Edita en tu portátil, `git commit` y `bash deploy/remoto.sh`: hace `git push` y el servidor hace `git pull` en su carpeta, que aplica los cambios solo (`deploy/aplicar.sh`) y vuelve al commit anterior si algo falla.
