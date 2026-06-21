'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// Dossier de données. Surchargeable via GC_DATA_DIR pour isoler les tests
// de la base de production (ne JAMAIS faire pointer les tests sur 'data/').
const DATA_DIR = process.env.GC_DATA_DIR
  ? path.resolve(process.env.GC_DATA_DIR)
  : path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(path.join(DATA_DIR, 'gestion.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// --- Schéma ---------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS candidatures (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    entreprise      TEXT NOT NULL,
    poste           TEXT NOT NULL,
    lieu            TEXT,
    statut          TEXT NOT NULL DEFAULT 'À postuler',
    date_candidature TEXT,            -- ISO date (YYYY-MM-DD)
    date_relance    TEXT,             -- date de relance manuelle (optionnelle)
    recruteur_nom   TEXT,
    recruteur_email TEXT,
    lien_offre      TEXT,
    salaire         TEXT,
    type_contrat    TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS folders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    nom         TEXT NOT NULL,
    type        TEXT NOT NULL DEFAULT 'autre',  -- cv | lettre | autre
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS documents (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id      INTEGER REFERENCES folders(id) ON DELETE SET NULL,
    candidature_id INTEGER REFERENCES candidatures(id) ON DELETE SET NULL,
    type           TEXT NOT NULL DEFAULT 'autre',  -- cv | lettre | autre
    original_name  TEXT NOT NULL,
    stored_name    TEXT NOT NULL,
    mime           TEXT,
    size           INTEGER,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS notes (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id      INTEGER REFERENCES folders(id) ON DELETE SET NULL,
    candidature_id INTEGER REFERENCES candidatures(id) ON DELETE SET NULL,
    titre          TEXT NOT NULL DEFAULT 'Sans titre',
    contenu        TEXT NOT NULL DEFAULT '',
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

// --- Valeurs par défaut ---------------------------------------------------

const seedSetting = db.prepare(
  'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
);
// Délai (en jours) avant qu'une candidature envoyée soit signalée à relancer.
seedSetting.run('relance_delai_jours', '7');
// Notifications ntfy (téléphone). Sujet vide = désactivé.
seedSetting.run('ntfy_topic', '');
seedSetting.run('ntfy_server', 'https://ntfy.sh');
// Liste d'étiquettes prédéfinies (modifiable dans les Paramètres).
seedSetting.run('tags', JSON.stringify(['Télétravail', 'Priorité haute', 'Spontanée', 'Réseau', 'Alternance']));

// --- Migrations légères ---------------------------------------------------

// Ajoute la colonne `tags` aux candidatures si elle n'existe pas encore.
const candCols = db.prepare('PRAGMA table_info(candidatures)').all();
if (!candCols.some((c) => c.name === 'tags')) {
  db.exec("ALTER TABLE candidatures ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
}

module.exports = db;
