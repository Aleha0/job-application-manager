'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const dns = require('dns').promises;
const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const db = require('./db');
const pkg = require('./package.json');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Dossiers de stockage -------------------------------------------------

// Dossier des fichiers importés. Surchargeable via GC_UPLOAD_DIR pour isoler
// les tests de la production (ne JAMAIS faire pointer les tests sur 'uploads/').
const UPLOAD_DIR = process.env.GC_UPLOAD_DIR
  ? path.resolve(process.env.GC_UPLOAD_DIR)
  : path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Dossier de la base (même logique que db.js) — pour la sauvegarde.
const DATA_DIR = process.env.GC_DATA_DIR
  ? path.resolve(process.env.GC_DATA_DIR)
  : path.join(__dirname, 'data');

// --- Constantes -----------------------------------------------------------

const STATUTS = [
  'À postuler',
  'Envoyée',
  'Relancée',
  'Entretien',
  'Acceptée',
  'Refusée',
  'En réserve',
  'Sans réponse',
];

// Statuts pour lesquels une relance a encore du sens.
const STATUTS_RELANCABLES = ['Envoyée', 'Relancée', 'En réserve'];

// Canaux possibles pour une relance.
const RELANCE_CANAUX = ['mail', 'telephone', 'linkedin', 'autre'];

// --- Middlewares ----------------------------------------------------------

// En-têtes de sécurité (anti-sniff, anti-clickjacking, CSP adaptée à l'app).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline'; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com; " +
      "img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'"
  );
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Upload (multer) ------------------------------------------------------

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const unique = crypto.randomBytes(8).toString('hex');
    // Extension assainie (caractères sûrs uniquement, longueur bornée).
    let ext = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '');
    if (ext.length > 10) ext = '';
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

// Vrai si `s` est une date calendaire réelle au format YYYY-MM-DD
// (rejette p. ex. 2026-13-45 que la simple regex laisserait passer).
function isValidISODate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

// Renvoie l'URL seulement si elle est http(s) et bien formée, sinon null.
// Bloque les schémas dangereux (javascript:, data:, file:…) AVANT stockage,
// pour qu'aucun lien piégé ne puisse être enregistré puis cliqué (anti-XSS).
function safeHttpUrl(v) {
  if (v == null || typeof v === 'object') return null;
  const s = String(v).trim();
  if (!s || s.length > 2000) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? s : null;
  } catch {
    return null;
  }
}

// Ajoute `days` jours à une date ISO (YYYY-MM-DD) sans dérive de fuseau :
// tout le calcul se fait en UTC, donc le résultat = base + days exactement.
function addDaysISO(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  if (isNaN(d)) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// --- Étiquettes -----------------------------------------------------------

function parseTags(s) {
  try {
    const a = JSON.parse(s || '[]');
    return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

// Normalise une entrée de tags (tableau ou chaîne) en JSON string dédupliqué.
function normalizeTags(t) {
  let arr = t;
  if (typeof t === 'string') {
    try { arr = JSON.parse(t); } catch { arr = t.split(','); }
  }
  if (!Array.isArray(arr)) return '[]';
  const clean = [...new Set(arr.map((s) => String(s).trim()).filter(Boolean))];
  return JSON.stringify(clean);
}

function daysBetween(fromISO, toISO) {
  const a = new Date(fromISO + 'T00:00:00');
  const b = new Date(toISO + 'T00:00:00');
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

// Calcule, pour une candidature, si elle doit être relancée + la date prévue.
// `lastRelance` (date ISO ou null) = date de la dernière relance enregistrée.
function computeRelance(c, delaiJours, lastRelance) {
  if (!STATUTS_RELANCABLES.includes(c.statut)) {
    return { dueDate: null, aRelancer: false, joursRetard: 0 };
  }
  let dueDate = null;
  if (c.date_relance) {
    // Date de relance prévue, posée manuellement : prioritaire.
    dueDate = c.date_relance;
  } else {
    // Base : dernière relance faite si elle existe, sinon date de
    // candidature (ou date de création), puis + le délai configuré.
    const base = lastRelance || c.date_candidature || (c.created_at || '').slice(0, 10);
    if (base) dueDate = addDaysISO(base, delaiJours);
  }
  if (!dueDate) return { dueDate: null, aRelancer: false, joursRetard: 0 };
  const retard = daysBetween(dueDate, todayISO());
  return { dueDate, aRelancer: retard >= 0, joursRetard: retard };
}

// Map candidature_id -> { count, last } (dernière relance enregistrée).
function relanceAgg() {
  const m = new Map();
  for (const r of db
    .prepare('SELECT candidature_id, COUNT(*) AS count, MAX(date) AS last FROM relances GROUP BY candidature_id')
    .all()) {
    m.set(r.candidature_id, { count: r.count, last: r.last });
  }
  return m;
}

// Map candidature_id -> tableau des relances (plus récentes d'abord).
function relancesMap() {
  const m = new Map();
  for (const r of db.prepare('SELECT * FROM relances ORDER BY date DESC, id DESC').all()) {
    if (!m.has(r.candidature_id)) m.set(r.candidature_id, []);
    m.get(r.candidature_id).push(r);
  }
  return m;
}

// Renvoie une candidature enrichie (tags, relances, état de relance).
function enrichCandidature(c, delai, relancesArr) {
  const rel =
    relancesArr ||
    db.prepare('SELECT * FROM relances WHERE candidature_id = ? ORDER BY date DESC, id DESC').all(c.id);
  const last = rel.length ? rel[0].date : null;
  return { ...c, tags: parseTags(c.tags), relances: rel, relance: computeRelance(c, delai, last) };
}

// Normalise les champs de conservation RGPD reçus du client.
function parseCvConserve(v) {
  return v === true || v === 1 || v === '1' || v === 'on' ? 1 : 0;
}
function parseCvConserveMois(v) {
  return v != null && v !== '' && isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : null;
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
    const relMap = relancesMap();
    const enriched = rows.map((c) => enrichCandidature(c, delai, relMap.get(c.id) || []));
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
         recruteur_nom, recruteur_email, lien_offre, salaire, type_contrat, plateforme, date_reponse, cv_document_id, domaine, tags, cv_conserve, cv_conserve_mois)
      VALUES
        (@entreprise, @poste, @lieu, @statut, @date_candidature, @date_relance,
         @recruteur_nom, @recruteur_email, @lien_offre, @salaire, @type_contrat, @plateforme, @date_reponse, @cv_document_id, @domaine, @tags, @cv_conserve, @cv_conserve_mois)
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
      lien_offre: safeHttpUrl(b.lien_offre),
      salaire: b.salaire || null,
      type_contrat: b.type_contrat || null,
      plateforme: b.plateforme || null,
      date_reponse: b.date_reponse || null,
      cv_document_id: b.cv_document_id ? Number(b.cv_document_id) : null,
      domaine: b.domaine || null,
      tags: normalizeTags(b.tags),
      cv_conserve: parseCvConserve(b.cv_conserve),
      cv_conserve_mois: parseCvConserveMois(b.cv_conserve_mois),
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
        plateforme = @plateforme,
        date_reponse = @date_reponse,
        cv_document_id = @cv_document_id,
        domaine = @domaine,
        tags = @tags,
        cv_conserve = @cv_conserve,
        cv_conserve_mois = @cv_conserve_mois,
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
      lien_offre: b.lien_offre !== undefined ? safeHttpUrl(b.lien_offre) : existing.lien_offre,
      salaire: b.salaire ?? existing.salaire,
      type_contrat: b.type_contrat ?? existing.type_contrat,
      plateforme: b.plateforme !== undefined ? (b.plateforme || null) : existing.plateforme,
      date_reponse: b.date_reponse !== undefined ? (b.date_reponse || null) : existing.date_reponse,
      cv_document_id: b.cv_document_id !== undefined ? (b.cv_document_id ? Number(b.cv_document_id) : null) : existing.cv_document_id,
      domaine: b.domaine !== undefined ? (b.domaine || null) : existing.domaine,
      tags: b.tags !== undefined ? normalizeTags(b.tags) : existing.tags,
      cv_conserve: b.cv_conserve !== undefined ? parseCvConserve(b.cv_conserve) : existing.cv_conserve,
      cv_conserve_mois: b.cv_conserve_mois !== undefined ? parseCvConserveMois(b.cv_conserve_mois) : existing.cv_conserve_mois,
    });
    const row = db.prepare('SELECT * FROM candidatures WHERE id = ?').get(id);
    res.json(row);
  })
);

