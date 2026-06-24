# Import & Export — data formats

This document describes the file formats used to **import** applications into the app
and to **export / back up** your data.

> In short: import is **JSON**, exports are **Excel / PDF / CSV / JSON**, and the full
> backup is a **`.zip`** that contains everything.

---

## Importing applications (JSON)

### How to import

1. Open the **Applications** tab or the **Dashboard**.
2. Click **“⬆ Import (JSON)”**.
3. Pick a `.json` file *or* paste the JSON directly.
4. Click **Analyze** to preview: how many will be **created**, **completed**,
   left **unchanged**, and how many entries were **skipped** (with reasons).
5. Click **Confirm**.

Nothing is written until you confirm — the analysis step is a safe dry-run.

### The JSON structure

This is the **canonical structure** to target — if you ask a tool or an assistant to
generate the file, give it this shape. The top level is a **JSON array** of objects
(or an object `{ "candidatures": [ ... ] }`). Each object is one application; only
**`entreprise`** and **`poste`** are required, everything else is optional.

Complete example with **every supported field**:

```json
[
  {
    "entreprise": "Studio Lumière",
    "poste": "Chargé de communication",
    "lieu": "Lyon",
    "statut": "Envoyée",
    "date_candidature": "2026-03-12",
    "date_reponse": "2026-03-20",
    "recruteur_nom": "Jordan Doe",
    "recruteur_email": "rh@studio-lumiere.example",
    "lien_offre": "https://studio-lumiere.example/offres/42",
    "salaire": "32 000 €",
    "type_contrat": "CDI",
    "domaine": "Communication",
    "plateforme": "Site de l'entreprise",
    "tags": ["Spontanée", "Priorité haute"],
    "notes": [
      { "label": "Accusé réception", "value": "Candidature reçue le 12/03" }
    ],
    "relances": [
      { "date": "2026-03-19", "canal": "mail", "note": "Relancé, en attente de retour" }
    ],
    "cv_conserve": true,
    "cv_conserve_mois": 24
  }
]
```

### Fields

| Field | Type | Notes |
|---|---|---|
| `entreprise` * | string | **required** |
| `poste` * | string | **required** |
| `lieu` | string | city / location |
| `statut` | string | one of: `À postuler`, `Envoyée`, `Relancée`, `Entretien`, `Acceptée`, `Refusée`, `En réserve`, `Sans réponse` (default: `À postuler`) |
| `date_candidature` | string | ISO date `YYYY-MM-DD` |
| `date_reponse` | string | ISO date — employer's reply |
| `recruteur_nom` | string | recruiter name |
| `recruteur_email` | string | recruiter email |
| `lien_offre` | string (URL) | **http(s) only** (anything else is dropped) |
| `salaire` | string | free text |
| `type_contrat` | string | e.g. `CDI`, `CDD`, `Stage`, `Alternance`, `Freelance`, `Intérim` |
| `domaine` | string | job field |
| `plateforme` | string | source (HelloWork, LinkedIn…) |
| `tags` | string[] | unknown tags are added to your tag list |
| `notes` | object[] | each `{ "label": "...", "value": "..." }` |
| `relances` | object[] | follow-ups: each `{ "date": "YYYY-MM-DD", "canal": "mail\|telephone\|linkedin\|autre", "note": "..." }` |
| `cv_conserve` | boolean | GDPR: data kept by the employer |
| `cv_conserve_mois` | integer | retention duration, in months |

Unknown fields are ignored.

### Duplicate detection

The key is **company + role** (`entreprise` + `poste`), case- and accent-insensitive.

- **No match** → the application is **created** (with its notes, tags and follow-ups).
- **Match found** → the existing application is **completed**: only **empty fields**
  are filled (your data is never overwritten), and tags are merged. Notes and
  follow-ups are **not** re-added (so re-importing never creates duplicates).

Re-importing the same file is safe and idempotent.

### Limits & safety

- Max **500** applications per import, file **≤ 2 MB**.
- Note title ≤ 200 chars, content ≤ 10 000 chars; per application: max 200 notes,
  50 tags, 200 follow-ups.
- Non-`http(s)` URLs (e.g. `javascript:`, `data:`) are rejected.
- Invalid JSON → a clear error, **nothing is written**.

### Compatibility — importing files made elsewhere

You don't *have* to follow the canonical structure exactly. To make it easy to import
files that weren't produced by this app (a spreadsheet export, another tracker, etc.),
the importer is **tolerant** and also accepts:

- **camelCase** field names: `dateCandidature`, `dateReponse`, `nomRecruteur`,
  `emailRecruteur`, `lienOffre`, `typeContrat`, `domaineMetier`, `etiquettes`.
- Dates written as **`DD/MM/YYYY`** (converted to ISO).
- **Status synonyms**: `Refus` / `Refusé` → `Refusée`, `Candidature envoyée` →
  `Envoyée`; an unrecognised status falls back to `À postuler`.
- A single **`dateRelance`** (or `date_relance`) date instead of the `relances`
  array → recorded as one completed follow-up.
- Extra fields it doesn't know (e.g. `cvEnvoye`, `tentative`) are simply ignored.

These conversions exist **only for convenience**. If you control the file, use the
canonical structure above and nothing is converted.

---

## Exporting

### The export dialog (Applications tab → **⬇ Export**)

A single **Export** button opens a dialog where you pick:

- **Format**: **Excel** (`.xlsx`), **PDF**, **CSV** or **JSON**.
- **Filters** (combinable, optional): status, job field, platform, and a
  **candidature date range** (from / to). Leave a filter on “All” to ignore it.

A **live preview** shows how many applications match and a short sample; the download
button gives you exactly that subset, in the chosen format.

**Format contents:**

- **Excel** — one row per application, columns: Entreprise, Poste, Lieu, Statut, Type
  de contrat, Plateforme, Domaine, Salaire, Date candidature, Date relance, Date
  réponse, Nb relances, Dernière relance, Recruteur, Email recruteur, Lien de l'offre,
  Étiquettes.
- **CSV** — same columns (UTF-8, `;` separator), interoperable and lightweight.
- **JSON** — the **canonical re-importable structure** (tags and follow-ups as arrays,
  no internal id) — see *Importing* above.
- **PDF** — a compact, read-only table (company, role, status, platform, field,
  location, date), handy for printing or sharing.

### Full backup (`.zip`) — in Settings

The **Backup** button produces a `.zip` containing:

- `data/` — the SQLite database,
- `uploads/` — your imported files (CVs, cover letters…),
- `export/donnees.json` — a complete JSON export (re-importable),
- `export/candidatures.csv` — a CSV of your applications (UTF-8, `;` separator).

The backup always contains **everything** (it is never filtered).

### Which format should I pick? (a practical guide)

| Need | Best format |
|---|---|
| Analyze, sort, pivot tables | **Excel** — the most versatile in a professional setting |
| Reuse in other tools / re-import | **CSV** — interoperable and lightweight |
| Faithful backup / re-import into the app | **JSON** — full structure preserved |
| Share read-only (print, email) | **PDF** |
| Keep *everything* safe | **Backup `.zip`** (database + files) |
