'use strict';

/* ===================================================================== */
/*  Helpers API                                                          */
/* ===================================================================== */
async function api(url, options = {}) {
  const opts = { ...options };
  if (opts.body && !(opts.body instanceof FormData)) {
    opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = 'Erreur';
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

/* ===================================================================== */
/*  État global                                                          */
/* ===================================================================== */
const State = {
  statuts: [],
  candidatures: [],
  folders: [],
  settings: {},
  currentFolder: 'all',     // 'all' | 'none' | folderId
  filterStatut: '',         // '' = tous, sinon un statut
  filterTag: '',            // '' = toutes, sinon une étiquette
  aiAvailable: false,       // IA d'extraction activée (clé API présente)
  view: 'dashboard',
};

// Classe CSS courte pour les pastilles de filtre (sans accents/espaces).
const STATUT_CHIP_CLASS = {
  'À postuler': 'c-apostuler',
  'Envoyée': 'c-envoyee',
  'Relancée': 'c-relancee',
  'Entretien': 'c-entretien',
  'Acceptée': 'c-acceptee',
  'Refusée': 'c-refusee',
  'En réserve': 'c-reserve',
  'Sans réponse': 'c-sansreponse',
};

const STATUT_CLASS = {
  'À postuler': 's-apostuler',
  'Envoyée': 's-envoyee',
  'Relancée': 's-relancee',
  'Entretien': 's-entretien',
  'Acceptée': 's-acceptee',
  'Refusée': 's-refusee',
  'En réserve': 's-reserve',
  'Sans réponse': 's-sansreponse',
};

const FOLDER_TYPE = {
  cv: { ico: '📄', label: 'CV' },
  lettre: { ico: '✉️', label: 'Lettre' },
  autre: { ico: '📁', label: 'Autre' },
};

/* ===================================================================== */
/*  Utilitaires UI                                                       */
/* ===================================================================== */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date((iso.length === 10 ? iso + 'T00:00:00' : iso));
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' o';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' Ko';
  return (bytes / (1024 * 1024)).toFixed(1) + ' Mo';
}

function statutBadge(statut) {
  const cls = STATUT_CLASS[statut] || 's-apostuler';
  return `<span class="badge ${cls}">${esc(statut)}</span>`;
}

// --- Étiquettes (tags) ---

// Palette de couleurs prédéfinies (proposées à la sélection).
const TAG_PALETTE = [
  { hue: 231, label: 'Indigo' },
  { hue: 199, label: 'Bleu' },
  { hue: 160, label: 'Émeraude' },
  { hue: 142, label: 'Vert' },
  { hue: 35, label: 'Ambre' },
  { hue: 18, label: 'Orange' },
  { hue: 330, label: 'Rose' },
  { hue: 270, label: 'Violet' },
];
const TAG_HUES = TAG_PALETTE.map((p) => p.hue);

// Teinte de repli (déterministe) si une étiquette n'a pas de couleur définie.
function tagHue(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 9973;
  return TAG_HUES[Math.abs(h) % TAG_HUES.length];
}

// Définitions d'étiquettes [{name, hue}] — gère aussi l'ancien format (chaînes).
function getTagDefs() {
  let raw;
  try { raw = JSON.parse(State.settings.tags || '[]'); } catch { raw = []; }
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t) =>
      typeof t === 'string'
        ? { name: t, hue: tagHue(t) }
        : { name: String(t.name || ''), hue: Number.isFinite(t.hue) ? t.hue : tagHue(String(t.name || '')) }
    )
    .filter((d) => d.name);
}

function getPredefinedTags() {
  return getTagDefs().map((d) => d.name);
}

// Liste des plateformes de candidature (modifiable dans les Paramètres).
function getPlateformes() {
  try {
    const a = JSON.parse(State.settings.plateformes || '[]');
    return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function tagHueByName(name) {
  const d = getTagDefs().find((x) => x.name === name);
  return d ? d.hue : tagHue(name);
}

function tagChip(name) {
  return `<span class="tagchip" style="--th:${tagHueByName(name)}">${esc(name)}</span>`;
}

// Date du jour (locale) au format YYYY-MM-DD, pour les champs <input type="date">.
function todayLocalISO() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

// Ajoute un nombre de jours à une date ISO (YYYY-MM-DD) et renvoie une date ISO.
function addDaysISO(iso, days) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + days);
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

// Convertit un timestamp (ex: File.lastModified) en date locale YYYY-MM-DD.
function tsToLocalISO(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return '';
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

// Nombre de mois écoulés depuis une date ISO.
function monthsSince(iso) {
  if (!iso) return 0;
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return 0;
  return (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
}

function toast(msg, type = 'ok') {
  const zone = $('#toastZone');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  zone.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity 0.3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

/* ===================================================================== */
/*  Modales                                                              */
/* ===================================================================== */
function openModal(html, { large = false } = {}) {
  closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal ${large ? 'modal-lg' : ''}">${html}</div>`;
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) closeModal();
  });
  $('#modalRoot').appendChild(overlay);
  enhanceSelects(overlay);
  document.addEventListener('keydown', escClose);
  return overlay;
}

const CHEVRON_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>';

// Remplace chaque <select class="input"> par un menu déroulant stylé,
// tout en conservant le <select> (caché) pour la valeur du formulaire.
function enhanceSelects(root) {
  root.querySelectorAll('select.input').forEach((sel) => {
    if (sel.dataset.enhanced) return;
    sel.dataset.enhanced = '1';
    sel.style.display = 'none';

    const opts = [...sel.options];
    const textOf = (v) => {
      const o = opts.find((x) => x.value === v);
      const t = o ? o.textContent.trim() : '';
      return t || '—';
    };

    const wrap = document.createElement('div');
    wrap.className = 'cselect';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'cselect-trigger';
    const label = document.createElement('span');
    label.className = 'cselect-label';
    label.textContent = textOf(sel.value);
    const arrow = document.createElement('span');
    arrow.className = 'cselect-arrow';
    arrow.innerHTML = CHEVRON_SVG;
    trigger.append(label, arrow);

    const panel = document.createElement('div');
    panel.className = 'cselect-panel';
    opts.forEach((o) => {
      const item = document.createElement('div');
      item.className = 'cselect-option' + (o.value === sel.value ? ' selected' : '');
      item.textContent = o.textContent.trim() || '—';
      item.dataset.value = o.value;
      item.addEventListener('click', () => {
        sel.value = o.value;
        label.textContent = textOf(o.value);
        panel.querySelectorAll('.cselect-option').forEach((x) =>
          x.classList.toggle('selected', x.dataset.value === o.value)
        );
        wrap.classList.remove('open');
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      });
      panel.appendChild(item);
    });

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.cselect.open').forEach((x) => {
        if (x !== wrap) x.classList.remove('open');
      });
      wrap.classList.toggle('open');
    });

    wrap.append(trigger, panel);
    sel.parentNode.insertBefore(wrap, sel.nextSibling);
  });
}
function closeModal() {
  $('#modalRoot').innerHTML = '';
  document.removeEventListener('keydown', escClose);
}
function escClose(e) { if (e.key === 'Escape') closeModal(); }
window.closeModal = closeModal;

/* ===================================================================== */
/*  Navigation                                                           */
/* ===================================================================== */
function switchView(view) {
  State.view = view;
  $$('.view').forEach((v) => v.classList.add('hidden'));
  $(`#view-${view}`)?.classList.remove('hidden');
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'documents') renderDocuments();
  if (view === 'candidatures') renderCandidatures();
  if (view === 'dashboard') renderDashboard();
  if (view === 'settings') renderSettings();
  if (view === 'cvtheques') renderCvtheques();
  if (view === 'stats') renderStats();
}

/* ===================================================================== */
/*  Chargement initial                                                   */
/* ===================================================================== */
async function loadAll() {
  const [meta, candidatures, folders, settings] = await Promise.all([
    api('/api/meta'),
    api('/api/candidatures'),
    api('/api/folders'),
    api('/api/settings'),
  ]);
  State.statuts = meta.statuts;
  State.aiAvailable = !!meta.aiAvailable;
  State.candidatures = candidatures;
  State.folders = folders;
  State.settings = settings;
}

async function refreshCandidatures() {
  State.candidatures = await api('/api/candidatures');
}
async function refreshFolders() {
  State.folders = await api('/api/folders');
}

/* ===================================================================== */
/*  Alertes flash (relances)                                            */
/* ===================================================================== */
async function renderFlash() {
  const zone = $('#flashZone');
  let data;
  try {
    data = await api('/api/reminders');
  } catch {
    zone.innerHTML = '';
    return;
  }
  const { reminders } = data;
  if (!reminders.length) {
    zone.innerHTML = '';
    return;
  }
  const items = reminders
    .map((c) => {
      const retard = c.relance.joursRetard;
      const txt =
        retard === 0
          ? `à relancer aujourd'hui`
          : `en retard de <span class="rel-late">${retard} j</span>`;
      return `
        <li>
          <span>📌 <strong>${esc(c.entreprise)}</strong> — ${esc(c.poste)} (${txt})</span>
          <button class="mini-link" data-relance-edit="${c.id}">Gérer</button>
        </li>`;
    })
    .join('');
  zone.innerHTML = `
    <div class="flash">
      <span class="flash-ico">🔔</span>
      <div class="flash-body">
        <div class="flash-title">
          ${reminders.length} candidature${reminders.length > 1 ? 's' : ''} à relancer
        </div>
        <span class="muted">Pense à donner suite, ou passe-les en « Sans réponse » si tu n'y donnes pas suite.</span>
        <ul class="flash-list">${items}</ul>
      </div>
      <button class="flash-close" title="Masquer" onclick="this.closest('.flash').remove()">✕</button>
    </div>`;
}