app.delete(
  '/api/candidatures/:id',
  asyncRoute((req, res) => {
    const id = Number(req.params.id);
    let conserves = 0;
    let supprimes = 0;

    // Documents liés à la candidature : ceux attachés (candidature_id) ET le
    // « CV envoyé » (cv_document_id). On supprime un document sauf s'il sert
    // ailleurs : attaché à une AUTRE candidature, « CV envoyé » d'une autre
    // candidature, ou présent dans une CVthèque. (Le dossier n'empêche pas la
    // suppression : un CV utilisé pour une seule candidature est bien supprimé.)
    const cand = db.prepare('SELECT cv_document_id FROM candidatures WHERE id = ?').get(id);
    const docIds = new Set();
    for (const d of db.prepare('SELECT id FROM documents WHERE candidature_id = ?').all(id)) docIds.add(d.id);
    if (cand && cand.cv_document_id) docIds.add(cand.cv_document_id);

    for (const docId of docIds) {
      const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId);
      if (!d) continue;
      const ailleurs =
        (d.candidature_id != null && d.candidature_id !== id) ||
        db.prepare('SELECT 1 FROM cvtheque_cvs WHERE document_id = ?').get(docId) ||
        db.prepare('SELECT 1 FROM candidatures WHERE cv_document_id = ? AND id != ?').get(docId, id);
      if (ailleurs) {
        if (d.candidature_id === id) db.prepare('UPDATE documents SET candidature_id = NULL WHERE id = ?').run(docId);
        conserves++;
      } else {
        const p = path.join(UPLOAD_DIR, d.stored_name);
        if (fs.existsSync(p)) fs.unlinkSync(p);
        db.prepare('DELETE FROM documents WHERE id = ?').run(docId);
        supprimes++;
      }
    }

    // Notes liées : conservées si elles sont aussi rangées dans un dossier.
    const notes = db.prepare('SELECT * FROM notes WHERE candidature_id = ?').all(id);
    for (const n of notes) {
      if (n.folder_id != null) {
        db.prepare('UPDATE notes SET candidature_id = NULL WHERE id = ?').run(n.id);
        conserves++;
      } else {
        db.prepare('DELETE FROM notes WHERE id = ?').run(n.id);
        supprimes++;
      }
    }

    db.prepare('DELETE FROM candidatures WHERE id = ?').run(id);
    res.json({ ok: true, conserves, supprimes });
  })
);

// =========================================================================
//  API : RELANCES (historique des relances d'une candidature)
// =========================================================================

// Enregistre une relance effectuée : crée l'événement, passe le statut à
// « Relancée » et consomme la date de relance prévue (date_relance).
app.post(
  '/api/candidatures/:id/relances',
  asyncRoute((req, res) => {
    const id = Number(req.params.id);
    const cand = db.prepare('SELECT * FROM candidatures WHERE id = ?').get(id);
    if (!cand) return res.status(404).json({ error: 'Candidature introuvable.' });
    const b = req.body || {};
    const date = isValidISODate(b.date) ? b.date : todayISO();
    const canal = RELANCE_CANAUX.includes(b.canal) ? b.canal : null;
    const note = b.note ? String(b.note).trim().slice(0, 2000) || null : null;
    db.prepare('INSERT INTO relances (candidature_id, date, canal, note) VALUES (?, ?, ?, ?)')
      .run(id, date, canal, note);
    // Passe le statut à « Relancée », SAUF si la candidature a déjà avancé
    // (entretien obtenu, acceptée, refusée) : on ne régresse pas son état.
    const STATUTS_AVANCES = ['Entretien', 'Acceptée', 'Refusée'];
    const nouveauStatut = STATUTS_AVANCES.includes(cand.statut) ? cand.statut : 'Relancée';
    db.prepare(
      "UPDATE candidatures SET statut = ?, date_relance = NULL, updated_at = datetime('now') WHERE id = ?"
    ).run(nouveauStatut, id);
    const delai = parseInt(getSetting('relance_delai_jours', '7'), 10);
    const updated = db.prepare('SELECT * FROM candidatures WHERE id = ?').get(id);
    res.status(201).json(enrichCandidature(updated, delai));
  })
);

// Supprime une relance (correction de saisie). Ne modifie pas le statut.
app.delete(
  '/api/candidatures/:id/relances/:rid',
  asyncRoute((req, res) => {
    const id = Number(req.params.id);
    const rid = Number(req.params.rid);
    const cand = db.prepare('SELECT * FROM candidatures WHERE id = ?').get(id);
    if (!cand) return res.status(404).json({ error: 'Candidature introuvable.' });
    db.prepare('DELETE FROM relances WHERE id = ? AND candidature_id = ?').run(rid, id);
    const delai = parseInt(getSetting('relance_delai_jours', '7'), 10);
    res.json(enrichCandidature(cand, delai));
  })
);

// =========================================================================
//  API : IMPORT de candidatures (JSON)
// =========================================================================

// Mappe un statut du fichier importé vers un statut de l'app (tolérant aux
// accents/casse). Repli sur « À postuler » si inconnu.
const STATUT_IMPORT_MAP = {
  refus: 'Refusée', refuse: 'Refusée', refusee: 'Refusée',
  'candidature envoyee': 'Envoyée', envoyee: 'Envoyée',
  'sans reponse': 'Sans réponse',
  'a postuler': 'À postuler',
  relancee: 'Relancée',
  entretien: 'Entretien',
  acceptee: 'Acceptée',
  'en reserve': 'En réserve',
};
function mapImportStatut(s) {
  if (STATUTS.includes(s)) return s;
  return STATUT_IMPORT_MAP[normalizeStr(s).trim()] || 'À postuler';
}

// Convertit une date d'import (JJ/MM/AAAA ou ISO) en ISO, ou null.
function parseImportDate(s) {
  if (s == null) return null;
  const str = String(s).trim();
  if (!str) return null;
  let m;
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(str))) {
    const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return isValidISODate(iso) ? iso : null;
  }
  if ((m = /^(\d{4}-\d{2}-\d{2})/.exec(str))) return isValidISODate(m[1]) ? m[1] : null;
  return null;
}

// Bornes défensives pour l'import (entrée potentiellement malveillante).
const IMPORT_STR_MAX = 2000;     // longueur max d'un champ texte
const IMPORT_NOTE_TITRE_MAX = 200;
const IMPORT_NOTE_CONTENU_MAX = 10000;
const IMPORT_MAX_TAGS = 50;      // par candidature
const IMPORT_TAG_MAX = 100;
const IMPORT_MAX_NOTES = 200;    // par candidature
const IMPORT_MAX_RELANCES = 200; // par candidature

// Convertit une valeur en texte borné, ou null. Rejette objets/tableaux
// (un champ texte ne doit pas être un objet -> évite "[object Object]").
function importEmptyToNull(v) {
  if (v == null || typeof v === 'object') return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > IMPORT_STR_MAX ? s.slice(0, IMPORT_STR_MAX) : s;
}

// 1re valeur non vide parmi plusieurs noms de champ (camelCase ou snake_case).
function importPick(raw, ...keys) {
  for (const k of keys) {
    if (raw[k] !== undefined && raw[k] !== null && raw[k] !== '') return raw[k];
  }
  return null;
}

// Normalise une ligne brute du fichier vers la structure interne.
function normalizeImportRow(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Entrée invalide' };
  const entreprise = importEmptyToNull(importPick(raw, 'entreprise'));
  const poste = importEmptyToNull(importPick(raw, 'poste'));
  if (!entreprise || !poste) return { error: 'Entreprise et poste requis (texte non vide)' };

  const tagsSrc = importPick(raw, 'etiquettes', 'tags');
  const tags = Array.isArray(tagsSrc)
    ? [...new Set(
        tagsSrc
          .filter((t) => t != null && typeof t !== 'object')
          .map((t) => String(t).trim().slice(0, IMPORT_TAG_MAX))
          .filter(Boolean)
      )].slice(0, IMPORT_MAX_TAGS)
    : [];

  const notesSrc = importPick(raw, 'notes');
  const notes = Array.isArray(notesSrc)
    ? notesSrc
        .slice(0, IMPORT_MAX_NOTES)
        .map((n) => {
          if (n && typeof n === 'object' && !Array.isArray(n)) {
            return {
              titre: String(n.label || n.titre || '').trim().slice(0, IMPORT_NOTE_TITRE_MAX) || 'Note',
              contenu: String(n.value || n.contenu || '').trim().slice(0, IMPORT_NOTE_CONTENU_MAX),
            };
          }
          if (typeof n === 'string' || typeof n === 'number') {
            return { titre: 'Note', contenu: String(n).trim().slice(0, IMPORT_NOTE_CONTENU_MAX) };
          }
          return null;
        })
        .filter((n) => n && n.contenu)
    : [];

  const cvConserveRaw = importPick(raw, 'cvConserve', 'cv_conserve');
  const cv_conserve = cvConserveRaw === true || cvConserveRaw === 1 || cvConserveRaw === '1' ? 1 : 0;
  const moisRaw = importPick(raw, 'cvConserveMois', 'cv_conserve_mois');
  const cv_conserve_mois =
    moisRaw != null && moisRaw !== '' && isFinite(Number(moisRaw)) ? Math.max(0, Math.round(Number(moisRaw))) : null;

  // Relances : soit un tableau `relances` (format app), soit une date unique
  // `dateRelance` (format suivi) = une relance déjà effectuée.
  let relances = [];
  const relSrc = importPick(raw, 'relances');
  if (Array.isArray(relSrc)) {
    relances = relSrc
      .slice(0, IMPORT_MAX_RELANCES)
      .map((r) => ({
        date: parseImportDate(r && r.date),
        canal: r && RELANCE_CANAUX.includes(r.canal) ? r.canal : null,
        note: r && r.note && typeof r.note !== 'object' ? String(r.note).trim().slice(0, 2000) : null,
      }))
      .filter((r) => r.date);
  } else {
    const d = parseImportDate(importPick(raw, 'dateRelance', 'date_relance'));
    if (d) relances = [{ date: d, canal: null, note: null }];
  }

  return {
    fields: {
      entreprise,
      poste,
      lieu: importEmptyToNull(importPick(raw, 'lieu')),
      statut: mapImportStatut(importPick(raw, 'statut')),
      date_candidature: parseImportDate(importPick(raw, 'dateCandidature', 'date_candidature')),
      date_reponse: parseImportDate(importPick(raw, 'dateReponse', 'date_reponse')),
      recruteur_nom: importEmptyToNull(importPick(raw, 'nomRecruteur', 'recruteur_nom')),
      recruteur_email: importEmptyToNull(importPick(raw, 'emailRecruteur', 'recruteur_email')),
      lien_offre: safeHttpUrl(importPick(raw, 'lienOffre', 'lien_offre')),
      salaire: importEmptyToNull(importPick(raw, 'salaire')),
      type_contrat: importEmptyToNull(importPick(raw, 'typeContrat', 'type_contrat')),
      plateforme: importEmptyToNull(importPick(raw, 'plateforme')),
      domaine: importEmptyToNull(importPick(raw, 'domaineMetier', 'domaine')),
      cv_conserve,
      cv_conserve_mois,
    },
    tags,
    notes,
    relances,
  };
}

