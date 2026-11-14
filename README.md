# 🏭 Production Planner for StarRupture

[Deutsch](#deutsch) | [English](#english)

---

## Deutsch

**Production Planner** ist ein lokales Web-Tool zur Planung von Produktionsketten im Spiel **StarRupture**. Man hinterlegt Items, Gebäude und Blueprints (Rezepte); der Planer berechnet daraus den kompletten Produktionsbaum für ein Zielitem mit gewünschter Rate.

> 🤖 Dieses Tool wurde mithilfe von KI (GitHub Copilot) erstellt.

### Funktionen

- **Planer**: Zielitem und Rate wählen, Produktionsbaum als Graph oder als Zusammenfassung anzeigen. Pro Node kann ein alternativer Blueprint gewählt werden.
- **Materialfluss**: Matrix aller Blueprints (Zeilen = produziertes Item, Spalten = benötigte Inputs, nach Produktionsstufe sortiert). Zeigt, von welcher bis zu welcher Stufe ein Input-Item benötigt wird, um Überlastungen des Transportnetzwerks zu erkennen.
- **Pläne speichern**: Pläne benennen, speichern, laden und löschen.
- **Blueprints, Gebäude, Items**: Verwaltung (anlegen, bearbeiten, löschen) inklusive Icons, Tier, Energie (negativ = Verbrauch, positiv = Erzeugung), Temperatur, Baufläche, Kategorie und Freischalt-Status. Beim Entsperren eines Gebäudes wird nachgefragt, ob auch dessen Blueprints entsperrt werden sollen; Blueprints lassen sich zusätzlich per Tier bzw. Tier-Bereich gesammelt sperren/entsperren.
- **Mehrsprachig**: Oberfläche auf Deutsch, Englisch, Spanisch und Französisch (i18next); die Sprache wird im Browser gespeichert.
- **Lokale Datenhaltung**: SQLite-Datenbank, die beim ersten Start automatisch angelegt, mit den Basisdaten aus `seed.sql` gefüllt und bei Bedarf migriert wird.

### Technik

- Backend: Rust (Edition 2024), [axum](https://github.com/tokio-rs/axum), [sqlx](https://github.com/launchbadge/sqlx) (SQLite), tokio
- Frontend: statisches HTML/CSS/JavaScript ohne Build-Schritt (`static/`)
- Icons: `images/`

### Voraussetzungen

- [Rust](https://www.rust-lang.org/tools/install) (aktuelle stabile Version mit Edition 2024)

### Starten

```bash
cargo run --release
```

Anschließend im Browser <http://127.0.0.1:3000> öffnen. Beenden mit `Strg+C`.

### Konfiguration (Umgebungsvariablen)

| Variable        | Standard                         | Beschreibung                   |
|-----------------|----------------------------------|--------------------------------|
| `BIND`          | `127.0.0.1:3000`                 | Adresse und Port des Servers   |
| `DATABASE_PATH` | `<Projektordner>/productionplanner.db` | Pfad zur SQLite-Datenbank |
| `GITHUB_CLIENT_ID` | – | Client-ID der GitHub-OAuth-App (aktiviert den Mehrbenutzerbetrieb) |
| `GITHUB_CLIENT_SECRET` | – | Client-Secret der GitHub-OAuth-App |
| `PUBLIC_URL`    | –                                | Öffentliche Basis-URL, z. B. `https://planner.example.com` (für den OAuth-Callback) |
| `ADMIN_GITHUB_LOGINS` | –                          | Kommagetrennte GitHub-Logins mit Adminrechten |

### Mehrbenutzerbetrieb (öffentliches Hosting)

Ohne `GITHUB_CLIENT_ID` läuft die App im lokalen Einzelnutzer-Modus: kein Login, jeder Zugreifer ist Admin. Deshalb startet der Server in diesem Modus nur, wenn `BIND` eine lokale Adresse ist.

Für den öffentlichen Betrieb eine [GitHub-OAuth-App](https://github.com/settings/developers) anlegen (Callback-URL: `<PUBLIC_URL>/auth/callback`) und die Variablen `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `PUBLIC_URL` und `ADMIN_GITHUB_LOGINS` setzen. Der Server sollte hinter HTTPS laufen (z. B. Reverse Proxy); bei einer `https://`-`PUBLIC_URL` erhält das Session-Cookie das `Secure`-Flag. GitHub Pages reicht nicht aus, da der Rust-Server laufen muss.

- **Pro Benutzer getrennt:** Pläne, manuelle Pläne und der Freischalt-Status von Gebäuden und Blueprints. Fremde Daten sind weder les- noch änderbar (Zugriffe darauf liefern 404).
- **Gemeinsame Stammdaten:** Items, Gebäude und Blueprints sind für alle lesbar, aber nur für Admins änderbar. Der Status im Bearbeiten-Dialog ist der Standardwert für alle; jeder angemeldete Benutzer kann ihn für sich mit „Sperren/Freischalten“ überschreiben.
- **Ohne Anmeldung:** Planer und manueller Planer lassen sich nutzen, Speichern ist deaktiviert.
- **Sessions:** zufälliges Token im `HttpOnly`/`SameSite=Lax`-Cookie, in der Datenbank nur als SHA-256-Hash, 30 Tage gültig. Schreibende Anfragen mit fremdem `Origin` werden abgelehnt.
- **Bestandsdaten:** Pläne aus der Einzelnutzer-Zeit gehören im lokalen Modus dem Benutzer `local`, im Mehrbenutzerbetrieb dem ersten Admin, der sich anmeldet.
- Die Sprache wird pro Browser gespeichert, nicht mehr in der Datenbank.

### Projektstruktur

```text
src/main.rs         Backend (REST-API unter /api, Schema, Migrationen)
src/auth.rs         GitHub-Login, Sessions, Zugriffsrechte
static/             Frontend (index.html, app.js, offline-api.js, locales.js, style.css)
images/             Item- und Gebäude-Icons
seed.sql            Basisdaten (Items, Gebäude, Blueprints) für neue Datenbanken
productionplanner.db  SQLite-Datenbank
scripts/build-pages.mjs  Baut die statische Variante für GitHub Pages (dist/)
```

### GitHub Pages (ohne Backend)

Die App läuft zusätzlich als rein statische Seite: Beim Start lädt der Browser `seed.sql` in eine SQLite-Datenbank im Arbeitsspeicher ([sql.js](https://github.com/sql-js/sql.js), `static/offline-api.js` ersetzt die REST-API). Pläne, manuelle Pläne und Freischaltungen werden lokal im Browser (`localStorage`) gespeichert – Cookies wären mit ca. 4 KB zu klein. Die Daten gelten pro Browser und gehen beim Löschen der Websitedaten verloren. Stammdaten (Items, Gebäude, Blueprints) sind dort schreibgeschützt; Login und Adminfunktionen entfallen.

Einrichtung: In den Repository-Einstellungen unter *Pages* als Quelle „GitHub Actions“ wählen. Der Workflow `.github/workflows/pages.yml` veröffentlicht bei jedem Push auf `master`/`main`. Lokal testen: `node scripts/build-pages.mjs` und `dist/` mit einem beliebigen statischen Webserver ausliefern.

---

## English

**Production Planner** is a local web tool for planning production chains in the game **StarRupture**. You maintain items, buildings and blueprints (recipes); the planner then calculates the complete production tree for a target item at a desired rate.

> 🤖 This tool was created with the help of AI (GitHub Copilot).

### Features

- **Planner**: choose a target item and rate, and view the production tree as a graph or a summary. An alternative blueprint can be selected per node.
- **Material flow**: matrix of all blueprints (rows = produced item, columns = required inputs, sorted by production stage) showing from which stage to which stage an input item is needed, to spot transport network overload.
- **Saved plans**: name, save, load and delete plans.
- **Blueprints, buildings, items**: manage (create, edit, delete) including icons, tier, power (negative = consumption, positive = generation), temperature, build area, category and unlock status. Unlocking a building asks whether its blueprints should be unlocked as well; blueprints can also be locked/unlocked in bulk by tier or tier range.
- **Multilingual**: UI in German, English, Spanish and French (i18next); the language is stored in the browser.
- **Local data storage**: SQLite database, created automatically on first start, filled with the base data from `seed.sql` and migrated when necessary.

### Tech stack

- Backend: Rust (edition 2024), [axum](https://github.com/tokio-rs/axum), [sqlx](https://github.com/launchbadge/sqlx) (SQLite), tokio
- Frontend: static HTML/CSS/JavaScript, no build step (`static/`)
- Icons: `images/`

### Requirements

- [Rust](https://www.rust-lang.org/tools/install) (a recent stable version supporting edition 2024)

### Run

```bash
cargo run --release
```

Then open <http://127.0.0.1:3000> in your browser. Stop with `Ctrl+C`.

### Configuration (environment variables)

| Variable        | Default                          | Description                    |
|-----------------|----------------------------------|--------------------------------|
| `BIND`          | `127.0.0.1:3000`                 | Server address and port        |
| `DATABASE_PATH` | `<project folder>/productionplanner.db` | Path to the SQLite database |
| `GITHUB_CLIENT_ID` | – | Client ID of the GitHub OAuth app (enables multi-user mode) |
| `GITHUB_CLIENT_SECRET` | – | Client secret of the GitHub OAuth app |
| `PUBLIC_URL`    | –                                | Public base URL, e.g. `https://planner.example.com` (for the OAuth callback) |
| `ADMIN_GITHUB_LOGINS` | –                          | Comma-separated GitHub logins with admin rights |

### Multi-user mode (public hosting)

Without `GITHUB_CLIENT_ID` the app runs in local single-user mode: no login, every visitor is an admin. Therefore the server only starts in this mode if `BIND` is a local address.

For public hosting, create a [GitHub OAuth app](https://github.com/settings/developers) (callback URL: `<PUBLIC_URL>/auth/callback`) and set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `PUBLIC_URL` and `ADMIN_GITHUB_LOGINS`. Run the server behind HTTPS (e.g. a reverse proxy); with an `https://` `PUBLIC_URL` the session cookie gets the `Secure` flag. GitHub Pages is not sufficient because the Rust server has to run.

- **Separated per user:** plans, manual plans and the unlock state of buildings and blueprints. Other users' data can neither be read nor changed (such requests return 404).
- **Shared master data:** items, buildings and blueprints are readable by everyone but only editable by admins. The status in the edit dialog is the default for everyone; every signed-in user can override it for themselves with "Lock/Unlock".
- **Signed out:** the planner and manual planner can be used, saving is disabled.
- **Sessions:** random token in an `HttpOnly`/`SameSite=Lax` cookie, stored in the database only as a SHA-256 hash, valid for 30 days. Write requests with a foreign `Origin` are rejected.
- **Existing data:** plans from the single-user era belong to the user `local` in local mode, or to the first admin who signs in in multi-user mode.
- The language is stored per browser, no longer in the database.

### Project structure

```text
src/main.rs         Backend (REST API under /api, schema, migrations)
src/auth.rs         GitHub login, sessions, access rights
static/             Frontend (index.html, app.js, offline-api.js, locales.js, style.css)
images/             Item and building icons
seed.sql            Base data (items, buildings, blueprints) for new databases
productionplanner.db  SQLite database
scripts/build-pages.mjs  Builds the static GitHub Pages version (dist/)
```

### GitHub Pages (no backend)

The app also runs as a purely static site: on startup the browser loads `seed.sql` into an in-memory SQLite database ([sql.js](https://github.com/sql-js/sql.js); `static/offline-api.js` replaces the REST API). Plans, manual plans and unlock states are stored locally in the browser (`localStorage`) – cookies are limited to about 4 KB, which is too small. Data is per browser and is lost when site data is cleared. Master data (items, buildings, blueprints) is read-only there; login and admin features are not available.

Setup: in the repository settings under *Pages*, select "GitHub Actions" as the source. The workflow `.github/workflows/pages.yml` publishes on every push to `master`/`main`. To test locally, run `node scripts/build-pages.mjs` and serve `dist/` with any static web server.