/* ===================================================================== */
/*  Vue : Tableau de bord                                               */
/* ===================================================================== */
async function renderDashboard() {
  const stats = await api('/api/stats');
  const grid = $('#statGrid');
  const cards = [
    { label: 'Total', value: stats.total, accent: true },
    { label: 'Envoyées', value: stats['Envoyée'] + stats['Relancée'] },
    { label: 'Entretiens', value: stats['Entretien'] },
    { label: 'Acceptées', value: stats['Acceptée'] },
    { label: 'Refusées', value: stats['Refusée'] },
  ];
  grid.innerHTML = cards
    .map(
      (c) => `
      <div class="stat ${c.accent ? 'accent' : ''}">
        <div class="stat-value">${c.value}</div>
        <div class="stat-label">${c.label}</div>
      </div>`
    )
    .join('');

  $('#sidebarStats').textContent = `${stats.total} candidature${stats.total > 1 ? 's' : ''}`;

  const recent = State.candidatures.slice(0, 6);
  $('#dashboardTable').innerHTML = recent.length
    ? candidaturesTableHTML(recent, true)
    : emptyState('📋', 'Aucune candidature', 'Clique sur « Nouvelle candidature » pour commencer.');
}

/* ===================================================================== */
/*  Vue : Statistiques                                                  */
/* ===================================================================== */
const STATUT_COLORVAR = {
  'À postuler': '--gray',
  'Envoyée': '--blue',
  'Relancée': '--purple',
  'Entretien': '--amber',
  'Acceptée': '--green',
  'Refusée': '--red',
  'En réserve': '--teal',
  'Sans réponse': '--gray',
};

const MOIS_COURTS = ['jan', 'fév', 'mar', 'avr', 'mai', 'juin', 'juil', 'aoû', 'sep', 'oct', 'nov', 'déc'];
function moisLabel(ym) {
  const m = parseInt((ym || '').slice(5, 7), 10);
  return MOIS_COURTS[m - 1] || '';
}

// Barre horizontale (label + barre colorée + valeur).
function hbar(label, value, max, colorVar) {
  const w = max > 0 ? Math.round((value / max) * 100) : 0;
  return `
    <div class="hbar-row">
      <div class="hbar-lbl">${esc(label)}</div>
      <div class="hbar-track"><div class="hbar-fill" style="width:${w}%;background:var(${colorVar})"></div></div>
      <div class="hbar-val">${value}</div>
    </div>`;
}

async function renderStats() {
  const box = $('#statsContent');
  if (!box) return;
  box.innerHTML = '<span class="muted">Chargement…</span>';
  let d;
  try {
    d = await api('/api/stats/charts');
  } catch (err) {
    box.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    return;
  }
  if (!d.total) {
    box.innerHTML = emptyState('📈', 'Pas encore de données', 'Ajoute des candidatures pour voir tes statistiques.');
    return;
  }

  // Chiffres clés
  const dr = d.delaiReponse || { jours: null, nb: 0 };
  const cards = [
    { label: 'Candidatures', value: d.total, accent: true },
    { label: 'Envoyées', value: d.funnel.envoyees },
    { label: 'Entretiens', value: d.funnel.entretiens },
    { label: 'Taux de réponse', value: d.taux.reponse + ' %' },
    { label: "Taux d'entretien", value: d.taux.entretien + ' %' },
    { label: 'Délai moyen de réponse', value: dr.jours === null ? '—' : dr.jours + ' j' },
  ];
  const cardsHtml = cards
    .map((c) => `<div class="stat ${c.accent ? 'accent' : ''}"><div class="stat-value">${c.value}</div><div class="stat-label">${c.label}</div></div>`)
    .join('');

  // Candidatures par mois (barres verticales)
  const maxMois = Math.max(1, ...d.mois.map((m) => m.count));
  const moisHtml = d.mois
    .map((m) => {
      const h = Math.round((m.count / maxMois) * 100);
      return `
        <div class="vbar-col" title="${m.mois} : ${m.count}">
          <div class="vbar-wrap"><div class="vbar" style="height:${h}%"></div></div>
          <div class="vbar-val">${m.count || ''}</div>
          <div class="vbar-lbl">${moisLabel(m.mois)}</div>
        </div>`;
    })
    .join('');

  // Répartition par statut (barres horizontales colorées)
  const statutEntries = State.statuts.map((s) => [s, d.parStatut[s] || 0]).filter(([, n]) => n > 0);
  const maxStatut = Math.max(1, ...statutEntries.map(([, n]) => n));
  const statutHtml = statutEntries.length
    ? statutEntries.map(([s, n]) => hbar(s, n, maxStatut, STATUT_COLORVAR[s] || '--gray')).join('')
    : '<span class="muted">—</span>';

  // Entonnoir de conversion
  const f = d.funnel;
  const funnelMax = Math.max(1, f.envoyees);
  const funnelHtml =
    hbar('Envoyées', f.envoyees, funnelMax, '--blue') +
    hbar('Entretiens', f.entretiens, funnelMax, '--amber') +
    hbar('Acceptées', f.acceptees, funnelMax, '--green');

  // Par plateforme
  const maxPlat = Math.max(1, ...d.parPlateforme.map((p) => p.count));
  const platHtml = d.parPlateforme.length
    ? d.parPlateforme.map((p) => hbar(p.nom, p.count, maxPlat, '--primary')).join('')
    : '<span class="muted">Aucune plateforme renseignée sur tes candidatures.</span>';

  // Taux d'entretien par plateforme (largeur = taux %)
  const tauxPlatHtml = (d.parPlateformeTaux || []).length
    ? d.parPlateformeTaux
        .map(
          (p) => `
        <div class="hbar-row" title="${p.entretiens}/${p.total} entretiens">
          <div class="hbar-lbl">${esc(p.nom)}</div>
          <div class="hbar-track"><div class="hbar-fill" style="width:${p.taux}%;background:var(--amber)"></div></div>
          <div class="hbar-val">${p.taux}%</div>
        </div>`
        )
        .join('')
    : '<span class="muted">Aucune plateforme renseignée.</span>';

  // Taux d'entretien par CV envoyé
  const cvTauxHtml = (d.parCvTaux || []).length
    ? d.parCvTaux
        .map(
          (cv) => `
        <div class="hbar-row" title="${cv.entretiens}/${cv.total} entretiens">
          <div class="hbar-lbl">${esc(cv.nom)}</div>
          <div class="hbar-track"><div class="hbar-fill" style="width:${cv.taux}%;background:var(--green)"></div></div>
          <div class="hbar-val">${cv.taux}%</div>
        </div>`
        )
        .join('')
    : '<span class="muted">Renseigne le « CV envoyé » sur tes candidatures pour voir lequel fonctionne le mieux.</span>';

  // Par lieu
  const maxLieu = Math.max(1, ...(d.parLieu || []).map((l) => l.count));
  const lieuHtml = (d.parLieu || []).length
    ? d.parLieu.map((l) => hbar(l.nom, l.count, maxLieu, '--blue')).join('')
    : '<span class="muted">Aucun lieu renseigné.</span>';

  // Actives vs clôturées
  const act = d.activite || { actives: 0, cloturees: 0 };
  const actHtml =
    hbar('Actives', act.actives, d.total, '--blue') +
    hbar('Clôturées', act.cloturees, d.total, '--gray');

  // Objectif hebdomadaire
  const ry = d.rythme || { semaine: 0, mois: 0, objectif: 5 };
  const objPct = ry.objectif > 0 ? Math.min(100, Math.round((ry.semaine / ry.objectif) * 100)) : 0;
  const objAtteint = ry.semaine >= ry.objectif;
  const objHtml = `
    <div class="obj-line">
      <span class="obj-big">${ry.semaine}<span class="obj-sep">/ ${ry.objectif}</span></span>
      <span class="muted">candidatures cette semaine</span>
    </div>
    <div class="obj-track"><div class="obj-fill ${objAtteint ? 'done' : ''}" style="width:${objPct}%"></div></div>
    <p class="muted" style="margin-top:9px">
      ${objAtteint ? '🎉 Objectif atteint, bravo !' : `Plus que ${ry.objectif - ry.semaine} pour atteindre ton objectif.`}
      · <strong>${ry.mois}</strong> ce mois-ci.
    </p>`;

  box.innerHTML = `
    <div class="stat-grid">${cardsHtml}</div>

    <div class="charts-grid">
      <div class="card">
        <div class="card-head"><h2>🎯 Objectif de la semaine</h2></div>
        <div class="card-body">${objHtml}</div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Candidatures par mois</h2></div>
        <div class="card-body"><div class="vbars">${moisHtml}</div></div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Entonnoir de conversion</h2></div>
        <div class="card-body">
          ${funnelHtml}
          <p class="muted" style="margin-top:10px">Taux d'acceptation : ${d.taux.acceptation} % des candidatures envoyées.</p>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Répartition par statut</h2></div>
        <div class="card-body">${statutHtml}</div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Activité</h2></div>
        <div class="card-body">
          ${actHtml}
          <p class="muted" style="margin-top:10px">Actives = en cours · Clôturées = acceptée / refusée / sans réponse.</p>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Par plateforme</h2></div>
        <div class="card-body">${platHtml}</div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Taux d'entretien par plateforme</h2></div>
        <div class="card-body">${tauxPlatHtml}</div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Quel CV marche le mieux</h2></div>
        <div class="card-body">${cvTauxHtml}</div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Par lieu</h2></div>
        <div class="card-body">${lieuHtml}</div>
      </div>
    </div>`;
}

/* ===================================================================== */
/*  Vue : Candidatures                                                  */
/* ===================================================================== */
// Construit les pastilles de filtre par statut, avec le nombre par statut.
function renderStatutChips() {
  const box = $('#statutChips');
  if (!box) return;
  // Compte des candidatures par statut.
  const counts = {};
  for (const c of State.candidatures) counts[c.statut] = (counts[c.statut] || 0) + 1;

  const chip = (value, label, cssClass, count) => {
    const active = State.filterStatut === value;
    const dot = value ? `<span class="chip-dot"></span>` : '';
    return `
      <button class="chip ${cssClass} ${active ? 'active' : ''}" data-statut-chip="${esc(value)}">
        ${dot}${esc(label)}
        <span class="chip-count">${count}</span>
      </button>`;
  };

  let html = chip('', 'Toutes', 'c-all', State.candidatures.length);
  html += State.statuts
    .map((s) => chip(s, s, STATUT_CHIP_CLASS[s] || '', counts[s] || 0))
    .join('');
  box.innerHTML = html;
}

