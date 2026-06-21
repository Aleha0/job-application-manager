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
  'Sans réponse': 'c-sansreponse',
};

const STATUT_CLASS = {
  'À postuler': 's-apostuler',
  'Envoyée': 's-envoyee',
  'Relancée': 's-relancee',
  'Entretien': 's-entretien',
  'Acceptée': 's-acceptee',
  'Refusée': 's-refusee',
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
  document.addEventListener('keydown', escClose);
  return overlay;
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

function getFilteredCandidatures() {
  const q = ($('#searchCandidatures')?.value || '').toLowerCase().trim();
  const statut = State.filterStatut;
  return State.candidatures.filter((c) => {
    if (statut && c.statut !== statut) return false;
    if (q) {
      const hay = `${c.entreprise} ${c.poste} ${c.lieu || ''} ${c.recruteur_nom || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderCandidatures() {
  renderStatutChips();

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
      return `
        <tr data-open-candidature="${c.id}" style="cursor:pointer">
          <td>
            <div class="cell-strong">${esc(c.entreprise)}</div>
            <div class="cell-sub">${esc(c.poste)} ${lien}</div>
          </td>
          <td>${statutBadge(c.statut)}</td>
          ${compact ? '' : `<td>${esc(c.lieu || '—')} ${contrat}</td>`}
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
/*  Modale : Candidature (créer / éditer)                              */
/* ===================================================================== */
function candidatureModal(c = null) {
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

  const statutOptions = State.statuts
    .map((s) => `<option value="${esc(s)}" ${c.statut === s ? 'selected' : ''}>${esc(s)}</option>`)
    .join('');
  const contrats = ['', 'CDI', 'CDD', 'Stage', 'Alternance', 'Freelance', 'Intérim'];
  const contratOptions = contrats
    .map((t) => `<option value="${esc(t)}" ${c.type_contrat === t ? 'selected' : ''}>${t || '—'}</option>`)
    .join('');

  openModal(`
    <div class="modal-head">
      <h2>${isEdit ? 'Modifier la candidature' : 'Nouvelle candidature'}</h2>
      <button class="btn-icon" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">
      <form id="candidatureForm">
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
            <label>Statut</label>
            <select class="input" name="statut">${statutOptions}</select>
          </div>
          <div class="field">
            <label>Lieu / Ville</label>
            <input class="input" name="lieu" value="${esc(c.lieu)}" />
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
            <label>Type de contrat</label>
            <select class="input" name="type_contrat">${contratOptions}</select>
          </div>
          <div class="field">
            <label>Salaire proposé</label>
            <input class="input" name="salaire" value="${esc(c.salaire)}" placeholder="ex: 38 000 €" />
          </div>
          <div class="field">
            <label>Nom du recruteur</label>
            <input class="input" name="recruteur_nom" value="${esc(c.recruteur_nom)}" />
          </div>
          <div class="field">
            <label>Email du recruteur</label>
            <input class="input" type="email" name="recruteur_email" value="${esc(c.recruteur_email)}" />
          </div>
          <div class="field full">
            <label>Lien vers l'offre</label>
            <div class="inline" style="gap:8px; flex-wrap:nowrap">
              <input class="input" type="url" name="lien_offre" id="lienOffreInput" value="${esc(c.lien_offre)}" placeholder="https://..." style="flex:1" />
              <button type="button" class="btn btn-secondary" id="btnFillFromUrl" title="Remplir les champs depuis l'offre">✨ Remplir</button>
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
        <span>${FOLDER_TYPE[d.type]?.ico || '📄'} ${esc(d.original_name)} <span class="cell-sub">${fmtSize(d.size)}</span></span>
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
          <input class="input" type="file" name="file" required />
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
            <label>Dossier</label>
            <select class="input" name="folder_id">${folderOptions}</select>
          </div>
          <div class="field full">
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
/*  Vue : Paramètres                                                    */
/* ===================================================================== */
function renderSettings() {
  $('#setRelanceDelai').value = State.settings.relance_delai_jours || '7';
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
  try {
    await api('/api/settings', { method: 'PUT', body: { relance_delai_jours: delai } });
    State.settings.relance_delai_jours = delai;
    toast('Paramètres enregistrés');
    await afterChange();
  } catch (err) {
    toast(err.message, 'err');
  }
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

  const t = e.target.closest('[data-view],[data-action],[data-open-candidature],[data-del-candidature],[data-folder],[data-del-folder],[data-edit-doc],[data-del-doc],[data-open-note],[data-del-note],[data-link-note],[data-link-upload],[data-relance-edit]');
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
});

// Recherche & filtres
document.addEventListener('input', (e) => {
  if (e.target.id === 'searchCandidatures') renderCandidatures();
});

/* ===================================================================== */
/*  Démarrage                                                            */
/* ===================================================================== */
(async function init() {
  try {
    await loadAll();
    await renderFlash();
    switchView('dashboard');
  } catch (err) {
    document.body.innerHTML = `<div style="padding:40px;font-family:sans-serif">
      <h1>Erreur de chargement</h1><p>${esc(err.message)}</p>
      <p>Vérifie que le serveur est bien démarré (<code>npm start</code>).</p></div>`;
  }
})();
