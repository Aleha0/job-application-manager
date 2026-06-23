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
// Liste des plateformes de candidature (modifiable dans les Paramètres).
seedSetting.run('plateformes', JSON.stringify([
  'HelloWork', 'LinkedIn', 'Indeed', 'Welcome to the Jungle', 'APEC',
  'France Travail', "Site de l'entreprise", 'Cooptation',
  'En physique', 'Par e-mail',
]));
// Liste des domaines métier (modifiable dans les Paramètres).
seedSetting.run('domaines', JSON.stringify([
  "Développement d'applications", 'Vente / Commerce', 'Marketing', 'Communication',
  'Administratif', 'Comptabilité / Finance', 'Ressources humaines',
  'Logistique', 'Restauration / Hôtellerie', 'Santé', 'Enseignement', 'Autre',
]));
// Liste d'étiquettes prédéfinies (modifiable dans les Paramètres).
// Format : [{ name, hue }]. Les anciens formats (tableau de chaînes) restent
// pris en charge côté frontend.
seedSetting.run('tags', JSON.stringify([
  { name: 'Télétravail', hue: 199 },
  { name: 'Priorité haute', hue: 18 },
  { name: 'Spontanée', hue: 270 },
  { name: 'Réseau', hue: 160 },
  { name: 'Alternance', hue: 35 },
]));

// --- Migrations légères ---------------------------------------------------

// Ajoute la colonne `tags` aux candidatures si elle n'existe pas encore.
const candCols = db.prepare('PRAGMA table_info(candidatures)').all();
if (!candCols.some((c) => c.name === 'tags')) {
  db.exec("ALTER TABLE candidatures ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
}

// Ajoute la colonne `plateforme` (canal de candidature) aux candidatures.
if (!candCols.some((c) => c.name === 'plateforme')) {
  db.exec('ALTER TABLE candidatures ADD COLUMN plateforme TEXT');
}

// Ajoute la colonne `date_reponse` (date de réponse de l'employeur).
if (!candCols.some((c) => c.name === 'date_reponse')) {
  db.exec('ALTER TABLE candidatures ADD COLUMN date_reponse TEXT');
}

// Ajoute la colonne `cv_document_id` (CV envoyé) aux candidatures.
if (!candCols.some((c) => c.name === 'cv_document_id')) {
  db.exec('ALTER TABLE candidatures ADD COLUMN cv_document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL');
}

// Ajoute la colonne `domaine` (domaine métier) aux candidatures.
if (!candCols.some((c) => c.name === 'domaine')) {
  db.exec('ALTER TABLE candidatures ADD COLUMN domaine TEXT');
}

// Conservation RGPD des données par l'employeur (alimentée par l'import,
// exploitée par la page « Mes données personnelles »).
//  - cv_conserve      : 1 si l'employeur conserve le dossier, 0 sinon
//  - cv_conserve_mois : durée de conservation en mois (NULL si inconnue)
if (!candCols.some((c) => c.name === 'cv_conserve')) {
  db.exec('ALTER TABLE candidatures ADD COLUMN cv_conserve INTEGER NOT NULL DEFAULT 0');
}
if (!candCols.some((c) => c.name === 'cv_conserve_mois')) {
  db.exec('ALTER TABLE candidatures ADD COLUMN cv_conserve_mois INTEGER');
}

// Migration unique : ajoute « En physique » et « Par e-mail » aux plateformes
// existantes (remplace l'ancien « En personne »). Ne s'exécute qu'une fois.
const migPlatDone = db.prepare("SELECT value FROM settings WHERE key = 'migr_plat_spontane'").get();
if (!migPlatDone) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'plateformes'").get();
  let arr = [];
  try { arr = JSON.parse(row ? row.value : '[]'); } catch { arr = []; }
  if (Array.isArray(arr)) {
    arr = arr.filter((p) => p !== 'En personne');
    for (const p of ['En physique', 'Par e-mail']) {
      if (!arr.includes(p)) arr.push(p);
    }
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('plateformes', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(JSON.stringify(arr));
  }
  seedSetting.run('migr_plat_spontane', '1');
}

// Ajoute la colonne `file_date` (date de mise à jour du fichier) aux documents.
const docCols = db.prepare('PRAGMA table_info(documents)').all();
if (!docCols.some((c) => c.name === 'file_date')) {
  db.exec('ALTER TABLE documents ADD COLUMN file_date TEXT');
}

// Table des CVthèques (sites où le CV est déposé). Pré-remplie à la 1re création.
const cvthequesExisted = db
  .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cvtheques'")
  .get();
db.exec(`
  CREATE TABLE IF NOT EXISTS cvtheques (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    nom            TEXT NOT NULL,
    url            TEXT,
    derniere_maj   TEXT,
    cv_document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
    notes          TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
if (!cvthequesExisted) {
  const ins = db.prepare('INSERT INTO cvtheques (nom, url) VALUES (?, ?)');
  const seed = [
    ['Indeed', 'https://www.indeed.fr'],
    ['LinkedIn', 'https://www.linkedin.com'],
    ['HelloWork', 'https://www.hellowork.com'],
    ['APEC', 'https://www.apec.fr'],
    ['France Travail', 'https://www.francetravail.fr'],
    ['Monster', 'https://www.monster.fr'],
  ];
  db.transaction(() => { for (const [n, u] of seed) ins.run(n, u); })();
}
// Délai (mois) avant de signaler une CVthèque « à mettre à jour ».
seedSetting.run('cvtheque_maj_delai_mois', '3');
// Objectif de candidatures par semaine (suivi du rythme).
seedSetting.run('objectif_hebdo', '5');

// Liaison plusieurs-à-plusieurs entre CVthèques et documents (CV).
db.exec(`
  CREATE TABLE IF NOT EXISTS cvtheque_cvs (
    cvtheque_id INTEGER NOT NULL REFERENCES cvtheques(id) ON DELETE CASCADE,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    PRIMARY KEY (cvtheque_id, document_id)
  );
`);
// Historique des relances liées à une candidature (une candidature -> N relances).
db.exec(`
  CREATE TABLE IF NOT EXISTS relances (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    candidature_id INTEGER NOT NULL REFERENCES candidatures(id) ON DELETE CASCADE,
    date           TEXT NOT NULL,                  -- date de la relance (YYYY-MM-DD)
    canal          TEXT,                           -- mail | telephone | linkedin | autre
    note           TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_relances_candidature ON relances(candidature_id);
`);

// Migration : déplace l'ancien lien unique cv_document_id vers la table de liaison.
const cvthLegacy = db
  .prepare('SELECT id, cv_document_id FROM cvtheques WHERE cv_document_id IS NOT NULL')
  .all();
if (cvthLegacy.length) {
  const ins = db.prepare('INSERT OR IGNORE INTO cvtheque_cvs (cvtheque_id, document_id) VALUES (?, ?)');
  const clr = db.prepare('UPDATE cvtheques SET cv_document_id = NULL WHERE id = ?');
  db.transaction(() => {
    for (const r of cvthLegacy) { ins.run(r.id, r.cv_document_id); clr.run(r.id); }
  })();
}

module.exports = db;
