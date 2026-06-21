'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Dossiers de stockage -------------------------------------------------

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// --- Constantes -----------------------------------------------------------

const STATUTS = [
  'À postuler',
  'Envoyée',
  'Relancée',
  'Entretien',
  'Acceptée',
  'Refusée',
  'Sans réponse',
];

// Statuts pour lesquels une relance a encore du sens.
const STATUTS_RELANCABLES = ['Envoyée', 'Relancée'];

// --- Middlewares ----------------------------------------------------------

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Upload (multer) ------------------------------------------------------

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const unique = crypto.randomBytes(8).toString('hex');
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${unique}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 Mo max
});

// Multer ne décode pas correctement l'UTF-8 des noms de fichiers : on corrige.
function fixOriginalName(name) {
  try {
    return Buffer.from(name, 'latin1').toString('utf8');
  } catch {
    return name;
  }
}

// --- Helpers --------------------------------------------------------------

function asyncRoute(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message || 'Erreur serveur' });
    }
  };
}

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(fromISO, toISO) {
  const a = new Date(fromISO + 'T00:00:00');
  const b = new Date(toISO + 'T00:00:00');
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

// Calcule, pour une candidature, si elle doit être relancée + la date prévue.
function computeRelance(c, delaiJours) {
  if (!STATUTS_RELANCABLES.includes(c.statut)) {
    return { dueDate: null, aRelancer: false, joursRetard: 0 };
  }
  let dueDate = null;
  if (c.date_relance) {
    dueDate = c.date_relance;
  } else {
    // Base : date de candidature (ou date de création si absente) + délai.
    const base = c.date_candidature || (c.created_at || '').slice(0, 10);
    if (base) {
      const d = new Date(base + 'T00:00:00');
      d.setDate(d.getDate() + delaiJours);
      dueDate = d.toISOString().slice(0, 10);
    }
  }
  if (!dueDate) return { dueDate: null, aRelancer: false, joursRetard: 0 };
  const retard = daysBetween(dueDate, todayISO());
  return { dueDate, aRelancer: retard >= 0, joursRetard: retard };
}

// =========================================================================
//  API : CANDIDATURES
// =========================================================================

app.get(
  '/api/candidatures',
  asyncRoute((req, res) => {
    const rows = db
      .prepare('SELECT * FROM candidatures ORDER BY date_candidature DESC, id DESC')
      .all();
    const delai = parseInt(getSetting('relance_delai_jours', '7'), 10);
    const enriched = rows.map((c) => ({ ...c, relance: computeRelance(c, delai) }));
    res.json(enriched);
  })
);

app.post(
  '/api/candidatures',
  asyncRoute((req, res) => {
    const b = req.body || {};
    if (!b.entreprise || !b.poste) {
      return res.status(400).json({ error: 'Entreprise et poste sont requis.' });
    }
    const statut = STATUTS.includes(b.statut) ? b.statut : 'À postuler';
    const stmt = db.prepare(`
      INSERT INTO candidatures
        (entreprise, poste, lieu, statut, date_candidature, date_relance,
         recruteur_nom, recruteur_email, lien_offre, salaire, type_contrat)
      VALUES
        (@entreprise, @poste, @lieu, @statut, @date_candidature, @date_relance,
         @recruteur_nom, @recruteur_email, @lien_offre, @salaire, @type_contrat)
    `);
    const info = stmt.run({
      entreprise: b.entreprise,
      poste: b.poste,
      lieu: b.lieu || null,
      statut,
      date_candidature: b.date_candidature || todayISO(),
      date_relance: b.date_relance || null,
      recruteur_nom: b.recruteur_nom || null,
      recruteur_email: b.recruteur_email || null,
      lien_offre: b.lien_offre || null,
      salaire: b.salaire || null,
      type_contrat: b.type_contrat || null,
    });
    const row = db
      .prepare('SELECT * FROM candidatures WHERE id = ?')
      .get(info.lastInsertRowid);
    res.status(201).json(row);
  })
);

app.put(
  '/api/candidatures/:id',
  asyncRoute((req, res) => {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM candidatures WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Candidature introuvable.' });
    const b = req.body || {};
    const statut = STATUTS.includes(b.statut) ? b.statut : existing.statut;
    db.prepare(`
      UPDATE candidatures SET
        entreprise = @entreprise,
        poste = @poste,
        lieu = @lieu,
        statut = @statut,
        date_candidature = @date_candidature,
        date_relance = @date_relance,
        recruteur_nom = @recruteur_nom,
        recruteur_email = @recruteur_email,
        lien_offre = @lien_offre,
        salaire = @salaire,
        type_contrat = @type_contrat,
        updated_at = datetime('now')
      WHERE id = @id
    `).run({
      id,
      entreprise: b.entreprise ?? existing.entreprise,
      poste: b.poste ?? existing.poste,
      lieu: b.lieu ?? existing.lieu,
      statut,
      date_candidature: b.date_candidature ?? existing.date_candidature,
      date_relance: b.date_relance !== undefined ? b.date_relance || null : existing.date_relance,
      recruteur_nom: b.recruteur_nom ?? existing.recruteur_nom,
      recruteur_email: b.recruteur_email ?? existing.recruteur_email,
      lien_offre: b.lien_offre ?? existing.lien_offre,
      salaire: b.salaire ?? existing.salaire,
      type_contrat: b.type_contrat ?? existing.type_contrat,
    });
    const row = db.prepare('SELECT * FROM candidatures WHERE id = ?').get(id);
    res.json(row);
  })
);

app.delete(
  '/api/candidatures/:id',
  asyncRoute((req, res) => {
    const id = Number(req.params.id);
    // Supprimer aussi les fichiers physiques liés.
    const docs = db
      .prepare('SELECT stored_name FROM documents WHERE candidature_id = ?')
      .all(id);
    db.prepare('DELETE FROM candidatures WHERE id = ?').run(id);
    for (const d of docs) {
      const p = path.join(UPLOAD_DIR, d.stored_name);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    db.prepare('DELETE FROM documents WHERE candidature_id = ?').run(id);
    db.prepare('DELETE FROM notes WHERE candidature_id = ?').run(id);
    res.json({ ok: true });
  })
);

// =========================================================================
//  API : RAPPELS (relances) + STATS
// =========================================================================

app.get(
  '/api/reminders',
  asyncRoute((req, res) => {
    const delai = parseInt(getSetting('relance_delai_jours', '7'), 10);
    const rows = db.prepare('SELECT * FROM candidatures').all();
    const reminders = rows
      .map((c) => ({ ...c, relance: computeRelance(c, delai) }))
      .filter((c) => c.relance.aRelancer)
      .sort((a, b) => b.relance.joursRetard - a.relance.joursRetard);
    res.json({ delai, reminders });
  })
);

app.get(
  '/api/stats',
  asyncRoute((req, res) => {
    const total = db.prepare('SELECT COUNT(*) n FROM candidatures').get().n;
    const parStatut = db
      .prepare('SELECT statut, COUNT(*) n FROM candidatures GROUP BY statut')
      .all();
    const stats = { total };
    for (const s of STATUTS) stats[s] = 0;
    for (const r of parStatut) stats[r.statut] = r.n;
    res.json(stats);
  })
);

// =========================================================================
//  API : DOSSIERS
// =========================================================================

app.get(
  '/api/folders',
  asyncRoute((req, res) => {
    const rows = db
      .prepare(`
        SELECT f.*,
          (SELECT COUNT(*) FROM documents d WHERE d.folder_id = f.id) AS nb_docs,
          (SELECT COUNT(*) FROM notes n WHERE n.folder_id = f.id) AS nb_notes
        FROM folders f
        ORDER BY f.type, f.nom
      `)
      .all();
    res.json(rows);
  })
);

app.post(
  '/api/folders',
  asyncRoute((req, res) => {
    const { nom, type } = req.body || {};
    if (!nom) return res.status(400).json({ error: 'Le nom du dossier est requis.' });
    const t = ['cv', 'lettre', 'autre'].includes(type) ? type : 'autre';
    const info = db
      .prepare('INSERT INTO folders (nom, type) VALUES (?, ?)')
      .run(nom, t);
    res.status(201).json(
      db.prepare('SELECT * FROM folders WHERE id = ?').get(info.lastInsertRowid)
    );
  })
);

app.put(
  '/api/folders/:id',
  asyncRoute((req, res) => {
    const id = Number(req.params.id);
    const { nom, type } = req.body || {};
    const existing = db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Dossier introuvable.' });
    const t = ['cv', 'lettre', 'autre'].includes(type) ? type : existing.type;
    db.prepare('UPDATE folders SET nom = ?, type = ? WHERE id = ?').run(
      nom || existing.nom,
      t,
      id
    );
    res.json(db.prepare('SELECT * FROM folders WHERE id = ?').get(id));
  })
);

app.delete(
  '/api/folders/:id',
  asyncRoute((req, res) => {
    const id = Number(req.params.id);
    // Les documents/notes ne sont pas supprimés : ils repassent "sans dossier".
    db.prepare('UPDATE documents SET folder_id = NULL WHERE folder_id = ?').run(id);
    db.prepare('UPDATE notes SET folder_id = NULL WHERE folder_id = ?').run(id);
    db.prepare('DELETE FROM folders WHERE id = ?').run(id);
    res.json({ ok: true });
  })
);

// =========================================================================
//  API : DOCUMENTS (fichiers uploadés)
// =========================================================================

app.get(
  '/api/documents',
  asyncRoute((req, res) => {
    const { folder_id, candidature_id } = req.query;
    let sql = `
      SELECT d.*, f.nom AS folder_nom, c.entreprise AS candidature_entreprise,
             c.poste AS candidature_poste
      FROM documents d
      LEFT JOIN folders f ON f.id = d.folder_id
      LEFT JOIN candidatures c ON c.id = d.candidature_id
    `;
    const where = [];
    const params = [];
    if (folder_id === 'null') {
      where.push('d.folder_id IS NULL');
    } else if (folder_id !== undefined) {
      where.push('d.folder_id = ?');
      params.push(Number(folder_id));
    }
    if (candidature_id !== undefined) {
      where.push('d.candidature_id = ?');
      params.push(Number(candidature_id));
    }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY d.created_at DESC';
    res.json(db.prepare(sql).all(...params));
  })
);

app.post(
  '/api/documents',
  upload.single('file'),
  asyncRoute((req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu.' });
    const b = req.body || {};
    const type = ['cv', 'lettre', 'autre'].includes(b.type) ? b.type : 'autre';
    const info = db
      .prepare(`
        INSERT INTO documents
          (folder_id, candidature_id, type, original_name, stored_name, mime, size)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        b.folder_id ? Number(b.folder_id) : null,
        b.candidature_id ? Number(b.candidature_id) : null,
        type,
        fixOriginalName(req.file.originalname),
        req.file.filename,
        req.file.mimetype,
        req.file.size
      );
    res.status(201).json(
      db.prepare('SELECT * FROM documents WHERE id = ?').get(info.lastInsertRowid)
    );
  })
);

app.put(
  '/api/documents/:id',
  asyncRoute((req, res) => {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Document introuvable.' });
    const b = req.body || {};
    const type = ['cv', 'lettre', 'autre'].includes(b.type) ? b.type : existing.type;
    db.prepare(`
      UPDATE documents SET
        folder_id = ?, candidature_id = ?, type = ?, original_name = ?
      WHERE id = ?
    `).run(
      b.folder_id !== undefined ? (b.folder_id ? Number(b.folder_id) : null) : existing.folder_id,
      b.candidature_id !== undefined ? (b.candidature_id ? Number(b.candidature_id) : null) : existing.candidature_id,
      type,
      b.original_name || existing.original_name,
      id
    );
    res.json(db.prepare('SELECT * FROM documents WHERE id = ?').get(id));
  })
);

// Visualiser le fichier dans le navigateur (inline).
app.get(
  '/api/documents/:id/view',
  asyncRoute((req, res) => {
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(req.params.id));
    if (!doc) return res.status(404).json({ error: 'Document introuvable.' });
    const p = path.join(UPLOAD_DIR, doc.stored_name);
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'Fichier manquant.' });
    if (doc.mime) res.type(doc.mime);
    res.setHeader(
      'Content-Disposition',
      `inline; filename*=UTF-8''${encodeURIComponent(doc.original_name)}`
    );
    fs.createReadStream(p).pipe(res);
  })
);

// Télécharger le fichier.
app.get(
  '/api/documents/:id/download',
  asyncRoute((req, res) => {
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(req.params.id));
    if (!doc) return res.status(404).json({ error: 'Document introuvable.' });
    const p = path.join(UPLOAD_DIR, doc.stored_name);
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'Fichier manquant.' });
    res.download(p, doc.original_name);
  })
);

app.delete(
  '/api/documents/:id',
  asyncRoute((req, res) => {
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(req.params.id));
    if (!doc) return res.status(404).json({ error: 'Document introuvable.' });
    const p = path.join(UPLOAD_DIR, doc.stored_name);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
    res.json({ ok: true });
  })
);

// =========================================================================
//  API : NOTES (fichiers texte)
// =========================================================================

app.get(
  '/api/notes',
  asyncRoute((req, res) => {
    const { folder_id, candidature_id } = req.query;
    let sql = `
      SELECT n.*, f.nom AS folder_nom, c.entreprise AS candidature_entreprise,
             c.poste AS candidature_poste
      FROM notes n
      LEFT JOIN folders f ON f.id = n.folder_id
      LEFT JOIN candidatures c ON c.id = n.candidature_id
    `;
    const where = [];
    const params = [];
    if (folder_id === 'null') {
      where.push('n.folder_id IS NULL');
    } else if (folder_id !== undefined) {
      where.push('n.folder_id = ?');
      params.push(Number(folder_id));
    }
    if (candidature_id !== undefined) {
      where.push('n.candidature_id = ?');
      params.push(Number(candidature_id));
    }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY n.updated_at DESC';
    res.json(db.prepare(sql).all(...params));
  })
);

app.post(
  '/api/notes',
  asyncRoute((req, res) => {
    const b = req.body || {};
    const info = db
      .prepare(`
        INSERT INTO notes (folder_id, candidature_id, titre, contenu)
        VALUES (?, ?, ?, ?)
      `)
      .run(
        b.folder_id ? Number(b.folder_id) : null,
        b.candidature_id ? Number(b.candidature_id) : null,
        b.titre || 'Sans titre',
        b.contenu || ''
      );
    res.status(201).json(
      db.prepare('SELECT * FROM notes WHERE id = ?').get(info.lastInsertRowid)
    );
  })
);

app.put(
  '/api/notes/:id',
  asyncRoute((req, res) => {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM notes WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Note introuvable.' });
    const b = req.body || {};
    db.prepare(`
      UPDATE notes SET
        folder_id = ?, candidature_id = ?, titre = ?, contenu = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      b.folder_id !== undefined ? (b.folder_id ? Number(b.folder_id) : null) : existing.folder_id,
      b.candidature_id !== undefined ? (b.candidature_id ? Number(b.candidature_id) : null) : existing.candidature_id,
      b.titre ?? existing.titre,
      b.contenu ?? existing.contenu,
      id
    );
    res.json(db.prepare('SELECT * FROM notes WHERE id = ?').get(id));
  })
);

app.delete(
  '/api/notes/:id',
  asyncRoute((req, res) => {
    db.prepare('DELETE FROM notes WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  })
);

// =========================================================================
//  API : PARAMÈTRES
// =========================================================================

app.get(
  '/api/settings',
  asyncRoute((req, res) => {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const out = {};
    for (const r of rows) out[r.key] = r.value;
    res.json(out);
  })
);

app.put(
  '/api/settings',
  asyncRoute((req, res) => {
    const b = req.body || {};
    const stmt = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    );
    for (const [k, v] of Object.entries(b)) stmt.run(k, String(v));
    res.json({ ok: true });
  })
);

// Métadonnées (statuts disponibles) pour le frontend.
app.get('/api/meta', (req, res) => {
  res.json({ statuts: STATUTS });
});

// --- Gestion d'erreurs multer --------------------------------------------

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `Erreur d'upload : ${err.message}` });
  }
  console.error(err);
  res.status(500).json({ error: err.message || 'Erreur serveur' });
});

// --- Démarrage ------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`\n  ✅ Gestion des candidatures lancée !`);
  console.log(`  👉 Ouvre ton navigateur : http://localhost:${PORT}\n`);
});
