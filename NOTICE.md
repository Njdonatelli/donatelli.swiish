# Notice

This repository, `Njdonatelli/donatelli.swiish`, is a modified version of
[Swiish](https://github.com/MrCrin/swiish) 0.7.0, Copyright (C) 2024 Michael Crinnion.

Swiish and this modified version are licensed under the GNU Affero General Public License,
version 3 (AGPL-3.0). The full license text is in [COPYING](COPYING). The upstream license
header and trademark notice in [LICENSE](LICENSE) and the policy in
[TRADEMARKS.md](TRADEMARKS.md) are unchanged and still apply.

"Swiish" and the Swiish logo are trademarks of Michael Crinnion. This fork is not the official
Swiish and is not endorsed by its author. It uses the name only to describe where the software
came from ("Built on Swiish"), and its interface does not use the Swiish logo. The logo files
under `public/graphics/` are kept, unreferenced, with their notices intact.

## Modification notice (AGPL-3.0 section 5)

Modified by Nick Donatelli, 2026-09-30.

The modified version is the "donatelli edition": the admin back office for donatelli.tech.
Summary of the changes:

- **Server hardening** (`server.js`, `lib/config.js`, `lib/edition.js`): configuration that
  refuses to boot in production on unsafe values; an edition guard that turns off the Swiish
  public card surfaces (cards, QR, manifests, icons, uploads, invitations, public settings)
  and marks every response `noindex`; revocable sessions (`session_version`); a one-time
  setup token; 12-character passwords; a stricter Content Security Policy; correct 403, 400
  and 413 responses; an owner-only log view; a health endpoint; an audit feed.
- **Connections** (`lib/connections.js` and related modules): stores the details that
  visitors send from the static card on donatelli.tech through a signed server-to-server
  ingest, with retention, erase-by-email, CSV and vCard export, all audited.
- **Website tools** (`lib/github.js`, `lib/site-admin.js` and related modules): edits the
  website's `data/site.json` through the GitHub API, builds previews on a separate branch,
  and publishes a green preview by fast-forwarding `main`.
- **Admin interface** (`src/admin/`, `src/index.js`, `public/`): a new admin app in the
  donatelli.tech design system replaces the Swiish interface as the entry point. The upstream
  `src/App.js`, `src/index.css` and `src/theme/` stay in the tree, unedited and not imported.
- **Operations**: the fork builds its own Docker image (GitHub Container Registry only),
  commits `package-lock.json`, adds a CI workflow and tests, and ships
  `scripts/set-password.js` and `scripts/backup-db.js`.
- **Branding**: product name, emails, manifest and icons are donatelli.tech. Swiish is named
  only in attribution text.

## Source

The Corresponding Source of the version running at the donatelli.tech admin is this
repository: <https://github.com/Njdonatelli/donatelli.swiish>. The admin's login page and
Account view link to it.