// Rend les pastilles de filtre par étiquette.
function renderTagChips() {
  const box = $('#tagChips');
  const group = $('#tagFilterGroup');
  const tags = getPredefinedTags();
  if (group) group.classList.toggle('hidden', tags.length === 0);
  if (!box) return;
  let html = `<button class="tagfilter tagfilter-all ${State.filterTag === '' ? 'active' : ''}" data-tag-chip="">Toutes</button>`;
  html += tags
    .map((t) => {
      const active = State.filterTag === t;
      return `<button class="tagfilter ${active ? 'active' : ''}" data-tag-chip="${esc(t)}" style="--th:${tagHueByName(t)}">${esc(t)}</button>`;
    })
    .join('');
  box.innerHTML = html;
}

function getFilteredCandidatures() {
  const q = ($('#searchCandidatures')?.value || '').toLowerCase().trim();
  const statut = State.filterStatut;
  const tag = State.filterTag;
  return State.candidatures.filter((c) => {
    if (statut && c.statut !== statut) return false;
    if (tag && !(Array.isArray(c.tags) && c.tags.includes(tag))) return false;
    if (q) {
      const hay = `${c.entreprise} ${c.poste} ${c.lieu || ''} ${c.recruteur_nom || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderCandidatures() {
  renderStatutChips();
  renderTagChips();

  // Bouton "effacer" de la recherche.
  const q = $('#searchCandidatures')?.value || '';
  $('#searchClear')?.classList.toggle('hidden', q.length === 0);

  const list = getFilteredCandidatures();

  // Compteur de résultats.
  const total = State.candidatures.length;
  const countEl = $('#resultCount');
  if (countEl) {
    if (!total) {
      countEl.textContent = '';
    } else if (list.length === total) {
      countEl.textContent = `${total} candidature${total > 1 ? 's' : ''}`;
    } else {
      countEl.textContent = `${list.length} résultat${list.length > 1 ? 's' : ''} sur ${total}`;
    }
  }

  $('#candidaturesTable').innerHTML = list.length
    ? candidaturesTableHTML(list, false)
    : emptyState('🔍', 'Aucun résultat', 'Aucune candidature ne correspond à ta recherche ou à ce filtre.');
}

function candidaturesTableHTML(list, compact) {
  const rows = list
    .map((c) => {
      const relance = c.relance && c.relance.aRelancer
        ? `<span class="tag" style="background:var(--amber-soft);color:var(--amber)">⏰ relance</span>`
        : (c.relance && c.relance.dueDate
            ? `<span class="cell-sub">${fmtDate(c.relance.dueDate)}</span>`
            : '—');
      const contrat = c.type_contrat ? `<span class="tag">${esc(c.type_contrat)}</span>` : '';
      const lien = c.lien_offre
        ? `<a class="link-ext" href="${esc(c.lien_offre)}" target="_blank" rel="noopener">offre ↗</a>`
        : '';
      const tags = (!compact && Array.isArray(c.tags) && c.tags.length)
        ? `<div class="tag-row">${c.tags.map((t) => tagChip(t)).join('')}</div>`
        : '';
      return `
        <tr data-open-candidature="${c.id}" style="cursor:pointer">
          <td>
            <div class="cell-strong">${esc(c.entreprise)}</div>
            <div class="cell-sub">${esc(c.poste)} ${lien}</div>
            ${tags}
          </td>
          <td>${statutBadge(c.statut)}</td>
          ${compact ? '' : `<td>${esc(c.lieu || '—')} ${contrat}${c.plateforme ? `<div class="cell-sub">📨 ${esc(c.plateforme)}</div>` : ''}</td>`}
          <td>${fmtDate(c.date_candidature)}</td>
          <td>${relance}</td>
          <td>
            <div class="row-actions" onclick="event.stopPropagation()">
              <button class="btn-icon" title="Modifier" data-open-candidature="${c.id}">✏️</button>
              <button class="btn-icon" title="Supprimer" data-del-candidature="${c.id}">🗑️</button>
            </div>
          </td>
        </tr>`;
    })
    .join('');
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Entreprise / Poste</th>
            <th>Statut</th>
            ${compact ? '' : '<th>Lieu / Contrat</th>'}
            <th>Candidature</th>
            <th>Relance</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function emptyState(ico, title, sub) {
  return `<div class="empty"><span class="empty-ico">${ico}</span>
    <div style="font-weight:600;color:var(--text-soft)">${esc(title)}</div>
    <div class="muted">${esc(sub)}</div></div>`;
}

/* ===================================================================== */
/*  Recherche globale                                                   */
/* ===================================================================== */
let lastSearchData = { candidatures: [], documents: [], notes: [] };

function openSearch() {
  openModal(`
    <div class="search-box-head">
      <span class="search-box-ico">🔍</span>
      <input id="globalSearchInput" type="search" autocomplete="off"
        placeholder="Rechercher une candidature, un document, une note, une étiquette…" />
      <button class="btn-icon" onclick="closeModal()">✕</button>
    </div>
    <div id="searchResults" class="search-results">
      <div class="search-hint">Tape au moins 2 caractères pour rechercher…</div>
    </div>
  `, { large: true });

  const input = $('#globalSearchInput');
  input?.focus();
  let timer;
  input?.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => runSearch(input.value), 180);
  });
  $('#searchResults')?.addEventListener('click', (e) => {
    const it = e.target.closest('[data-result-type]');
    if (!it) return;
    const type = it.dataset.resultType;
    const id = Number(it.dataset.resultId);
    if (type === 'candidature') {
      const c = lastSearchData.candidatures.find((x) => x.id === id);
      closeModal();
      if (c) candidatureModal(c);
    } else if (type === 'note') {
      closeModal();
      noteModal(id);
    } else if (type === 'document') {
      window.open(`/api/documents/${id}/view`, '_blank');
    }
  });
}

async function runSearch(q) {
  const box = $('#searchResults');
  if (!box) return;
  if (!q || q.trim().length < 2) {
    box.innerHTML = '<div class="search-hint">Tape au moins 2 caractères pour rechercher…</div>';
    return;
  }
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q.trim())}`);
    lastSearchData = data;
    renderSearchResults(data);
  } catch (err) {
    box.innerHTML = `<div class="search-empty">${esc(err.message)}</div>`;
  }
}

function renderSearchResults(data) {
  const box = $('#searchResults');
  if (!box) return;
  const { candidatures, documents, notes } = data;
  const total = candidatures.length + documents.length + notes.length;
  if (!total) {
    box.innerHTML = '<div class="search-empty">Aucun résultat.</div>';
    return;
  }

  let html = '';

  if (candidatures.length) {
    html += `<div class="search-section-title">Candidatures (${candidatures.length})</div>`;
    html += candidatures
      .map(
        (c) => `
        <div class="search-item" data-result-type="candidature" data-result-id="${c.id}">
          <span class="search-item-ico">🎯</span>
          <div class="search-item-body">
            <div class="search-item-title">${esc(c.entreprise)}</div>
            <div class="search-item-sub">${esc(c.poste)}${c.lieu ? ' · ' + esc(c.lieu) : ''}</div>
          </div>
          ${statutBadge(c.statut)}
        </div>`
      )
      .join('');
  }

  if (documents.length) {
    html += `<div class="search-section-title">Documents (${documents.length})</div>`;
    html += documents
      .map((d) => {
        const sub = [d.folder_nom, d.candidature_entreprise].filter(Boolean).map(esc).join(' · ');
        return `
        <div class="search-item" data-result-type="document" data-result-id="${d.id}">
          <span class="search-item-ico">${FOLDER_TYPE[d.type]?.ico || '📄'}</span>
          <div class="search-item-body">
            <div class="search-item-title">${esc(d.original_name)}</div>
            <div class="search-item-sub">${sub || (FOLDER_TYPE[d.type]?.label || 'Fichier')}</div>
          </div>
        </div>`;
      })
      .join('');
  }

  if (notes.length) {
    html += `<div class="search-section-title">Notes (${notes.length})</div>`;
    html += notes
      .map((n) => {
        const preview = (n.contenu || '').slice(0, 60);
        return `
        <div class="search-item" data-result-type="note" data-result-id="${n.id}">
          <span class="search-item-ico">📝</span>
          <div class="search-item-body">
            <div class="search-item-title">${esc(n.titre)}</div>
            <div class="search-item-sub">${esc(preview)}${preview.length >= 60 ? '…' : ''}</div>
          </div>
        </div>`;
      })
      .join('');
  }

  box.innerHTML = html;
}

/* ===================================================================== */
/*  Modale : Candidature (créer / éditer)                              */
/* ===================================================================== */
async function candidatureModal(c = null) {
  const isEdit = !!c;
  c = c || {};

  // Valeurs par défaut des dates pour une NOUVELLE candidature :
  //  - date de candidature  -> aujourd'hui
  //  - date de relance      -> aujourd'hui + délai configuré (7 j par défaut)
  // En modification, on conserve les dates existantes.
  const delai = parseInt(State.settings.relance_delai_jours || '7', 10);
  const today = todayLocalISO();
  const valDateCand = isEdit ? (c.date_candidature || '').slice(0, 10) : today;
  const valDateRelance = isEdit ? (c.date_relance || '').slice(0, 10) : addDaysISO(today, delai);

  const predefTags = getPredefinedTags();
  const selectedTags = Array.isArray(c.tags) ? c.tags : [];

  const statutOptions = State.statuts
    .map((s) => `<option value="${esc(s)}" ${c.statut === s ? 'selected' : ''}>${esc(s)}</option>`)
    .join('');
  const contrats = ['', 'CDI', 'CDD', 'Stage', 'Alternance', 'Freelance', 'Intérim'];
  const contratOptions = contrats
    .map((t) => `<option value="${esc(t)}" ${c.type_contrat === t ? 'selected' : ''}>${t || '—'}</option>`)
    .join('');
  const plateformeOptions =
    `<option value="">—</option>` +
    getPlateformes()
      .map((p) => `<option value="${esc(p)}" ${c.plateforme === p ? 'selected' : ''}>${esc(p)}</option>`)
      .join('');

  // Liste des documents (CV en premier) pour le champ « CV envoyé ».
  let docsForCv = [];
  try { docsForCv = await api('/api/documents'); } catch { docsForCv = []; }
  docsForCv.sort((a, b) => (a.type === 'cv' ? -1 : 1) - (b.type === 'cv' ? -1 : 1));
  const cvEnvoyeOptions =
    `<option value="">—</option>` +
    docsForCv
      .map((dd) => `<option value="${dd.id}" ${c.cv_document_id == dd.id ? 'selected' : ''}>${esc(dd.original_name)}${dd.type === 'cv' ? ' (CV)' : ''}</option>`)
      .join('');

  openModal(`
    <div class="modal-head">
      <h2>${isEdit ? 'Modifier la candidature' : 'Nouvelle candidature'}</h2>
      <button class="btn-icon" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">
      <form id="candidatureForm">
        <!-- Remplissage automatique depuis l'offre -->
        <div class="offer-fill">
          <div class="offer-fill-head">✨ Remplir depuis l'offre</div>
          <div class="inline" style="gap:8px; flex-wrap:nowrap">
            <input class="input" type="url" name="lien_offre" id="lienOffreInput" value="${esc(c.lien_offre)}" placeholder="https://… lien de l'offre" style="flex:1" />
            <button type="button" class="btn btn-primary" id="btnFillFromUrl" title="Remplir les champs depuis l'offre">✨ Remplir</button>
          </div>
          <span class="hint">Colle le lien puis clique sur « Remplir », ou
            <a href="#" id="lnkPasteText">colle le texte de l'offre</a>.</span>
          <div id="pasteTextBlock" class="hidden" style="margin-top:10px">
            <textarea class="input" id="offerTextArea" rows="6"
              placeholder="Colle ici le texte complet de l'offre d'emploi..."></textarea>
            <div class="inline" style="margin-top:8px">
              <button type="button" class="btn btn-secondary btn-sm" id="btnFillFromText">Extraire depuis le texte</button>
            </div>
          </div>
        </div>

        <!-- Le poste -->
        <div class="form-section">
          <div class="form-section-title" style="--accent: var(--blue)">🏢 Le poste</div>
          <div class="form-grid">
            <div class="field">
              <label>Entreprise *</label>
              <input class="input" name="entreprise" required value="${esc(c.entreprise)}" />
            </div>
            <div class="field">
              <label>Poste *</label>
              <input class="input" name="poste" required value="${esc(c.poste)}" />
            </div>
            <div class="field">
              <label>Lieu / Ville</label>
              <input class="input" name="lieu" value="${esc(c.lieu)}" />
            </div>
            <div class="field">
              <label>Type de contrat</label>
              <select class="input" name="type_contrat">${contratOptions}</select>
            </div>
            <div class="field">
              <label>Salaire proposé</label>
              <input class="input" name="salaire" value="${esc(c.salaire)}" placeholder="ex: 38 000 €" />
            </div>
          </div>
        </div>

        <!-- Suivi de la candidature -->
        <div class="form-section">
          <div class="form-section-title" style="--accent: var(--teal)">📋 Suivi de la candidature</div>
          <div class="form-grid">
            <div class="field">
              <label>Statut</label>
              <select class="input" name="statut">${statutOptions}</select>
            </div>
            <div class="field">
              <label>Plateforme de candidature</label>
              <select class="input" name="plateforme">${plateformeOptions}</select>
            </div>
            <div class="field">
              <label>Date de candidature</label>
              <input class="input" type="date" name="date_candidature" value="${esc(valDateCand)}" />
            </div>
            <div class="field">
              <label>Date de relance <span class="hint">(pré-remplie, modifiable)</span></label>
              <input class="input" type="date" name="date_relance" value="${esc(valDateRelance)}" />
            </div>
            <div class="field">
              <label>Date de réponse <span class="hint">(quand l'employeur répond)</span></label>
              <input class="input" type="date" name="date_reponse" value="${esc((c.date_reponse || '').slice(0, 10))}" />
            </div>
            <div class="field">
              <label>CV envoyé</label>
              <select class="input" name="cv_document_id">${cvEnvoyeOptions}</select>
            </div>
            <div class="field full">
              <label>Étiquettes</label>
              ${predefTags.length
                ? `<div class="tag-pick">${predefTags.map((t) => {
                    const on = selectedTags.includes(t);
                    return `<label class="tag-pick-item" style="--th:${tagHueByName(t)}"><input type="checkbox" name="tag" value="${esc(t)}" ${on ? 'checked' : ''} hidden />${esc(t)}</label>`;
                  }).join('')}</div>`
                : `<span class="hint">Aucune étiquette définie. Crée-en dans <a href="#" data-go-settings>Paramètres → Étiquettes</a>.</span>`}
            </div>
          </div>
        </div>

        <!-- Contact recruteur -->
        <div class="form-section">
          <div class="form-section-title" style="--accent: var(--purple)">👤 Contact recruteur</div>
          <div class="form-grid">
            <div class="field">
              <label>Nom du recruteur</label>
              <input class="input" name="recruteur_nom" value="${esc(c.recruteur_nom)}" />
            </div>
            <div class="field">
              <label>Email du recruteur</label>
              <input class="input" type="email" name="recruteur_email" value="${esc(c.recruteur_email)}" />
            </div>
          </div>
        </div>
      </form>

      ${isEdit ? linkedItemsHTML(c.id) : ''}
    </div>
    <div class="modal-foot">
      ${isEdit ? `<button class="btn btn-danger" data-del-candidature="${c.id}" style="margin-right:auto">Supprimer</button>` : ''}
      <button class="btn btn-secondary" onclick="closeModal()">Annuler</button>
      <button class="btn btn-primary" id="saveCandidature">${isEdit ? 'Enregistrer' : 'Créer'}</button>
    </div>
  `, { large: true });

  if (isEdit) loadLinkedItems(c.id);

  $('#saveCandidature').addEventListener('click', async () => {
    const form = $('#candidatureForm');
    if (!form.reportValidity()) return;
    const data = Object.fromEntries(new FormData(form).entries());
    data.tags = [...form.querySelectorAll('input[name="tag"]:checked')].map((i) => i.value);
    try {
      if (isEdit) {
        await api(`/api/candidatures/${c.id}`, { method: 'PUT', body: data });
        toast('Candidature mise à jour');
      } else {
        await api('/api/candidatures', { method: 'POST', body: data });
        toast('Candidature créée');
      }
      closeModal();
      await afterChange();
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  // Remplissage automatique depuis l'offre.
  $('#btnFillFromUrl')?.addEventListener('click', (e) => {
    fillFromOffer({ url: ($('#lienOffreInput')?.value || '').trim() }, e.currentTarget);
  });
  $('#lnkPasteText')?.addEventListener('click', (e) => {
    e.preventDefault();
    $('#pasteTextBlock')?.classList.toggle('hidden');
    $('#offerTextArea')?.focus();
  });
  $('#btnFillFromText')?.addEventListener('click', (e) => {
    fillFromOffer({ text: ($('#offerTextArea')?.value || '').trim() }, e.currentTarget);
  });
}

/* --- Remplissage automatique depuis une offre d'emploi ------------- */
async function fillFromOffer(payload, btn) {
  if (payload.url && !/^https?:\/\//i.test(payload.url)) {
    toast('Entre un lien valide (https://...)', 'err');
    return;
  }
  if (!payload.url && !payload.text) {
    toast("Colle un lien ou le texte de l'offre", 'err');
    return;
  }
  const oldLabel = btn ? btn.textContent : null;
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Analyse…'; }
  try {
    const res = await api('/api/extract-offer', { method: 'POST', body: payload });
    if (res.error) toast(res.error, 'err');
    const filled = applyOfferFields(res.fields || {});
    if (filled.length) {
      toast(`Champs remplis : ${filled.join(', ')}${res.source === 'ai' ? ' (via IA)' : ''}`);
      $('#pasteTextBlock')?.classList.add('hidden');
    } else if (!res.error) {
      toast(
        res.aiAvailable
          ? "Aucune info exploitable trouvée. Essaie de coller le texte de l'offre."
          : "Rien trouvé automatiquement. Colle le texte de l'offre, ou active l'IA (voir Paramètres).",
        'err'
      );
    }
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = oldLabel; }
  }
}

// Remplit les champs vides du formulaire avec les valeurs extraites.
function applyOfferFields(f) {
  const form = $('#candidatureForm');
  if (!form) return [];
  const labels = {
    entreprise: 'Entreprise', poste: 'Poste', lieu: 'Lieu', salaire: 'Salaire',
    type_contrat: 'Contrat', recruteur_nom: 'Recruteur', recruteur_email: 'Email',
    lien_offre: 'Lien',
  };
  const filled = [];
  for (const [k, label] of Object.entries(labels)) {
    const val = (f[k] || '').trim();
    if (!val) continue;
    const el = form.elements[k];
    if (!el) continue;
    if (el.value && el.value.trim()) continue; // ne pas écraser une saisie existante
    if (el.tagName === 'SELECT') {
      const opt = [...el.options].find((o) => o.value.toLowerCase() === val.toLowerCase());
      if (opt) { el.value = opt.value; filled.push(label); }
    } else {
      el.value = val;
      filled.push(label);
    }
  }
  return filled;
}

/* --- Éléments liés (docs + notes) dans la modale candidature -------- */
function linkedItemsHTML(id) {
  return `
    <hr style="border:none;border-top:1px solid var(--border);margin:22px 0 18px" />
    <div class="inline" style="justify-content:space-between;margin-bottom:12px">
      <h3 style="margin:0">📎 Documents & notes liés</h3>
      <div class="inline">
        <button class="btn btn-sm btn-secondary" data-link-note="${id}">+ Note</button>
        <button class="btn btn-sm btn-secondary" data-link-upload="${id}">⬆ Fichier</button>
      </div>
    </div>
    <div id="linkedItems"><span class="muted">Chargement…</span></div>`;
}

async function loadLinkedItems(id) {
  const box = $('#linkedItems');
  if (!box) return;
  const [docs, notes] = await Promise.all([
    api(`/api/documents?candidature_id=${id}`),
    api(`/api/notes?candidature_id=${id}`),
  ]);
  if (!docs.length && !notes.length) {
    box.innerHTML = `<span class="muted">Aucun document ni note pour le moment.</span>`;
    return;
  }
  const docHtml = docs
    .map(
      (d) => `
      <div class="inline" style="justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">
        <span>${FOLDER_TYPE[d.type]?.ico || '📄'} ${esc(d.original_name)} <span class="cell-sub">${fmtSize(d.size)}${d.file_date ? ' · 🕒 ' + fmtDate(d.file_date) : ''}</span></span>
        <span class="inline">
          <a class="btn-icon" href="/api/documents/${d.id}/view" target="_blank" title="Voir">👁️</a>
          <a class="btn-icon" href="/api/documents/${d.id}/download" title="Télécharger">⬇️</a>
          <button class="btn-icon" data-del-doc="${d.id}" data-reload-candidature="${id}" title="Supprimer">🗑️</button>
        </span>
      </div>`
    )
    .join('');
  const noteHtml = notes
    .map(
      (n) => `
      <div class="inline" style="justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">
        <span>📝 ${esc(n.titre)}</span>
        <span class="inline">
          <button class="btn-icon" data-open-note="${n.id}" title="Ouvrir">✏️</button>
          <button class="btn-icon" data-del-note="${n.id}" data-reload-candidature="${id}" title="Supprimer">🗑️</button>
        </span>
      </div>`
    )
    .join('');
  box.innerHTML = docHtml + noteHtml;
}

/* ===================================================================== */
/*  Vue : Documents                                                     */
/* ===================================================================== */
function renderDocuments() {
  renderFoldersPanel();
  renderDocsContent();
}

function renderFoldersPanel() {
  const panel = $('#foldersList');
  const totalDocs = State.folders.reduce((a, f) => a + f.nb_docs + f.nb_notes, 0);
  let html = `
    <div class="folder-item ${State.currentFolder === 'all' ? 'active' : ''}" data-folder="all">
      <span class="f-ico">🗂️</span><span class="f-name">Tous</span>
      <span class="f-count">${totalDocs}</span>
    </div>
    <div class="folder-item ${State.currentFolder === 'none' ? 'active' : ''}" data-folder="none">
      <span class="f-ico">📌</span><span class="f-name">Sans dossier</span>
    </div>
    <div style="height:1px;background:var(--border);margin:8px 0"></div>`;
  html += State.folders
    .map(
      (f) => `
      <div class="folder-item ${State.currentFolder == f.id ? 'active' : ''}" data-folder="${f.id}">
        <span class="f-ico">${FOLDER_TYPE[f.type]?.ico || '📁'}</span>
        <span class="f-name">${esc(f.nom)}</span>
        <span class="f-count">${f.nb_docs + f.nb_notes}</span>
        <button class="btn-icon f-del" data-del-folder="${f.id}" title="Supprimer le dossier">🗑️</button>
      </div>`
    )
    .join('');
  if (!State.folders.length) {
    html += `<p class="muted" style="padding:8px 11px">Aucun dossier. Crée-en un pour organiser tes fichiers.</p>`;
  }
  panel.innerHTML = html;
}

async function renderDocsContent() {
  const box = $('#docsContent');
  box.innerHTML = '<span class="muted">Chargement…</span>';
  let docQuery = '';
  let noteQuery = '';
  if (State.currentFolder === 'none') {
    docQuery = '?folder_id=null';
    noteQuery = '?folder_id=null';
  } else if (State.currentFolder !== 'all') {
    docQuery = `?folder_id=${State.currentFolder}`;
    noteQuery = `?folder_id=${State.currentFolder}`;
  }
  const [docs, notes] = await Promise.all([
    api('/api/documents' + docQuery),
    api('/api/notes' + noteQuery),
  ]);

  if (!docs.length && !notes.length) {
    box.innerHTML = emptyState('📂', 'Dossier vide', 'Importe un fichier ou crée une note texte.');
    return;
  }

  let html = '';
  if (docs.length) {
    html += `<div class="section-label">📄 Fichiers <span class="count">(${docs.length})</span></div>`;
    html += '<div class="doc-grid">' + docs.map(docCardHTML).join('') + '</div>';
  }
  if (notes.length) {
    html += `<div class="section-label" style="margin-top:22px">📝 Notes <span class="count">(${notes.length})</span></div>`;
    html += '<div class="doc-grid">' + notes.map(noteCardHTML).join('') + '</div>';
  }
  box.innerHTML = html;
}

// Indicateur de date de mise à jour d'un fichier (+ alerte si ancien).
function fileDateBadge(d) {
  if (!d.file_date) return '';
  const old = monthsSince(d.file_date) >= 6;
  const warn = old
    ? ` <span class="tag" style="background:var(--amber-soft);color:var(--amber)">à vérifier</span>`
    : '';
  return `<div class="doc-meta">🕒 Maj : ${fmtDate(d.file_date)}${warn}</div>`;
}

// Indicateur des plateformes (CVthèques) où le document est déposé.
function coverageBadge(d) {
  const list = Array.isArray(d.cvtheques) ? d.cvtheques : [];
  if (list.length) {
    return `<div class="doc-meta" style="color:var(--teal)">🗃️ Sur : ${esc(list.join(', '))}</div>`;
  }
  if (d.type === 'cv') {
    return `<div class="doc-meta" style="color:var(--amber)">🗃️ Sur aucune plateforme</div>`;
  }
  return '';
}

function docCardHTML(d) {
  const ico = FOLDER_TYPE[d.type]?.ico || '📄';
  const link = d.candidature_id
    ? `<div class="doc-meta">🎯 ${esc(d.candidature_entreprise || '')}</div>`
    : '';
  return `
    <div class="doc-card">
      <div class="doc-ico">${ico}</div>
      <div class="doc-name">${esc(d.original_name)}</div>
      <div class="doc-meta">${FOLDER_TYPE[d.type]?.label || 'Fichier'} · ${fmtSize(d.size)}</div>
      ${fileDateBadge(d)}
      ${coverageBadge(d)}
      ${link}
      <div class="doc-actions">
        <a class="btn btn-sm btn-secondary" href="/api/documents/${d.id}/view" target="_blank">👁️ Voir</a>
        <a class="btn btn-sm btn-secondary" href="/api/documents/${d.id}/download">⬇️</a>
        <button class="btn btn-sm btn-secondary" data-edit-doc="${d.id}">✏️</button>
        <button class="btn btn-sm btn-danger" data-del-doc="${d.id}">🗑️</button>
      </div>
    </div>`;
}

function noteCardHTML(n) {
  const preview = (n.contenu || '').slice(0, 80);
  const link = n.candidature_id
    ? `<div class="doc-meta">🎯 ${esc(n.candidature_entreprise || '')}</div>`
    : '';
  return `
    <div class="doc-card">
      <div class="doc-ico">📝</div>
      <div class="doc-name">${esc(n.titre)}</div>
      <div class="doc-meta">${esc(preview)}${preview.length >= 80 ? '…' : ''}</div>
      ${link}
      <div class="doc-actions">
        <button class="btn btn-sm btn-secondary" data-open-note="${n.id}">✏️ Ouvrir</button>
        <button class="btn btn-sm btn-danger" data-del-note="${n.id}">🗑️</button>
      </div>
    </div>`;
}

/* ===================================================================== */
/*  Modale : Dossier                                                    */
/* ===================================================================== */
function folderModal() {
  openModal(`
    <div class="modal-head"><h2>Nouveau dossier</h2>
      <button class="btn-icon" onclick="closeModal()">✕</button></div>
    <div class="modal-body">
      <form id="folderForm">
        <div class="field" style="margin-bottom:16px">
          <label>Nom du dossier *</label>
          <input class="input" name="nom" required placeholder="ex: CV développeur, Lettres 2026..." />
        </div>
        <div class="field">
          <label>Type</label>
          <select class="input" name="type">
            <option value="cv">📄 CV</option>
            <option value="lettre">✉️ Lettres de motivation</option>
            <option value="autre" selected>📁 Autre</option>
          </select>
        </div>
      </form>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" onclick="closeModal()">Annuler</button>
      <button class="btn btn-primary" id="saveFolder">Créer</button>
    </div>
  `);
  $('#saveFolder').addEventListener('click', async () => {
    const form = $('#folderForm');
    if (!form.reportValidity()) return;
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      await api('/api/folders', { method: 'POST', body: data });
      toast('Dossier créé');
      closeModal();
      await refreshFolders();
      renderDocuments();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

/* ===================================================================== */
/*  Modale : Upload de fichier                                          */
/* ===================================================================== */
function uploadModal(candidatureId = null) {
  const folderOptions =
    '<option value="">— Aucun dossier —</option>' +
    State.folders
      .map((f) => `<option value="${f.id}" ${State.currentFolder == f.id ? 'selected' : ''}>${esc(f.nom)}</option>`)
      .join('');
  const candOptions =
    '<option value="">— Aucune —</option>' +
    State.candidatures
      .map((c) => `<option value="${c.id}" ${candidatureId == c.id ? 'selected' : ''}>${esc(c.entreprise)} — ${esc(c.poste)}</option>`)
      .join('');

  openModal(`
    <div class="modal-head"><h2>Importer un fichier</h2>
      <button class="btn-icon" onclick="closeModal()">✕</button></div>
    <div class="modal-body">
      <form id="uploadForm">
        <div class="field" style="margin-bottom:16px">
          <label>Fichier * <span class="hint">(PDF, Word, image… max 25 Mo)</span></label>
          <input class="input" type="file" name="file" id="uploadFile" required />
        </div>
        <div class="form-grid">
          <div class="field">
            <label>Type</label>
            <select class="input" name="type">
              <option value="cv">📄 CV</option>
              <option value="lettre">✉️ Lettre de motivation</option>
              <option value="autre" selected>📁 Autre</option>
            </select>
          </div>
          <div class="field">
            <label>Date du fichier <span class="hint">(mise à jour)</span></label>
            <input class="input" type="date" name="file_date" id="uploadFileDate" />
          </div>
          <div class="field">
            <label>Dossier</label>
            <select class="input" name="folder_id">${folderOptions}</select>
          </div>
          <div class="field">
            <label>Rattacher à une candidature</label>
            <select class="input" name="candidature_id">${candOptions}</select>
          </div>
        </div>
      </form>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" onclick="closeModal()">Annuler</button>
      <button class="btn btn-primary" id="saveUpload">Importer</button>
    </div>
  `);

  // Pré-remplit la date à partir des métadonnées du fichier (date de modif).
  $('#uploadFile')?.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    const di = $('#uploadFileDate');
    if (f && f.lastModified && di) di.value = tsToLocalISO(f.lastModified);
  });

  $('#saveUpload').addEventListener('click', async () => {
    const form = $('#uploadForm');
    if (!form.reportValidity()) return;
    const fd = new FormData(form);
    const btn = $('#saveUpload');
    btn.disabled = true;
    btn.textContent = 'Envoi…';
    try {
      await api('/api/documents', { method: 'POST', body: fd });
      toast('Fichier importé');
      closeModal();
      await refreshFolders();
      if (candidatureId) {
        loadLinkedItems(candidatureId);
      } else if (State.view === 'documents') {
        renderDocuments();
      }
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
      btn.textContent = 'Importer';
    }
  });
}

/* --- Modale : éditer un document (renommer / déplacer) -------------- */
async function editDocModal(id) {
  const docs = await api('/api/documents');
  const d = docs.find((x) => x.id === id);
  if (!d) return;
  const folderOptions =
    '<option value="">— Aucun dossier —</option>' +
    State.folders.map((f) => `<option value="${f.id}" ${d.folder_id == f.id ? 'selected' : ''}>${esc(f.nom)}</option>`).join('');
  const candOptions =
    '<option value="">— Aucune —</option>' +
    State.candidatures.map((c) => `<option value="${c.id}" ${d.candidature_id == c.id ? 'selected' : ''}>${esc(c.entreprise)} — ${esc(c.poste)}</option>`).join('');
  openModal(`
    <div class="modal-head"><h2>Modifier le document</h2>
      <button class="btn-icon" onclick="closeModal()">✕</button></div>
    <div class="modal-body">
      <form id="editDocForm">
        <div class="field full" style="margin-bottom:16px">
          <label>Nom affiché</label>
          <input class="input" name="original_name" value="${esc(d.original_name)}" />
        </div>
        <div class="form-grid">
          <div class="field">
            <label>Type</label>
            <select class="input" name="type">
              <option value="cv" ${d.type === 'cv' ? 'selected' : ''}>📄 CV</option>
              <option value="lettre" ${d.type === 'lettre' ? 'selected' : ''}>✉️ Lettre</option>
              <option value="autre" ${d.type === 'autre' ? 'selected' : ''}>📁 Autre</option>
            </select>
          </div>
          <div class="field">
            <label>Date du fichier <span class="hint">(mise à jour)</span></label>
            <input class="input" type="date" name="file_date" value="${esc((d.file_date || '').slice(0, 10))}" />
          </div>
          <div class="field">
            <label>Dossier</label>
            <select class="input" name="folder_id">${folderOptions}</select>
          </div>
          <div class="field full">
            <label>Candidature liée</label>
            <select class="input" name="candidature_id">${candOptions}</select>
          </div>
        </div>
      </form>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" onclick="closeModal()">Annuler</button>
      <button class="btn btn-primary" id="saveEditDoc">Enregistrer</button>
    </div>
  `);
  $('#saveEditDoc').addEventListener('click', async () => {
    const data = Object.fromEntries(new FormData($('#editDocForm')).entries());
    try {
      await api(`/api/documents/${id}`, { method: 'PUT', body: data });
      toast('Document mis à jour');
      closeModal();
      await refreshFolders();
      renderDocuments();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

/* ===================================================================== */
/*  Modale : Note texte                                                 */
/* ===================================================================== */
async function noteModal(id = null, candidatureId = null) {
  let n = { titre: '', contenu: '', folder_id: '', candidature_id: candidatureId || '' };
  if (id) {
    const notes = await api('/api/notes');
    n = notes.find((x) => x.id === id) || n;
  }
  const folderOptions =
    '<option value="">— Aucun dossier —</option>' +
    State.folders.map((f) => `<option value="${f.id}" ${n.folder_id == f.id ? 'selected' : ''}>${esc(f.nom)}</option>`).join('');
  const candOptions =
    '<option value="">— Aucune —</option>' +
    State.candidatures.map((c) => `<option value="${c.id}" ${n.candidature_id == c.id ? 'selected' : ''}>${esc(c.entreprise)} — ${esc(c.poste)}</option>`).join('');

  openModal(`
    <div class="modal-head"><h2>${id ? 'Modifier la note' : 'Nouvelle note texte'}</h2>
      <button class="btn-icon" onclick="closeModal()">✕</button></div>
    <div class="modal-body">
      <form id="noteForm">
        <div class="field" style="margin-bottom:14px">
          <label>Titre</label>
          <input class="input" name="titre" value="${esc(n.titre)}" placeholder="ex: Points à préparer pour l'entretien" />
        </div>
        <div class="field" style="margin-bottom:14px">
          <label>Contenu</label>
          <textarea class="input" name="contenu" rows="10" placeholder="Écris ici tes informations sur la candidature...">${esc(n.contenu)}</textarea>
        </div>
        <div class="form-grid">
          <div class="field">
            <label>Dossier</label>
            <select class="input" name="folder_id">${folderOptions}</select>
          </div>
          <div class="field">
            <label>Candidature liée</label>
            <select class="input" name="candidature_id">${candOptions}</select>
          </div>
        </div>
      </form>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" onclick="closeModal()">Annuler</button>
      <button class="btn btn-primary" id="saveNote">${id ? 'Enregistrer' : 'Créer'}</button>
    </div>
  `, { large: true });

  $('#saveNote').addEventListener('click', async () => {
    const data = Object.fromEntries(new FormData($('#noteForm')).entries());
    try {
      if (id) {
        await api(`/api/notes/${id}`, { method: 'PUT', body: data });
        toast('Note enregistrée');
      } else {
        await api('/api/notes', { method: 'POST', body: data });
        toast('Note créée');
      }
      closeModal();
      await refreshFolders();
      if (candidatureId) loadLinkedItems(candidatureId);
      else if (State.view === 'documents') renderDocuments();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

/* ===================================================================== */
/*  Vue : Mes CVthèques                                                 */
/* ===================================================================== */
async function renderCvtheques() {
  const box = $('#cvthequesList');
  if (!box) return;
  box.innerHTML = '<span class="muted">Chargement…</span>';
  let list;
  try {
    list = await api('/api/cvtheques');
  } catch (err) {
    box.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    return;
  }
  if (!list.length) {
    box.innerHTML = emptyState('🗃️', 'Aucune plateforme', 'Ajoute les sites où ton CV est déposé.');
    return;
  }
  box.innerHTML = '<div class="doc-grid">' + list.map(cvthequeCardHTML).join('') + '</div>';
}

function cvthequeCardHTML(cv) {
  const host = (() => {
    try { return cv.url ? new URL(cv.url).hostname.replace(/^www\./, '') : ''; } catch { return ''; }
  })();
  const maj = cv.derniere_maj
    ? `🕒 Maj : ${fmtDate(cv.derniere_maj)}`
    : '<span style="color:var(--amber)">Jamais mise à jour</span>';
  const flag = cv.aMettreAJour
    ? `<div class="cvth-flag" title="${esc(cv.raison)}">⚠️ À mettre à jour <span class="cvth-flag-why">${esc(cv.raison)}</span></div>`
    : `<div class="cvth-ok">✅ À jour</div>`;
  const cvNames = (cv.cvs || []).map((c) => c.original_name);
  const cvLink = cvNames.length
    ? `<div class="doc-meta">📄 CV : ${esc(cvNames.join(', '))}</div>`
    : '<div class="doc-meta" style="color:var(--muted)">Aucun CV lié</div>';
  const open = cv.url
    ? `<a class="btn btn-sm btn-secondary" href="${esc(cv.url)}" target="_blank" rel="noopener">↗ Ouvrir</a>`
    : '';
  const notes = cv.notes ? `<div class="doc-meta">📝 ${esc(cv.notes)}</div>` : '';
  return `
    <div class="doc-card cvth-card ${cv.aMettreAJour ? 'cvth-todo' : ''}">
      <div class="cvth-head">
        <span class="doc-ico">🗃️</span>
        <div style="flex:1;min-width:0">
          <div class="doc-name">${esc(cv.nom)}</div>
          ${host ? `<div class="doc-meta">${esc(host)}</div>` : ''}
        </div>
      </div>
      <div class="doc-meta">${maj}</div>
      ${cvLink}
      ${notes}
      ${flag}
      <div class="doc-actions">
        ${open}
        <button class="btn btn-sm btn-secondary" data-cvtheque-maj="${cv.id}" title="Marquer comme mis à jour aujourd'hui">✓ Mis à jour</button>
        <button class="btn btn-sm btn-secondary" data-open-cvtheque="${cv.id}">✏️</button>
        <button class="btn btn-sm btn-danger" data-del-cvtheque="${cv.id}">🗑️</button>
      </div>
    </div>`;
}

let cvthequesCache = [];
async function cvthequeModal(id = null) {
  let cv = { nom: '', url: '', derniere_maj: '', cv_document_id: '', notes: '' };
  if (id) {
    cvthequesCache = await api('/api/cvtheques');
    cv = cvthequesCache.find((x) => x.id === id) || cv;
  }
  // Documents (CV en priorité) pour le champ « CV(s) lié(s) ».
  const docs = await api('/api/documents');
  docs.sort((a, b) => (a.type === 'cv' ? -1 : 1) - (b.type === 'cv' ? -1 : 1));
  const linkedIds = (cv.cvs || []).map((c) => c.id);
  const docPicker = docs.length
    ? `<div class="pick-list">${docs.map((d) => {
        const on = linkedIds.includes(d.id);
        return `<label class="pick-item"><input type="checkbox" name="cv_doc" value="${d.id}" ${on ? 'checked' : ''} hidden />${d.type === 'cv' ? '📄 ' : '📎 '}${esc(d.original_name)}</label>`;
      }).join('')}</div>`
    : `<span class="hint">Aucun document importé. Ajoute tes CV dans l'onglet Documents.</span>`;

  openModal(`
    <div class="modal-head"><h2>${id ? 'Modifier la plateforme' : 'Nouvelle plateforme'}</h2>
      <button class="btn-icon" onclick="closeModal()">✕</button></div>
    <div class="modal-body">
      <form id="cvthequeForm">
        <div class="form-grid">
          <div class="field">
            <label>Nom *</label>
            <input class="input" name="nom" required value="${esc(cv.nom)}" placeholder="ex: Indeed, LinkedIn…" />
          </div>
          <div class="field">
            <label>Lien du site</label>
            <input class="input" type="url" name="url" value="${esc(cv.url)}" placeholder="https://..." />
          </div>
          <div class="field">
            <label>Dernière mise à jour</label>
            <input class="input" type="date" name="derniere_maj" value="${esc((cv.derniere_maj || '').slice(0, 10))}" />
          </div>
          <div class="field full">
            <label>CV déposé(s) <span class="hint">(un ou plusieurs)</span></label>
            ${docPicker}
          </div>
          <div class="field full">
            <label>Notes</label>
            <textarea class="input" name="notes" rows="2" placeholder="identifiants, remarques…">${esc(cv.notes)}</textarea>
          </div>
        </div>
      </form>
    </div>
    <div class="modal-foot">
      ${id ? `<button class="btn btn-danger" data-del-cvtheque="${id}" style="margin-right:auto">Supprimer</button>` : ''}
      <button class="btn btn-secondary" onclick="closeModal()">Annuler</button>
      <button class="btn btn-primary" id="saveCvtheque">${id ? 'Enregistrer' : 'Ajouter'}</button>
    </div>
  `);

  $('#saveCvtheque').addEventListener('click', async () => {
    const form = $('#cvthequeForm');
    if (!form.reportValidity()) return;
    const data = Object.fromEntries(new FormData(form).entries());
    data.cv_document_ids = [...form.querySelectorAll('input[name="cv_doc"]:checked')].map((i) => Number(i.value));
    try {
      if (id) {
        await api(`/api/cvtheques/${id}`, { method: 'PUT', body: data });
        toast('Plateforme mise à jour');
      } else {
        await api('/api/cvtheques', { method: 'POST', body: data });
        toast('Plateforme ajoutée');
      }
      closeModal();
      renderCvtheques();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

/* ===================================================================== */
/*  Vue : Paramètres                                                    */
/* ===================================================================== */
function renderSettings() {
  $('#setRelanceDelai').value = State.settings.relance_delai_jours || '7';
  const cvDelai = $('#setCvthequeDelai');
  if (cvDelai) cvDelai.value = State.settings.cvtheque_maj_delai_mois || '3';
  const objHebdo = $('#setObjectifHebdo');
  if (objHebdo) objHebdo.value = State.settings.objectif_hebdo || '5';

  // ntfy
  const topic = State.settings.ntfy_topic || '';
  const topicInput = $('#setNtfyTopic');
  if (topicInput) topicInput.value = topic;
  const hint = $('#ntfyTopicHint');
  if (hint) hint.textContent = topic || '—';

  // Statut des notifications navigateur
  updateBrowserNotifStatus();

  // Gestion des étiquettes
  renderSwatches();
  renderTagsManager();

  // Gestion des plateformes de candidature
  renderPlatManager();

  const badge = $('#aiStatusBadge');
  if (badge) {
    if (State.aiAvailable) {
      badge.textContent = '✅ IA activée';
      badge.style.background = 'var(--green-soft)';
      badge.style.color = 'var(--green)';
    } else {
      badge.textContent = '○ IA désactivée';
      badge.style.background = 'var(--surface-2)';
      badge.style.color = 'var(--muted)';
    }
  }
}

async function saveSettings() {
  const delai = $('#setRelanceDelai').value;
  const ntfyTopic = ($('#setNtfyTopic')?.value || '').trim();
  const cvDelai = $('#setCvthequeDelai')?.value || '3';
  const objHebdo = $('#setObjectifHebdo')?.value || '5';
  try {
    await api('/api/settings', {
      method: 'PUT',
      body: {
        relance_delai_jours: delai,
        ntfy_topic: ntfyTopic,
        cvtheque_maj_delai_mois: cvDelai,
        objectif_hebdo: objHebdo,
      },
    });
    State.settings.relance_delai_jours = delai;
    State.settings.ntfy_topic = ntfyTopic;
    State.settings.cvtheque_maj_delai_mois = cvDelai;
    State.settings.objectif_hebdo = objHebdo;
    const hint = $('#ntfyTopicHint');
    if (hint) hint.textContent = ntfyTopic || '—';
    toast('Paramètres enregistrés');
    await afterChange();
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ===================================================================== */
/*  Thème (clair / sombre)                                              */
/* ===================================================================== */
function applyTheme(theme) {
  if (theme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  const icon = $('#themeToggleIcon');
  const label = $('#themeToggleLabel');
  if (icon) icon.textContent = theme === 'dark' ? '☀️' : '🌙';
  if (label) label.textContent = theme === 'dark' ? 'Mode clair' : 'Mode sombre';
}

function toggleTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const next = isDark ? 'light' : 'dark';
  try { localStorage.setItem('theme', next); } catch {}
  applyTheme(next);
}

/* ===================================================================== */
/*  Notifications (navigateur + ntfy)                                   */
/* ===================================================================== */
function updateBrowserNotifStatus() {
  const el = $('#browserNotifStatus');
  const btn = $('#btnBrowserNotif');
  if (!el) return;
  if (!('Notification' in window)) {
    el.textContent = 'Non supporté par ce navigateur.';
    if (btn) btn.disabled = true;
    return;
  }
  if (Notification.permission === 'granted') {
    el.textContent = '✅ Activées';
    if (btn) btn.textContent = 'Notifications activées';
  } else if (Notification.permission === 'denied') {
    el.textContent = '⛔ Bloquées (à réautoriser dans le navigateur).';
  } else {
    el.textContent = '';
  }
}

async function enableBrowserNotif() {
  if (!('Notification' in window)) return;
  try {
    const perm = await Notification.requestPermission();
    updateBrowserNotifStatus();
    if (perm === 'granted') {
      new Notification('Notifications activées 🎉', {
        body: 'Tu seras prévenu·e des candidatures à relancer.',
      });
      maybeNotifyBrowserReminders();
    }
  } catch {}
}

// Affiche une notif navigateur si des relances sont en attente (1×/jour max).
async function maybeNotifyBrowserReminders() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const today = todayLocalISO();
    if (localStorage.getItem('browserNotifLast') === today) return;
    const data = await api('/api/reminders');
    const n = (data.reminders || []).length;
    if (n > 0) {
      new Notification(`${n} candidature${n > 1 ? 's' : ''} à relancer`, {
        body: data.reminders.slice(0, 4).map((c) => `• ${c.entreprise} — ${c.poste}`).join('\n'),
      });
      localStorage.setItem('browserNotifLast', today);
    }
  } catch {}
}

function randomTopic() {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  const arr = new Uint8Array(10);
  (window.crypto || {}).getRandomValues?.(arr);
  for (let i = 0; i < 10; i++) s += chars[(arr[i] || Math.floor(Math.random() * 256)) % chars.length];
  return 'relances-' + s;
}

async function testNtfy() {
  const topic = ($('#setNtfyTopic')?.value || '').trim();
  if (!topic) { toast("Indique d'abord un sujet ntfy", 'err'); return; }
  // S'assure que le sujet est enregistré avant le test.
  if (topic !== (State.settings.ntfy_topic || '')) await saveSettings();
  const btn = $('#btnNtfyTest');
  const old = btn ? btn.textContent : null;
  if (btn) { btn.disabled = true; btn.textContent = 'Envoi…'; }
  try {
    const res = await api('/api/notify-test', { method: 'POST' });
    if (res.ok) toast('Notification de test envoyée ! Vérifie ton téléphone.');
    else toast(res.error || "Échec de l'envoi", 'err');
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = old; }
  }
}

/* ===================================================================== */
/*  Gestion de la liste d'étiquettes (Paramètres)                       */
/* ===================================================================== */
// Couleur sélectionnée pour la prochaine étiquette ajoutée.
let selectedTagHue = TAG_PALETTE[0].hue;

// Rend la palette de couleurs (sélecteur à l'ajout).
function renderSwatches() {
  const box = $('#tagSwatches');
  if (!box) return;
  box.innerHTML = TAG_PALETTE.map(
    (p) =>
      `<button type="button" class="swatch ${selectedTagHue === p.hue ? 'active' : ''}" data-swatch="${p.hue}" title="${p.label}" style="--th:${p.hue}"></button>`
  ).join('');
}

function renderTagsManager() {
  const box = $('#tagsManager');
  if (!box) return;
  const defs = getTagDefs();
  box.innerHTML = defs.length
    ? defs
        .map(
          (d) =>
            `<span class="tagchip tagchip-edit" style="--th:${d.hue}">` +
            `<button type="button" class="tag-color" data-recolor="${esc(d.name)}" title="Changer la couleur"></button>` +
            `${esc(d.name)}` +
            `<button type="button" class="tag-x" data-del-tag="${esc(d.name)}" title="Supprimer">✕</button>` +
            `</span>`
        )
        .join('')
    : '<span class="muted">Aucune étiquette pour le moment.</span>';
}

async function saveTagsList(defs) {
  await api('/api/settings', { method: 'PUT', body: { tags: JSON.stringify(defs) } });
  State.settings.tags = JSON.stringify(defs);
  renderTagsManager();
  renderTagChips();
}

async function addTagFromInput() {
  const input = $('#newTagInput');
  if (!input) return;
  const name = input.value.trim().replace(/,/g, '');
  if (!name) return;
  const defs = getTagDefs();
  if (defs.some((d) => d.name.toLowerCase() === name.toLowerCase())) {
    toast('Cette étiquette existe déjà', 'err');
    return;
  }
  defs.push({ name, hue: selectedTagHue });
  input.value = '';
  try {
    await saveTagsList(defs);
    toast('Étiquette ajoutée');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function removeTag(name) {
  const defs = getTagDefs().filter((d) => d.name !== name);
  try {
    await saveTagsList(defs);
    if (State.filterTag === name) State.filterTag = '';
    toast('Étiquette supprimée');
  } catch (err) {
    toast(err.message, 'err');
  }
}

// Fait défiler la couleur d'une étiquette existante dans la palette.
async function recolorTag(name) {
  const defs = getTagDefs();
  const d = defs.find((x) => x.name === name);
  if (!d) return;
  const idx = TAG_HUES.indexOf(d.hue);
  d.hue = TAG_HUES[(idx + 1) % TAG_HUES.length];
  try {
    await saveTagsList(defs);
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ===================================================================== */
/*  Gestion des plateformes de candidature (Paramètres)                */
/* ===================================================================== */
function renderPlatManager() {
  const box = $('#platManager');
  if (!box) return;
  const plats = getPlateformes();
  box.innerHTML = plats.length
    ? plats
        .map(
          (p) =>
            `<span class="tagchip" style="--th:212">${esc(p)}<button class="tag-x" data-del-plat="${esc(p)}" title="Supprimer">✕</button></span>`
        )
        .join('')
    : '<span class="muted">Aucune plateforme pour le moment.</span>';
}

async function savePlateformes(plats) {
  await api('/api/settings', { method: 'PUT', body: { plateformes: JSON.stringify(plats) } });
  State.settings.plateformes = JSON.stringify(plats);
  renderPlatManager();
}

async function addPlatFromInput() {
  const input = $('#newPlatInput');
  if (!input) return;
  const name = input.value.trim();
  if (!name) return;
  const plats = getPlateformes();
  if (plats.some((p) => p.toLowerCase() === name.toLowerCase())) {
    toast('Cette plateforme existe déjà', 'err');
    return;
  }
  plats.push(name);
  input.value = '';
  try {
    await savePlateformes(plats);
    toast('Plateforme ajoutée');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function removePlat(name) {
  try {
    await savePlateformes(getPlateformes().filter((p) => p !== name));
    toast('Plateforme supprimée');
  } catch (err) {
    toast(err.message, 'err');
  }
}

// Branche les contrôles statiques (présents dès le chargement).
function setupStaticControls() {
  $('#openSearch')?.addEventListener('click', openSearch);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      openSearch();
    }
  });
  $('#themeToggle')?.addEventListener('click', toggleTheme);
  $('#btnBrowserNotif')?.addEventListener('click', enableBrowserNotif);
  $('#btnNtfyTest')?.addEventListener('click', testNtfy);
  $('#btnNtfyGenerate')?.addEventListener('click', () => {
    const input = $('#setNtfyTopic');
    if (input) input.value = randomTopic();
  });
  $('#btnAddTag')?.addEventListener('click', addTagFromInput);
  $('#newTagInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addTagFromInput(); }
  });
  $('#tagSwatches')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-swatch]');
    if (b) { selectedTagHue = Number(b.dataset.swatch); renderSwatches(); }
  });
  $('#tagsManager')?.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del-tag]');
    if (del) { removeTag(del.dataset.delTag); return; }
    const rec = e.target.closest('[data-recolor]');
    if (rec) recolorTag(rec.dataset.recolor);
  });
  $('#btnAddPlat')?.addEventListener('click', addPlatFromInput);
  $('#newPlatInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addPlatFromInput(); }
  });
  $('#platManager')?.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del-plat]');
    if (del) removePlat(del.dataset.delPlat);
  });
}

/* ===================================================================== */
/*  Rafraîchissement global après modification                          */
/* ===================================================================== */
async function afterChange() {
  await Promise.all([refreshCandidatures(), refreshFolders()]);
  await renderFlash();
  if (State.view === 'dashboard') renderDashboard();
  if (State.view === 'candidatures') renderCandidatures();
  if (State.view === 'documents') renderDocuments();
}

/* ===================================================================== */
/*  Délégation d'événements (clics)                                    */
/* ===================================================================== */
document.addEventListener('click', async (e) => {
  // Ferme les menus déroulants personnalisés ouverts si on clique en dehors.
  if (!e.target.closest('.cselect')) {
    document.querySelectorAll('.cselect.open').forEach((x) => x.classList.remove('open'));
  }

  // Bouton "effacer" de la recherche
  if (e.target.closest('#searchClear')) {
    const input = $('#searchCandidatures');
    if (input) input.value = '';
    renderCandidatures();
    input?.focus();
    return;
  }

  // Pastille de filtre par statut
  const chipBtn = e.target.closest('[data-statut-chip]');
  if (chipBtn) {
    State.filterStatut = chipBtn.dataset.statutChip;
    renderCandidatures();
    return;
  }

  // Pastille de filtre par étiquette
  const tagBtn = e.target.closest('[data-tag-chip]');
  if (tagBtn) {
    State.filterTag = tagBtn.dataset.tagChip;
    renderCandidatures();
    return;
  }

  // Lien "Paramètres → Étiquettes" depuis la modale candidature
  if (e.target.closest('[data-go-settings]')) {
    e.preventDefault();
    closeModal();
    switchView('settings');
    return;
  }

  const t = e.target.closest('[data-view],[data-action],[data-open-candidature],[data-del-candidature],[data-folder],[data-del-folder],[data-edit-doc],[data-del-doc],[data-open-note],[data-del-note],[data-link-note],[data-link-upload],[data-relance-edit],[data-open-cvtheque],[data-del-cvtheque],[data-cvtheque-maj]');
  if (!t) return;

  // Navigation
  if (t.dataset.view) { switchView(t.dataset.view); return; }

  // Actions globales
  if (t.dataset.action) {
    const a = t.dataset.action;
    if (a === 'new-candidature') candidatureModal();
    if (a === 'new-folder') folderModal();
    if (a === 'new-note') noteModal();
    if (a === 'upload-doc') uploadModal();
    if (a === 'new-cvtheque') cvthequeModal();
    if (a === 'save-settings') saveSettings();
    return;
  }

  // Candidatures
  if (t.dataset.openCandidature) {
    const c = State.candidatures.find((x) => x.id === Number(t.dataset.openCandidature));
    if (c) candidatureModal(c);
    return;
  }
  if (t.dataset.delCandidature) {
    const id = Number(t.dataset.delCandidature);
    const c = State.candidatures.find((x) => x.id === id);
    if (confirm(`Supprimer la candidature « ${c ? c.entreprise : ''} » et ses documents/notes liés ?`)) {
      await api(`/api/candidatures/${id}`, { method: 'DELETE' });
      toast('Candidature supprimée');
      closeModal();
      await afterChange();
    }
    return;
  }
  if (t.dataset.relanceEdit) {
    const c = State.candidatures.find((x) => x.id === Number(t.dataset.relanceEdit));
    if (c) candidatureModal(c);
    return;
  }

  // Dossiers
  if (t.dataset.folder) {
    State.currentFolder = t.dataset.folder === 'all' || t.dataset.folder === 'none'
      ? t.dataset.folder
      : Number(t.dataset.folder);
    renderDocuments();
    return;
  }
  if (t.dataset.delFolder) {
    e.stopPropagation();
    const id = Number(t.dataset.delFolder);
    if (confirm('Supprimer ce dossier ? Les fichiers et notes seront conservés (sans dossier).')) {
      await api(`/api/folders/${id}`, { method: 'DELETE' });
      if (State.currentFolder == id) State.currentFolder = 'all';
      toast('Dossier supprimé');
      await refreshFolders();
      renderDocuments();
    }
    return;
  }

  // Documents
  if (t.dataset.editDoc) { editDocModal(Number(t.dataset.editDoc)); return; }
  if (t.dataset.delDoc) {
    const id = Number(t.dataset.delDoc);
    const reload = t.dataset.reloadCandidature;
    if (confirm('Supprimer ce fichier définitivement ?')) {
      await api(`/api/documents/${id}`, { method: 'DELETE' });
      toast('Fichier supprimé');
      await refreshFolders();
      if (reload) loadLinkedItems(Number(reload));
      else renderDocuments();
    }
    return;
  }

  // Notes
  if (t.dataset.openNote) { noteModal(Number(t.dataset.openNote)); return; }
  if (t.dataset.delNote) {
    const id = Number(t.dataset.delNote);
    const reload = t.dataset.reloadCandidature;
    if (confirm('Supprimer cette note ?')) {
      await api(`/api/notes/${id}`, { method: 'DELETE' });
      toast('Note supprimée');
      await refreshFolders();
      if (reload) loadLinkedItems(Number(reload));
      else renderDocuments();
    }
    return;
  }

  // Liens depuis la modale candidature
  if (t.dataset.linkNote) { noteModal(null, Number(t.dataset.linkNote)); return; }
  if (t.dataset.linkUpload) { uploadModal(Number(t.dataset.linkUpload)); return; }

  // CVthèques
  if (t.dataset.openCvtheque) { cvthequeModal(Number(t.dataset.openCvtheque)); return; }
  if (t.dataset.cvthequeMaj) {
    await api(`/api/cvtheques/${Number(t.dataset.cvthequeMaj)}`, {
      method: 'PUT',
      body: { derniere_maj: todayLocalISO() },
    });
    toast('Marquée comme mise à jour aujourd\'hui');
    renderCvtheques();
    return;
  }
  if (t.dataset.delCvtheque) {
    const id = Number(t.dataset.delCvtheque);
    if (confirm('Supprimer cette plateforme de la liste ?')) {
      await api(`/api/cvtheques/${id}`, { method: 'DELETE' });
      toast('Plateforme supprimée');
      closeModal();
      renderCvtheques();
    }
    return;
  }
});

// Recherche & filtres
document.addEventListener('input', (e) => {
  if (e.target.id === 'searchCandidatures') renderCandidatures();
});

/* ===================================================================== */
/*  Démarrage                                                            */
/* ===================================================================== */
(async function init() {
  // Thème (le script du <head> a déjà appliqué la classe ; on synchronise le bouton).
  let savedTheme = 'light';
  try { savedTheme = localStorage.getItem('theme') || 'light'; } catch {}
  applyTheme(savedTheme);
  setupStaticControls();

  try {
    await loadAll();
    await renderFlash();
    switchView('dashboard');
    // Notifications : récap navigateur (si autorisé) + déclenche le check ntfy serveur.
    maybeNotifyBrowserReminders();
    api('/api/notify-check', { method: 'POST' }).catch(() => {});
  } catch (err) {
    document.body.innerHTML = `<div style="padding:40px;font-family:sans-serif">
      <h1>Erreur de chargement</h1><p>${esc(err.message)}</p>
      <p>Vérifie que le serveur est bien démarré (<code>npm start</code>).</p></div>`;
  }
})();