// Étiquettes inconnues (non présentes dans la liste settings) parmi `tagNames`.
function unknownTagsAmong(tagNames) {
  let arr = [];
  try { arr = JSON.parse(getSetting('tags', '[]')); } catch { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  const nameOf = (t) => (typeof t === 'string' ? t : (t && t.name) || '');
  const existing = new Set(arr.map((t) => normalizeStr(nameOf(t))));
  const seen = new Set();
  const out = [];
  for (const name of tagNames) {
    const n = normalizeStr(name);
    if (!n || existing.has(n) || seen.has(n)) continue;
    seen.add(n);
    out.push(name);
  }
  return out;
}

// Ajoute réellement les étiquettes inconnues à la liste settings. Renvoie celles ajoutées.
function addUnknownTags(tagNames) {
  const toAdd = unknownTagsAmong(tagNames);
  if (!toAdd.length) return [];
  let arr = [];
  try { arr = JSON.parse(getSetting('tags', '[]')); } catch { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  for (const name of toAdd) {
    const hue = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
    arr.push({ name, hue });
  }
  db.prepare("INSERT INTO settings (key, value) VALUES ('tags', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(arr));
  return toAdd;
}

// Champs scalaires complétables sur une candidature existante (jamais le statut :
// on ne modifie pas l'état d'une candidature déjà saisie).
const IMPORT_COMPLETABLE = [
  'lieu', 'date_candidature', 'date_reponse', 'recruteur_nom', 'recruteur_email',
  'lien_offre', 'salaire', 'type_contrat', 'plateforme', 'domaine',
];

// Normalise un poste « en gros » : neutralise accents/casse, H/F<->F/H, tirets,
// écriture inclusive ; garde les marqueurs distinctifs « (2e cand.) », « réf… ».
function importFuzzyPoste(s) {
  let x = normalizeStr(s);
  x = x.replace(/[–—]/g, '-');
  x = x.replace(/\b[hf]\s*[\/-]\s*[hfx]\b/g, '');
  x = x.replace(/\.se\b/g, '').replace(/\(e\)/g, '');
  x = x.replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  return x;
}

// Détecte des quasi-doublons (sans fusionner). Pour les candidatures à CRÉER,
// signale celles qui ressemblent à une candidature existante OU à une autre du
// fichier : même entreprise + poste très similaire, ou même entreprise + date.
function detectPossibleDuplicates(createdRows, existing) {
  const fKey = (e, p) => normalizeStr(e) + '|' + importFuzzyPoste(p);
  const dKey = (e, d) => normalizeStr(e) + '@' + d;
  const eKey = (e, p) => normalizeStr(e) + '||' + normalizeStr(p);
  const label = (x) => `${x.entreprise} — ${x.poste}`;

  const exByFuzzy = new Map();
  const exByDate = new Map();
  for (const c of existing) {
    const fk = fKey(c.entreprise, c.poste);
    if (!exByFuzzy.has(fk)) exByFuzzy.set(fk, []);
    exByFuzzy.get(fk).push(c);
    if (c.date_candidature) {
      const dk = dKey(c.entreprise, c.date_candidature);
      if (!exByDate.has(dk)) exByDate.set(dk, []);
      exByDate.get(dk).push(c);
    }
  }

  const out = [];
  const seen = new Set();
  const add = (source, match, reason, where) => {
    const k = source + '##' + match + '##' + where;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ source, match, reason, where });
  };

  for (const r of createdRows) {
    const rE = eKey(r.entreprise, r.poste);
    for (const c of exByFuzzy.get(fKey(r.entreprise, r.poste)) || []) {
      if (eKey(c.entreprise, c.poste) !== rE) add(label(r), label(c), 'même entreprise, poste très similaire', 'existante');
    }
    if (r.date) {
      for (const c of exByDate.get(dKey(r.entreprise, r.date)) || []) {
        if (eKey(c.entreprise, c.poste) !== rE) add(label(r), label(c), 'même entreprise, même date', 'existante');
      }
    }
  }

  for (let i = 0; i < createdRows.length; i++) {
    for (let j = i + 1; j < createdRows.length; j++) {
      const a = createdRows[i], b = createdRows[j];
      if (eKey(a.entreprise, a.poste) === eKey(b.entreprise, b.poste)) continue;
      if (fKey(a.entreprise, a.poste) === fKey(b.entreprise, b.poste)) {
        add(label(a), label(b), 'poste très similaire', 'fichier');
      } else if (a.date && a.date === b.date && normalizeStr(a.entreprise) === normalizeStr(b.entreprise)) {
        add(label(a), label(b), 'même entreprise, même date', 'fichier');
      }
    }
  }
  return out;
}

// Traite l'import : dry-run (commit=false) ou exécution (commit=true).
function processImport(rows, commit) {
  const keyOf = (ent, pos) => normalizeStr(ent) + '||' + normalizeStr(pos);
  const existing = db.prepare('SELECT * FROM candidatures').all();
  const byKey = new Map();
  for (const c of existing) byKey.set(keyOf(c.entreprise, c.poste), c);

  const out = { total: rows.length, toCreate: 0, toComplete: 0, identical: 0, errors: [], details: [] };
  const allTags = new Set();
  const createdRows = []; // candidatures qui seront créées (pour détecter les quasi-doublons)

  const insCand = db.prepare(`
    INSERT INTO candidatures
      (entreprise, poste, lieu, statut, date_candidature, date_relance, recruteur_nom,
       recruteur_email, lien_offre, salaire, type_contrat, plateforme, date_reponse,
       cv_document_id, domaine, tags, cv_conserve, cv_conserve_mois)
    VALUES
      (@entreprise, @poste, @lieu, @statut, @date_candidature, NULL, @recruteur_nom,
       @recruteur_email, @lien_offre, @salaire, @type_contrat, @plateforme, @date_reponse,
       NULL, @domaine, @tags, @cv_conserve, @cv_conserve_mois)`);
  const insNote = db.prepare('INSERT INTO notes (candidature_id, titre, contenu) VALUES (?, ?, ?)');
  const insRel = db.prepare('INSERT INTO relances (candidature_id, date, canal, note) VALUES (?, ?, ?, ?)');

  const run = () => {
    rows.forEach((raw, i) => {
      const norm = normalizeImportRow(raw);
      if (norm.error) {
        out.errors.push({ index: i, error: norm.error, entreprise: (raw && raw.entreprise) || '' });
        return;
      }
      const f = norm.fields;
      norm.tags.forEach((t) => allTags.add(t));
      const key = keyOf(f.entreprise, f.poste);
      const exist = byKey.get(key);

      if (!exist) {
        out.toCreate++;
        out.details.push({ action: 'create', entreprise: f.entreprise, poste: f.poste });
        createdRows.push({ entreprise: f.entreprise, poste: f.poste, date: f.date_candidature || '' });
        if (commit) {
          const row = { ...f, date_candidature: f.date_candidature || todayISO(), tags: JSON.stringify(norm.tags) };
          const info = insCand.run(row);
          const id = info.lastInsertRowid;
          for (const n of norm.notes) insNote.run(id, n.titre, n.contenu);
          for (const r of norm.relances) insRel.run(id, r.date, r.canal, r.note);
          byKey.set(key, { id, ...row }); // doublons internes au fichier -> complétés
        }
      } else {
        const updates = {};
        for (const k of IMPORT_COMPLETABLE) {
          if ((exist[k] == null || exist[k] === '') && f[k] != null && f[k] !== '') updates[k] = f[k];
        }
        if (!exist.cv_conserve && f.cv_conserve) {
          updates.cv_conserve = 1;
          if (f.cv_conserve_mois != null) updates.cv_conserve_mois = f.cv_conserve_mois;
        } else if (exist.cv_conserve && exist.cv_conserve_mois == null && f.cv_conserve_mois != null) {
          updates.cv_conserve_mois = f.cv_conserve_mois;
        }
        const curTags = parseTags(exist.tags);
        const mergedTags = [...new Set([...curTags, ...norm.tags])];
        const tagsChanged = mergedTags.length !== curTags.length;

        if (Object.keys(updates).length === 0 && !tagsChanged) {
          out.identical++;
          out.details.push({ action: 'identical', entreprise: f.entreprise, poste: f.poste });
        } else {
          out.toComplete++;
          const champs = Object.keys(updates);
          if (tagsChanged) champs.push('tags');
          out.details.push({ action: 'complete', entreprise: f.entreprise, poste: f.poste, champs });
          if (commit) {
            if (tagsChanged) updates.tags = JSON.stringify(mergedTags);
            const sets = Object.keys(updates).map((k) => `${k} = @${k}`).join(', ');
            db.prepare(`UPDATE candidatures SET ${sets}, updated_at = datetime('now') WHERE id = @id`)
              .run({ ...updates, id: exist.id });
            byKey.set(key, { ...exist, ...updates });
          }
        }
      }
    });
  };

  if (commit) db.transaction(run)();
  else run();

  out.tagsToAdd = unknownTagsAmong(allTags);
  out.possibleDuplicates = detectPossibleDuplicates(createdRows, existing);
  if (commit) out.tagsAdded = addUnknownTags(allTags);
  return out;
}

app.post(
  '/api/candidatures/import',
  asyncRoute((req, res) => {
    const b = req.body || {};
    let rows = b.data;
    if (rows && !Array.isArray(rows) && Array.isArray(rows.candidatures)) rows = rows.candidatures;
    if (!Array.isArray(rows)) {
      return res.status(400).json({ error: 'Format attendu : un tableau JSON de candidatures (ou un objet { candidatures: [...] }).' });
    }
    if (rows.length === 0) return res.status(400).json({ error: 'Aucune candidature dans le fichier.' });
    if (rows.length > 500) return res.status(400).json({ error: "Trop d'entrées (500 max par import)." });
    const commit = b.confirm === true;
    res.json({ committed: commit, ...processImport(rows, commit) });
  })
);

// =========================================================================
//  API : RAPPELS (relances) + STATS
// =========================================================================

app.get(
  '/api/reminders',
  asyncRoute((req, res) => {
    const delai = parseInt(getSetting('relance_delai_jours', '7'), 10);
    const agg = relanceAgg();
    const rows = db.prepare('SELECT * FROM candidatures').all();
    const reminders = rows
      .map((c) => ({ ...c, relance: computeRelance(c, delai, (agg.get(c.id) || {}).last) }))
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

// Données agrégées pour la vue Statistiques (graphiques).
function lastNMonths(n) {
  const out = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

app.get(
  '/api/stats/charts',
  asyncRoute((req, res) => {
    const rows = db.prepare('SELECT statut, date_candidature, date_reponse, plateforme, lieu, cv_document_id, domaine FROM candidatures').all();
    const total = rows.length;

    const parStatut = {};
    for (const s of STATUTS) parStatut[s] = 0;
    const platMap = {};
    const platStats = {}; // nom -> { total, entretiens }
    const lieuMap = {};
    const domaineMap = {};
    const moisMap = {};
    const estEntretien = (s) => s === 'Entretien' || s === 'Acceptée';
    for (const r of rows) {
      parStatut[r.statut] = (parStatut[r.statut] || 0) + 1;
      if (r.plateforme) {
        platMap[r.plateforme] = (platMap[r.plateforme] || 0) + 1;
        const ps = platStats[r.plateforme] || (platStats[r.plateforme] = { total: 0, entretiens: 0 });
        ps.total++;
        if (estEntretien(r.statut)) ps.entretiens++;
      }
      if (r.lieu) lieuMap[r.lieu] = (lieuMap[r.lieu] || 0) + 1;
      if (r.domaine) domaineMap[r.domaine] = (domaineMap[r.domaine] || 0) + 1;
      const m = (r.date_candidature || '').slice(0, 7);
      if (m) moisMap[m] = (moisMap[m] || 0) + 1;
    }

    const mois = lastNMonths(12).map((m) => ({ mois: m, count: moisMap[m] || 0 }));
    const parPlateforme = Object.entries(platMap)
      .map(([nom, count]) => ({ nom, count }))
      .sort((a, b) => b.count - a.count);

    const g = (s) => parStatut[s] || 0;
    const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);

    const parPlateformeTaux = Object.entries(platStats)
      .map(([nom, o]) => ({ nom, total: o.total, entretiens: o.entretiens, taux: pct(o.entretiens, o.total) }))
      .sort((a, b) => b.taux - a.taux || b.total - a.total);

    const parLieu = Object.entries(lieuMap)
      .map(([nom, count]) => ({ nom, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    const parDomaine = Object.entries(domaineMap)
      .map(([nom, count]) => ({ nom, count }))
      .sort((a, b) => b.count - a.count);

    const cloturees = g('Acceptée') + g('Refusée') + g('Sans réponse');
    const actives = total - cloturees;

    // Rythme : candidatures cette semaine (lun-dim) et ce mois.
    const now = new Date();
    const dow = (now.getDay() + 6) % 7; // lundi = 0
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
    const weekStart = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
    const curMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    let semaine = 0;
    let moisCourant = 0;
    for (const r of rows) {
      const dc = r.date_candidature || '';
      if (dc && dc >= weekStart) semaine++;
      if (dc.slice(0, 7) === curMonth) moisCourant++;
    }
    const objectifHebdo = parseInt(getSetting('objectif_hebdo', '5'), 10) || 5;

    // Délai moyen de réponse (jours entre candidature et date de réponse).
    let sumDelai = 0;
    let nbReponses = 0;
    for (const r of rows) {
      if (r.date_candidature && r.date_reponse) {
        const j = daysBetween(r.date_candidature, r.date_reponse);
        if (j >= 0) { sumDelai += j; nbReponses++; }
      }
    }
    const delaiReponse = { jours: nbReponses > 0 ? Math.round(sumDelai / nbReponses) : null, nb: nbReponses };

    // Taux d'entretien par CV envoyé.
    const cvStats = {}; // doc id -> { total, entretiens }
    for (const r of rows) {
      if (r.cv_document_id) {
        const cs = cvStats[r.cv_document_id] || (cvStats[r.cv_document_id] = { total: 0, entretiens: 0 });
        cs.total++;
        if (estEntretien(r.statut)) cs.entretiens++;
      }
    }
    const docNames = {};
    for (const d of db.prepare('SELECT id, original_name FROM documents').all()) docNames[d.id] = d.original_name;
    const parCvTaux = Object.entries(cvStats)
      .map(([id, o]) => ({ nom: docNames[id] || 'CV supprimé', total: o.total, entretiens: o.entretiens, taux: pct(o.entretiens, o.total) }))
      .sort((a, b) => b.taux - a.taux || b.total - a.total);

    const envoyees = total - g('À postuler');
    const entretiens = g('Entretien') + g('Acceptée');
    const acceptees = g('Acceptée');
    const reponses = g('Entretien') + g('Acceptée') + g('Refusée') + g('En réserve');

    res.json({
      total,
      parStatut,
      mois,
      parPlateforme,
      parPlateformeTaux,
      parLieu,
      parDomaine,
      activite: { actives, cloturees },
      rythme: { semaine, mois: moisCourant, objectif: objectifHebdo },
      delaiReponse,
      parCvTaux,
      funnel: { envoyees, entretiens, acceptees },
      taux: {
        reponse: pct(reponses, envoyees),
        entretien: pct(entretiens, envoyees),
        acceptation: pct(acceptees, envoyees),
      },
    });
  })
);

// =========================================================================
//  API : RECHERCHE GLOBALE
// =========================================================================

// Normalisation insensible à la casse ET aux accents.
function normalizeStr(s) {
  return (s == null ? '' : String(s))
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

app.get(
  '/api/search',
  asyncRoute((req, res) => {
    const q = normalizeStr(req.query.q || '').trim();
    if (q.length < 2) {
      return res.json({ q, candidatures: [], documents: [], notes: [] });
    }

    const delai = parseInt(getSetting('relance_delai_jours', '7'), 10);
    const relMap = relancesMap();

    const candidatures = db
      .prepare('SELECT * FROM candidatures')
      .all()
      .map((c) => enrichCandidature(c, delai, relMap.get(c.id) || []))
      .filter((c) =>
        normalizeStr(
          [c.entreprise, c.poste, c.lieu, c.recruteur_nom, c.recruteur_email,
           c.salaire, c.type_contrat, c.statut, c.plateforme, c.domaine, (c.tags || []).join(' ')].join(' ')
        ).includes(q)
      )
      .slice(0, 25);

    const documents = db
      .prepare(`
        SELECT d.*, f.nom AS folder_nom, c.entreprise AS candidature_entreprise,
               c.poste AS candidature_poste
        FROM documents d
        LEFT JOIN folders f ON f.id = d.folder_id
        LEFT JOIN candidatures c ON c.id = d.candidature_id
      `)
      .all()
      .filter((d) =>
        normalizeStr(
          [d.original_name, d.type, d.folder_nom, d.candidature_entreprise, d.candidature_poste].join(' ')
        ).includes(q)
      )
      .slice(0, 25);

    const notes = db
      .prepare(`
        SELECT n.*, f.nom AS folder_nom, c.entreprise AS candidature_entreprise,
               c.poste AS candidature_poste
        FROM notes n
        LEFT JOIN folders f ON f.id = n.folder_id
        LEFT JOIN candidatures c ON c.id = n.candidature_id
      `)
      .all()
      .filter((n) =>
        normalizeStr(
          [n.titre, n.contenu, n.folder_nom, n.candidature_entreprise, n.candidature_poste].join(' ')
        ).includes(q)
      )
      .slice(0, 25);

    res.json({ q, candidatures, documents, notes });
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
             c.poste AS candidature_poste,
             (SELECT GROUP_CONCAT(cv.nom, '||')
                FROM cvtheque_cvs j JOIN cvtheques cv ON cv.id = j.cvtheque_id
               WHERE j.document_id = d.id) AS cvtheques_noms
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
    const rows = db.prepare(sql).all(...params).map((d) => ({
      ...d,
      cvtheques: d.cvtheques_noms ? d.cvtheques_noms.split('||') : [],
    }));
    res.json(rows);
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
          (folder_id, candidature_id, type, original_name, stored_name, mime, size, file_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        b.folder_id ? Number(b.folder_id) : null,
        b.candidature_id ? Number(b.candidature_id) : null,
        type,
        fixOriginalName(req.file.originalname),
        req.file.filename,
        req.file.mimetype,
        req.file.size,
        b.file_date || null
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
        folder_id = ?, candidature_id = ?, type = ?, original_name = ?, file_date = ?
      WHERE id = ?
    `).run(
      b.folder_id !== undefined ? (b.folder_id ? Number(b.folder_id) : null) : existing.folder_id,
      b.candidature_id !== undefined ? (b.candidature_id ? Number(b.candidature_id) : null) : existing.candidature_id,
      type,
      b.original_name || existing.original_name,
      b.file_date !== undefined ? (b.file_date || null) : existing.file_date,
      id
    );
    res.json(db.prepare('SELECT * FROM documents WHERE id = ?').get(id));
  })
);

// Types autorisés à s'afficher « inline » dans le navigateur (les autres sont
// téléchargés). Empêche un fichier HTML/SVG uploadé d'exécuter du script.
const INLINE_MIME_OK = new Set([
  'application/pdf', 'text/plain',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
]);

app.get(
  '/api/documents/:id/view',
  asyncRoute((req, res) => {
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(req.params.id));
    if (!doc) return res.status(404).json({ error: 'Document introuvable.' });
    const p = path.join(UPLOAD_DIR, doc.stored_name);
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'Fichier manquant.' });

    const safeInline = doc.mime && INLINE_MIME_OK.has(doc.mime);
    // Bac à sable + pas de sniff : le contenu ne peut pas exécuter de script.
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; sandbox");
    if (safeInline) res.type(doc.mime);
    else res.type('application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `${safeInline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(doc.original_name)}`
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

// Renomme un domaine métier : met à jour la liste ET les candidatures liées.
app.post(
  '/api/domaines/rename',
  asyncRoute((req, res) => {
    const from = (req.body && req.body.from ? String(req.body.from) : '').trim();
    const to = (req.body && req.body.to ? String(req.body.to) : '').trim();
    if (!from || !to) return res.status(400).json({ error: 'Ancien et nouveau nom requis.' });

    let arr = [];
    try { arr = JSON.parse(getSetting('domaines', '[]')); } catch { arr = []; }
    if (!Array.isArray(arr) || !arr.includes(from)) {
      return res.status(404).json({ error: 'Domaine introuvable.' });
    }
    if (arr.some((d) => d.toLowerCase() === to.toLowerCase() && d !== from)) {
      return res.status(400).json({ error: 'Un domaine porte déjà ce nom.' });
    }
    arr = arr.map((d) => (d === from ? to : d));
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('domaines', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(JSON.stringify(arr));
    const info = db.prepare('UPDATE candidatures SET domaine = ? WHERE domaine = ?').run(to, from);
    res.json({ ok: true, updated: info.changes });
  })
);

// =========================================================================
//  API : CVTHÈQUES (sites où le CV est déposé)
// =========================================================================

function monthsSinceISO(iso) {
  if (!iso) return Infinity;
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return 0;
  return (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
}

// Calcule si une CVthèque est à mettre à jour, et pourquoi.
// maxCvDate = date du CV lié le plus récent (chaîne ISO, '' si aucun).
function computeCvthequeStatus(maxCvDate, derniere_maj, delaiMois) {
  const cvNewer = maxCvDate && (!derniere_maj || maxCvDate > derniere_maj);
  const never = !derniere_maj;
  const tooOld = derniere_maj && monthsSinceISO(derniere_maj) >= delaiMois;
  let raison = '';
  if (cvNewer) raison = 'CV plus récent disponible';
  else if (never) raison = 'Jamais mise à jour';
  else if (tooOld) raison = `Pas mise à jour depuis +${delaiMois} mois`;
  return { aMettreAJour: !!(cvNewer || never || tooOld), raison };
}

// Remplace la liste des CV liés à une CVthèque.
function setCvthequeCvs(cvthequeId, ids) {
  db.prepare('DELETE FROM cvtheque_cvs WHERE cvtheque_id = ?').run(cvthequeId);
  const ins = db.prepare('INSERT OR IGNORE INTO cvtheque_cvs (cvtheque_id, document_id) VALUES (?, ?)');
  for (const id of ids || []) {
    if (id) ins.run(cvthequeId, Number(id));
  }
}

app.get(
  '/api/cvtheques',
  asyncRoute((req, res) => {
    const delaiMois = parseInt(getSetting('cvtheque_maj_delai_mois', '3'), 10);
    const rows = db.prepare('SELECT * FROM cvtheques ORDER BY nom COLLATE NOCASE').all();
    const cvsStmt = db.prepare(`
      SELECT d.id, d.original_name, d.file_date, d.type
      FROM cvtheque_cvs j JOIN documents d ON d.id = j.document_id
      WHERE j.cvtheque_id = ?
      ORDER BY d.original_name COLLATE NOCASE
    `);
    res.json(
      rows.map((r) => {
        const cvs = cvsStmt.all(r.id);
        const maxCvDate = cvs.reduce((m, d) => (d.file_date && d.file_date > m ? d.file_date : m), '');
        return { ...r, cvs, ...computeCvthequeStatus(maxCvDate, r.derniere_maj, delaiMois) };
      })
    );
  })
);

app.post(
  '/api/cvtheques',
  asyncRoute((req, res) => {
    const b = req.body || {};
    if (!b.nom) return res.status(400).json({ error: 'Le nom est requis.' });
    const info = db
      .prepare('INSERT INTO cvtheques (nom, url, derniere_maj, notes) VALUES (?, ?, ?, ?)')
      .run(b.nom, safeHttpUrl(b.url), b.derniere_maj || null, b.notes || null);
    setCvthequeCvs(info.lastInsertRowid, b.cv_document_ids);
    res.status(201).json(db.prepare('SELECT * FROM cvtheques WHERE id = ?').get(info.lastInsertRowid));
  })
);

app.put(
  '/api/cvtheques/:id',
  asyncRoute((req, res) => {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM cvtheques WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'CVthèque introuvable.' });
    const b = req.body || {};
    db.prepare(`
      UPDATE cvtheques SET
        nom = ?, url = ?, derniere_maj = ?, notes = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      b.nom ?? existing.nom,
      b.url !== undefined ? safeHttpUrl(b.url) : existing.url,
      b.derniere_maj !== undefined ? (b.derniere_maj || null) : existing.derniere_maj,
      b.notes !== undefined ? (b.notes || null) : existing.notes,
      id
    );
    if (b.cv_document_ids !== undefined) setCvthequeCvs(id, b.cv_document_ids);
    res.json(db.prepare('SELECT * FROM cvtheques WHERE id = ?').get(id));
  })
);

app.delete(
  '/api/cvtheques/:id',
  asyncRoute((req, res) => {
    db.prepare('DELETE FROM cvtheques WHERE id = ?').run(Number(req.params.id));
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

// Clés de réglages modifiables par le client (liste blanche).
const ALLOWED_SETTINGS = new Set([
  'relance_delai_jours', 'ntfy_topic', 'ntfy_server', 'tags', 'plateformes',
  'domaines', 'cvtheque_maj_delai_mois', 'objectif_hebdo',
]);

app.put(
  '/api/settings',
  asyncRoute((req, res) => {
    const b = req.body || {};
    const stmt = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    );
    for (const [k, v] of Object.entries(b)) {
      if (ALLOWED_SETTINGS.has(k)) stmt.run(k, String(v));
    }
    res.json({ ok: true });
  })
);

// Métadonnées (statuts disponibles) pour le frontend.
app.get('/api/meta', (req, res) => {
  res.json({ statuts: STATUTS, aiAvailable: !!process.env.ANTHROPIC_API_KEY });
});

// Infos « À propos » : version + compteurs de données.
app.get(
  '/api/about',
  asyncRoute((req, res) => {
    const count = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
    res.json({
      version: pkg.version,
      counts: {
        candidatures: count('candidatures'),
        documents: count('documents'),
        notes: count('notes'),
        cvtheques: count('cvtheques'),
      },
    });
  })
);

// Échappe une cellule CSV (séparateur ;).
function csvCell(v) {
  let s = v == null ? '' : String(v);
  // Anti-injection de formule : une cellule commençant par = + - @ (ou tab/CR)
  // peut être exécutée comme formule par Excel/Sheets. On la neutralise avec une
  // apostrophe de tête (la valeur reste lisible, mais n'est plus interprétée).
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Construit le CSV des candidatures (en-têtes FR, séparateur ;).
function buildCandidaturesCsv(rows) {
  const agg = relanceAgg();
  const headers = [
    'Entreprise', 'Poste', 'Lieu', 'Statut', 'Type de contrat', 'Plateforme',
    'Salaire', 'Date de candidature', 'Date de relance', 'Date de réponse',
    'Nb relances', 'Dernière relance',
    'Recruteur', 'Email recruteur', "Lien de l'offre", 'Étiquettes',
  ];
  const lines = [headers.join(';')];
  for (const c of rows) {
    const r = agg.get(c.id) || { count: 0, last: '' };
    lines.push([
      c.entreprise, c.poste, c.lieu, c.statut, c.type_contrat, c.plateforme,
      c.salaire, c.date_candidature, c.date_relance, c.date_reponse,
      r.count, r.last || '',
      c.recruteur_nom, c.recruteur_email, c.lien_offre, parseTags(c.tags).join(', '),
    ].map(csvCell).join(';'));
  }
  return lines.join('\r\n');
}

// Sauvegarde complète : zip de la base (data/) + des fichiers (uploads/)
// + un export interopérable (JSON complet et CSV des candidatures).
app.get('/api/backup', (req, res) => {
  // Consolide le WAL dans le fichier .db pour une sauvegarde cohérente.
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { console.error('checkpoint:', e.message); }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="sauvegarde-candidatures-${todayISO()}.zip"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    console.error('backup:', err);
    if (!res.headersSent) res.status(500);
    try { res.end(); } catch {}
  });
  archive.pipe(res);

  // Dossiers bruts (restauration dans l'app).
  if (fs.existsSync(DATA_DIR)) archive.directory(DATA_DIR, 'data');
  if (fs.existsSync(UPLOAD_DIR)) archive.directory(UPLOAD_DIR, 'uploads');

  // Export réutilisable par d'autres applications.
  try {
    const candidatures = db
      .prepare('SELECT * FROM candidatures ORDER BY date_candidature DESC, id DESC')
      .all();
    const settings = {};
    for (const r of db.prepare('SELECT key, value FROM settings').all()) settings[r.key] = r.value;
    const full = {
      app: 'gestion-candidatures',
      version: pkg.version,
      exported_at: new Date().toISOString(),
      candidatures: candidatures.map((c) => ({ ...c, tags: parseTags(c.tags) })),
      relances: db.prepare('SELECT * FROM relances').all(),
      documents: db.prepare('SELECT * FROM documents').all(),
      notes: db.prepare('SELECT * FROM notes').all(),
      folders: db.prepare('SELECT * FROM folders').all(),
      cvtheques: db.prepare('SELECT * FROM cvtheques').all(),
      cvtheque_cvs: db.prepare('SELECT * FROM cvtheque_cvs').all(),
      settings,
    };
    archive.append(JSON.stringify(full, null, 2), { name: 'export/donnees.json' });
    // BOM UTF-8 pour qu'Excel affiche bien les accents.
    archive.append('﻿' + buildCandidaturesCsv(candidatures), { name: 'export/candidatures.csv' });
  } catch (e) {
    console.error('backup export:', e.message);
  }

  archive.finalize();
});

// --- Export Excel / PDF des candidatures ---------------------------------

// Colonnes communes aux exports.
const EXPORT_COLS = [
  { header: 'Entreprise', key: 'entreprise', width: 22 },
  { header: 'Poste', key: 'poste', width: 24 },
  { header: 'Lieu', key: 'lieu', width: 16 },
  { header: 'Statut', key: 'statut', width: 14 },
  { header: 'Type de contrat', key: 'type_contrat', width: 14 },
  { header: 'Plateforme', key: 'plateforme', width: 16 },
  { header: 'Domaine', key: 'domaine', width: 18 },
  { header: 'Salaire', key: 'salaire', width: 12 },
  { header: 'Date candidature', key: 'date_candidature', width: 16 },
  { header: 'Date relance', key: 'date_relance', width: 14 },
  { header: 'Date réponse', key: 'date_reponse', width: 14 },
  { header: 'Nb relances', key: 'nb_relances', width: 11 },
  { header: 'Dernière relance', key: 'derniere_relance', width: 16 },
  { header: 'Recruteur', key: 'recruteur_nom', width: 18 },
  { header: 'Email recruteur', key: 'recruteur_email', width: 22 },
  { header: "Lien de l'offre", key: 'lien_offre', width: 30 },
  { header: 'Étiquettes', key: 'tags', width: 22 },
];

// Filtres d'export (depuis la query string) : statut, domaine, plateforme, plage de dates.
function parseExportFilters(q) {
  q = q || {};
  return {
    statut: q.statut ? String(q.statut) : '',
    domaine: q.domaine ? String(q.domaine) : '',
    plateforme: q.plateforme ? String(q.plateforme) : '',
    from: isValidISODate(q.from) ? q.from : '',
    to: isValidISODate(q.to) ? q.to : '',
  };
}
function exportMatches(c, f) {
  if (f.statut && c.statut !== f.statut) return false;
  if (f.domaine && c.domaine !== f.domaine) return false;
  if (f.plateforme && c.plateforme !== f.plateforme) return false;
  const dc = c.date_candidature || '';
  if (f.from && (!dc || dc < f.from)) return false;
  if (f.to && (!dc || dc > f.to)) return false;
  return true;
}
function candidaturesFiltered(query) {
  const f = parseExportFilters(query);
  return db
    .prepare('SELECT * FROM candidatures ORDER BY date_candidature DESC, id DESC')
    .all()
    .filter((c) => exportMatches(c, f));
}

// Lignes prêtes pour Excel/PDF/CSV (tags en texte, agrégats de relances).
function candidaturesForExport(query) {
  const agg = relanceAgg();
  return candidaturesFiltered(query).map((c) => {
    const r = agg.get(c.id) || { count: 0, last: '' };
    return { ...c, tags: parseTags(c.tags).join(', '), nb_relances: r.count, derniere_relance: r.last || '' };
  });
}

// Objets candidature au format JSON ré-importable (tags + relances en tableaux).
function candidaturesForJson(query) {
  const relMap = relancesMap();
  return candidaturesFiltered(query).map((c) => {
    const { id, cv_document_id, created_at, updated_at, ...rest } = c;
    return {
      ...rest,
      tags: parseTags(c.tags),
      relances: (relMap.get(c.id) || []).map((r) => ({ date: r.date, canal: r.canal, note: r.note })),
    };
  });
}

app.get('/api/export/excel', async (req, res) => {
  try {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Candidatures');
    ws.columns = EXPORT_COLS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF0FE' } };
    ws.autoFilter = { from: 'A1', to: { row: 1, column: EXPORT_COLS.length } };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    for (const c of candidaturesForExport(req.query)) ws.addRow(c);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="candidatures-${todayISO()}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('export excel:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Erreur export Excel.' });
  }
});

app.get('/api/export/pdf', (req, res) => {
  try {
    const rows = candidaturesForExport(req.query);
    // Colonnes clés (largeurs de base, mises à l'échelle pour remplir la page).
    const cols = [
      { label: 'Entreprise', key: 'entreprise', w: 130 },
      { label: 'Poste', key: 'poste', w: 165 },
      { label: 'Statut', key: 'statut', w: 80 },
      { label: 'Plateforme', key: 'plateforme', w: 95 },
      { label: 'Domaine', key: 'domaine', w: 105 },
      { label: 'Lieu', key: 'lieu', w: 90 },
      { label: 'Candidature', key: 'date_candidature', w: 80 },
    ];
    const FS = 9;
    const PADX = 6;
    const PADY = 5;
    const MINH = 14;

    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, bufferPages: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="candidatures-${todayISO()}.pdf"`);
    doc.pipe(res);

    const left = doc.page.margins.left;
    const top = doc.page.margins.top;
    const bottom = doc.page.height - doc.page.margins.bottom;

    // Met les colonnes à l'échelle pour occuper toute la largeur utile.
    const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const baseSum = cols.reduce((s, c) => s + c.w, 0);
    const k = usable / baseSum;
    for (const c of cols) c.w = c.w * k;
    const tableW = usable;

    // Récapitulatif par statut (statuts non vides, dans l'ordre).
    const counts = {};
    for (const r of rows) counts[r.statut] = (counts[r.statut] || 0) + 1;
    const summary = STATUTS.filter((s) => counts[s]).map((s) => `${s} : ${counts[s]}`).join('     ·     ');

    // Date + heure de l'export (ex : 22/06/2026 à 14:30).
    const now = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const exportLe = `${p2(now.getDate())}/${p2(now.getMonth() + 1)}/${now.getFullYear()} à ${p2(now.getHours())}:${p2(now.getMinutes())}`;

    const drawTitle = () => {
      doc.font('Helvetica-Bold').fontSize(16).fillColor('#1c2333').text('Mes candidatures', left, top);
      doc.font('Helvetica').fontSize(9).fillColor('#8b92a6').text(`Export du ${exportLe}`);
      doc.moveDown(0.5);
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#4f46e5').text(`Total : ${rows.length} candidature(s)`);
      if (summary) {
        doc.moveDown(0.25);
        doc.font('Helvetica').fontSize(9).fillColor('#5a6275').text(summary, { width: tableW });
      }
      doc.moveDown(0.7);
    };

    const drawHeader = () => {
      const y = doc.y;
      const h = MINH + 6;
      doc.rect(left, y, tableW, h).fill('#4f46e5');
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(FS);
      let x = left;
      for (const c of cols) {
        doc.text(c.label, x + PADX, y + 5, { width: c.w - PADX * 2, lineBreak: false, ellipsis: true });
        x += c.w;
      }
      doc.font('Helvetica').fillColor('#1c2333');
      doc.y = y + h;
    };

    drawTitle();
    drawHeader();

    let alt = false;
    for (const r of rows) {
      doc.fontSize(FS).font('Helvetica');
      // Hauteur de ligne dynamique : la plus haute cellule (texte multi-lignes).
      let cellH = MINH;
      for (const c of cols) {
        const v = r[c.key] == null ? '' : String(r[c.key]);
        const hh = doc.heightOfString(v, { width: c.w - PADX * 2 });
        if (hh > cellH) cellH = hh;
      }
      const rowH = cellH + PADY * 2;

      if (doc.y + rowH > bottom) { doc.addPage(); drawHeader(); alt = false; }

      const y = doc.y;
      if (alt) doc.rect(left, y, tableW, rowH).fill('#f3f4fb');
      alt = !alt;

      doc.fillColor('#1c2333').fontSize(FS).font('Helvetica');
      let x = left;
      for (const c of cols) {
        const v = r[c.key] == null ? '' : String(r[c.key]);
        doc.text(v, x + PADX, y + PADY, { width: c.w - PADX * 2 });
        x += c.w;
      }
      doc.moveTo(left, y + rowH).lineTo(left + tableW, y + rowH).strokeColor('#e4e7ee').lineWidth(0.5).stroke();
      doc.y = y + rowH;
    }

    if (!rows.length) {
      doc.fontSize(10).fillColor('#8b92a6').text('Aucune candidature.', left, doc.y + 8);
    }

    // Numéros de page en pied (sur chaque page).
    // On annule temporairement la marge basse, sinon pdfkit ajoute des pages.
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      const oldBottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('Helvetica').fontSize(8).fillColor('#8b92a6')
        .text(`Page ${i + 1} / ${range.count}`, left, doc.page.height - 24, {
          width: tableW, align: 'right', lineBreak: false,
        });
      doc.page.margins.bottom = oldBottom;
    }

    doc.end();
  } catch (err) {
    console.error('export pdf:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Erreur export PDF.' });
  }
});

// Export CSV (filtré), UTF-8 avec BOM pour Excel.
app.get('/api/export/csv', asyncRoute((req, res) => {
  const rows = candidaturesFiltered(req.query);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="candidatures-${todayISO()}.csv"`);
  res.send('﻿' + buildCandidaturesCsv(rows));
}));

// Export JSON (filtré), structure ré-importable.
app.get('/api/export/json', asyncRoute((req, res) => {
  const data = candidaturesForJson(req.query);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="candidatures-${todayISO()}.json"`);
  res.send(JSON.stringify({ app: pkg.name, exported_at: new Date().toISOString(), candidatures: data }, null, 2));
}));

// Aperçu d'export : nombre de candidatures correspondant aux filtres + échantillon.
app.get('/api/export/preview', asyncRoute((req, res) => {
  const rows = candidaturesFiltered(req.query);
  res.json({
    total: rows.length,
    sample: rows.slice(0, 6).map((c) => ({
      entreprise: c.entreprise, poste: c.poste, statut: c.statut,
      date_candidature: c.date_candidature, domaine: c.domaine, plateforme: c.plateforme,
    })),
  });
}));

// =========================================================================
//  API : EXTRACTION DEPUIS UNE OFFRE D'EMPLOI (lien ou texte)
// =========================================================================

const OFFER_KEYS = [
  'entreprise', 'poste', 'lieu', 'salaire', 'type_contrat',
  'recruteur_nom', 'recruteur_email',
];

function cleanVal(s) {
  if (s == null) return '';
  s = String(s).trim();
  if (/^(null|n\/?a|undefined|none|-)$/i.test(s)) return '';
  return s;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (m, n) => { try { return String.fromCodePoint(+n); } catch { return m; } })
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return m; } });
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<\/(p|div|li|br|h[1-6]|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

function metaContent(html, ...keys) {
  for (const k of keys) {
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${esc}["'][^>]*>`, 'i');
    const m = html.match(re);
    if (m) {
      const c = m[0].match(/content=["']([^"']*)["']/i);
      if (c && c[1]) return decodeEntities(c[1]).trim();
    }
  }
  return '';
}

// Extrait les blocs JSON-LD (schema.org) de la page.
function extractJsonLd(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try { out.push(JSON.parse(m[1].trim())); } catch { /* ignore JSON invalide */ }
  }
  return out;
}

function findJobPosting(nodes) {
  const stack = [...nodes];
  while (stack.length) {
    const n = stack.shift();
    if (!n || typeof n !== 'object') continue;
    if (Array.isArray(n)) { stack.push(...n); continue; }
    const t = n['@type'];
    if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) return n;
    if (n['@graph']) stack.push(n['@graph']);
  }
  return null;
}

function formatLocation(jobLocation) {
  let loc = jobLocation;
  if (Array.isArray(loc)) loc = loc[0];
  if (!loc) return '';
  const a = loc.address || loc;
  if (typeof a === 'string') return cleanVal(a);
  return [a.addressLocality, a.addressRegion].map(cleanVal).filter(Boolean).join(', ');
}

function formatSalary(baseSalary) {
  if (!baseSalary || typeof baseSalary !== 'object') return '';
  const cur = baseSalary.currency || '';
  const v = baseSalary.value;
  if (!v) return '';
  const unit = { HOUR: '/h', DAY: '/j', WEEK: '/sem', MONTH: '/mois', YEAR: '/an' }[v.unitText] || '';
  if (v.value) return `${v.value} ${cur}${unit}`.trim();
  if (v.minValue || v.maxValue) {
    const range = v.minValue && v.maxValue ? `${v.minValue} - ${v.maxValue}` : (v.minValue || v.maxValue);
    return `${range} ${cur}${unit}`.trim();
  }
  return '';
}

function mapContrat(et) {
  if (Array.isArray(et)) et = et[0];
  if (!et) return '';
  const m = {
    FULL_TIME: 'CDI', CONTRACTOR: 'Freelance', TEMPORARY: 'Intérim',
    INTERN: 'Stage', PART_TIME: 'CDD',
  };
  return m[String(et).toUpperCase()] || '';
}

function mapJobPosting(j) {
  const org = j.hiringOrganization;
  return {
    poste: cleanVal(j.title),
    entreprise: cleanVal(org && (typeof org === 'string' ? org : org.name)),
    lieu: formatLocation(j.jobLocation) || (j.jobLocationType === 'TELECOMMUTE' ? 'Télétravail' : ''),
    salaire: formatSalary(j.baseSalary),
    type_contrat: mapContrat(j.employmentType),
  };
}

// Détecte une IP privée / loopback / link-local (anti-SSRF).
function isPrivateIP(ip) {
  const v = (ip || '').toLowerCase();
  if (v.includes(':')) {
    // IPv6
    return v === '::1' || v.startsWith('fe80') || v.startsWith('fc') ||
      v.startsWith('fd') || v.startsWith('::ffff:127.') || v === '::';
  }
  const p = v.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true; // suspect -> bloque
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// Vérifie qu'une URL est sûre à récupérer (http/https + IP publique).
async function urlIsSafeToFetch(u) {
  let url;
  try { url = new URL(u); } catch { return false; }
  if (!/^https?:$/.test(url.protocol)) return false;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host.toLowerCase() === 'localhost') return false;
  try {
    const addrs = await dns.lookup(host, { all: true });
    if (!addrs.length) return false;
    return addrs.every((a) => !isPrivateIP(a.address));
  } catch {
    return false;
  }
}

async function fetchPage(url) {
  if (!(await urlIsSafeToFetch(url))) return null;
  try {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), 12000);
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; GestionCandidatures/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(to);
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || '';
    if (ct && !/(text\/html|xml|text\/plain)/i.test(ct)) return null;
    return await r.text();
  } catch {
    return null;
  }
}

const OFFER_SCHEMA = {
  type: 'object',
  properties: {
    entreprise: { type: 'string' },
    poste: { type: 'string' },
    lieu: { type: 'string' },
    salaire: { type: 'string' },
    type_contrat: { type: 'string' },
    recruteur_nom: { type: 'string' },
    recruteur_email: { type: 'string' },
  },
  required: OFFER_KEYS,
  additionalProperties: false,
};

// Extraction par IA (Claude) — uniquement si une clé API est configurée.
async function extractWithAI(text, url) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  let mod;
  try { mod = require('@anthropic-ai/sdk'); } catch { return null; }
  const Anthropic = mod.default || mod;
  const client = new Anthropic();
  const model = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
  const resp = await client.messages.create({
    model,
    max_tokens: 1024,
    system:
      "Tu extrais les informations clés d'une offre d'emploi. " +
      "Renvoie une chaîne vide pour tout champ absent. " +
      "Pour type_contrat, utilise exactement l'une de ces valeurs si applicable : " +
      'CDI, CDD, Stage, Alternance, Freelance, Intérim (sinon chaîne vide).',
    output_config: { format: { type: 'json_schema', schema: OFFER_SCHEMA } },
    messages: [{
      role: 'user',
      content: `Voici une offre d'emploi${url ? ` (URL : ${url})` : ''} :\n\n${text.slice(0, 6000)}`,
    }],
  });
  const block = resp.content.find((b) => b.type === 'text');
  if (!block) return null;
  try { return JSON.parse(block.text); } catch { return null; }
}

app.post('/api/extract-offer', async (req, res) => {
  const aiAvailable = !!process.env.ANTHROPIC_API_KEY;
  try {
    const { url, text } = req.body || {};
    if (url && !/^https?:\/\//i.test(url)) {
      return res.json({ error: 'Lien invalide (doit commencer par http:// ou https://).', fields: {}, aiAvailable });
    }
    if (!url && !text) {
      return res.json({ error: 'Fournis un lien ou le texte de l\'offre.', fields: {}, aiAvailable });
    }

    let fields = {};
    let source = null;
    let pageText = cleanVal(text);

    if (url) {
      const html = await fetchPage(url);
      if (html) {
        const ld = findJobPosting(extractJsonLd(html));
        if (ld) { fields = mapJobPosting(ld); source = 'jsonld'; }
        if (!fields.poste) fields.poste = cleanVal(metaContent(html, 'og:title', 'twitter:title'));
        if (!fields.entreprise) fields.entreprise = cleanVal(metaContent(html, 'og:site_name'));
        if (!source && (fields.poste || fields.entreprise)) source = 'meta';
        pageText = htmlToText(html);
      } else {
        return res.json({
          error: "Impossible de récupérer la page (site protégé, connexion requise ou hors ligne). Colle plutôt le texte de l'offre.",
          fields: {}, aiAvailable,
        });
      }
    }

    // Repli IA si l'extraction structurée est insuffisante et qu'une clé existe.
    const enough = fields.entreprise && fields.poste;
    if (!enough && aiAvailable && pageText && pageText.length > 40) {
      const ai = await extractWithAI(pageText, url);
      if (ai) {
        for (const k of OFFER_KEYS) {
          if (!cleanVal(fields[k]) && cleanVal(ai[k])) fields[k] = cleanVal(ai[k]);
        }
        source = source || 'ai';
        if (cleanVal(ai.entreprise) || cleanVal(ai.poste)) source = 'ai';
      }
    }

    // Nettoyage final.
    const out = {};
    for (const k of OFFER_KEYS) if (cleanVal(fields[k])) out[k] = cleanVal(fields[k]);
    if (url) out.lien_offre = url;

    res.json({ source, fields: out, aiAvailable });
  } catch (err) {
    console.error('extract-offer:', err);
    res.json({ error: "Erreur lors de l'extraction : " + (err.message || 'inconnue'), fields: {}, aiAvailable });
  }
});

// =========================================================================
//  API : NOTIFICATIONS (ntfy)
// =========================================================================

// Envoie une notification via ntfy. Renvoie true si OK.
async function sendNtfy(title, message, { priority, tags } = {}) {
  const topic = (getSetting('ntfy_topic', '') || '').trim();
  if (!topic) return false;
  const server = (getSetting('ntfy_server', 'https://ntfy.sh') || 'https://ntfy.sh').replace(/\/+$/, '');
  const headers = { 'Content-Type': 'text/plain; charset=utf-8' };
  if (title) headers['Title'] = encodeURIComponent(title).replace(/%20/g, ' ');
  if (priority) headers['Priority'] = String(priority);
  if (tags) headers['Tags'] = tags;
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), 10000);
  try {
    const r = await fetch(`${server}/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers,
      body: message,
      signal: controller.signal,
    });
    return r.ok;
  } catch (err) {
    console.error('ntfy:', err.message);
    return false;
  } finally {
    clearTimeout(to);
  }
}

// Vérifie les relances et envoie une notification ntfy (au plus une par jour).
async function checkAndNotify(force = false) {
  const topic = (getSetting('ntfy_topic', '') || '').trim();
  if (!topic) return;
  const delai = parseInt(getSetting('relance_delai_jours', '7'), 10);
  const agg = relanceAgg();
  const rows = db.prepare('SELECT * FROM candidatures').all();
  const reminders = rows
    .map((c) => ({ ...c, relance: computeRelance(c, delai, (agg.get(c.id) || {}).last) }))
    .filter((c) => c.relance.aRelancer);
  if (!reminders.length) return;

  const today = todayISO();
  if (!force && getSetting('ntfy_last_sent', '') === today) return;

  const n = reminders.length;
  const liste = reminders
    .slice(0, 5)
    .map((c) => `• ${c.entreprise} — ${c.poste}`)
    .join('\n');
  const extra = n > 5 ? `\n…et ${n - 5} autre(s)` : '';
  const ok = await sendNtfy(
    `${n} candidature${n > 1 ? 's' : ''} à relancer`,
    `${liste}${extra}`,
    { priority: 'default', tags: 'bell' }
  );
  if (ok) {
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run('ntfy_last_sent', today);
  }
}

// Endpoint de test : envoie une notification immédiate.
app.post(
  '/api/notify-test',
  asyncRoute(async (req, res) => {
    const topic = (getSetting('ntfy_topic', '') || '').trim();
    if (!topic) {
      return res.json({ ok: false, error: "Aucun sujet ntfy configuré. Enregistre un sujet d'abord." });
    }
    const ok = await sendNtfy(
      'Test — Gestion des candidatures',
      'Si tu lis ceci sur ton téléphone, les notifications fonctionnent ! 🎉',
      { priority: 'default', tags: 'tada' }
    );
    res.json(ok ? { ok: true } : { ok: false, error: "Échec de l'envoi (vérifie le sujet et ta connexion)." });
  })
);

// Déclenche manuellement la vérification des relances (utilisé au chargement).
app.post(
  '/api/notify-check',
  asyncRoute(async (req, res) => {
    await checkAndNotify(false);
    res.json({ ok: true });
  })
);

// --- Gestion d'erreurs multer --------------------------------------------

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `Erreur d'upload : ${err.message}` });
  }
  // Erreurs de parsing du corps (JSON malformé, corps trop volumineux) : 4xx client.
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON invalide.' });
  }
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({ error: 'Fichier trop volumineux (2 Mo max).' });
  }
  const status = err && (err.status || err.statusCode);
  if (status && status >= 400 && status < 500) {
    return res.status(status).json({ error: err.message || 'Requête invalide.' });
  }
  // Erreur serveur : on logge côté serveur, on ne renvoie aucun détail interne.
  console.error(err);
  res.status(500).json({ error: 'Erreur serveur' });
});

// --- Démarrage ------------------------------------------------------------

// Par défaut, n'écoute que sur localhost (pas d'exposition réseau).
// Surchargeable via GC_HOST (ex: 0.0.0.0) si tu veux y accéder depuis le réseau.
const HOST = process.env.GC_HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`\n  ✅ Gestion des candidatures lancée !`);
  console.log(`  👉 Ouvre ton navigateur : http://localhost:${PORT}\n`);

  // Vérifie les relances au démarrage (après un court délai), puis toutes les 6 h.
  // La notification ntfy n'est envoyée qu'une fois par jour maximum.
  setTimeout(() => { checkAndNotify(false).catch(() => {}); }, 4000);
  setInterval(() => { checkAndNotify(false).catch(() => {}); }, 6 * 60 * 60 * 1000);
});
