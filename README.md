# 🏭 Production Planner for StarRupture

[Deutsch](#deutsch) | [English](#english)

---

## Deutsch

**Production Planner** ist ein lokales Web-Tool zur Planung von Produktionsketten im Spiel **StarRupture**. Man hinterlegt Items, Gebäude und Blueprints (Rezepte); der Planer berechnet daraus den kompletten Produktionsbaum für ein Zielitem mit gewünschter Rate.

### Funktionen

- **Planer**: Zielitem und Rate wählen, Produktionsbaum als Graph oder als Zusammenfassung anzeigen. Pro Node kann ein alternativer Blueprint gewählt werden.
- **Pläne speichern**: Pläne benennen, speichern, laden und löschen.
- **Blueprints, Gebäude, Items**: Verwaltung (anlegen, bearbeiten, löschen) inklusive Icons, Tier, Stromverbrauch, Temperatur, Baufläche, Kategorie und Freischalt-Status.
- **Mehrsprachig**: Oberfläche auf Deutsch, Englisch, Spanisch und Französisch (i18next); die Sprache wird in der Datenbank gespeichert.
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

### Projektstruktur

```text
src/main.rs         Backend (REST-API unter /api, Schema, Migrationen)
static/             Frontend (index.html, app.js, locales.js, style.css)
images/             Item- und Gebäude-Icons
seed.sql            Basisdaten (Items, Gebäude, Blueprints) für neue Datenbanken
productionplanner.db  SQLite-Datenbank
```

---

## English

**Production Planner** is a local web tool for planning production chains in the game **StarRupture**. You maintain items, buildings and blueprints (recipes); the planner then calculates the complete production tree for a target item at a desired rate.

### Features

- **Planner**: choose a target item and rate, and view the production tree as a graph or a summary. An alternative blueprint can be selected per node.
- **Saved plans**: name, save, load and delete plans.
- **Blueprints, buildings, items**: manage (create, edit, delete) including icons, tier, power consumption, temperature, build area, category and unlock status.
- **Multilingual**: UI in German, English, Spanish and French (i18next); the language is stored in the database.
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

### Project structure

```text
src/main.rs         Backend (REST API under /api, schema, migrations)
static/             Frontend (index.html, app.js, locales.js, style.css)
images/             Item and building icons
seed.sql            Base data (items, buildings, blueprints) for new databases
productionplanner.db  SQLite database
```
