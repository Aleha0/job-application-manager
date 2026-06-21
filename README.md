# 🎯 Gestion des candidatures

Application web **100 % locale** pour gérer tes candidatures, tes CV et lettres de
motivation, et suivre tes relances — avec des **alertes flash** automatiques.

Aucune donnée n'est envoyée sur Internet : tout est stocké sur ton ordinateur.

## ✨ Fonctionnalités

- **Tableau de suivi** des candidatures (entreprise, poste, lieu, statut, salaire,
  type de contrat, recruteur, lien vers l'offre, dates).
- **Statuts** : À postuler → Envoyée → Relancée → Entretien → Acceptée / Refusée,
  ainsi que « Sans réponse » si tu ne souhaites pas relancer.
- **Rappels de relance** : alerte flash en haut de page, basée sur un délai
  automatique configurable **et/ou** une date de relance manuelle par candidature.
- **Documents** : importe tes CV et lettres (PDF, Word, images…) et range-les dans
  des **dossiers**.
- **Notes texte** : crée des fichiers texte pour consigner des informations, et
  rattache-les à une candidature ou à un dossier.
- **Tableau de bord** avec statistiques.

## 🚀 Installation & lancement

Prérequis : [Node.js](https://nodejs.org/) (version 18 ou plus).

```bash
# 1. Installer les dépendances (une seule fois)
npm install

# 2. Lancer l'application
npm start
```

Puis ouvre ton navigateur sur **http://localhost:3000**

> Astuce : `npm run dev` relance automatiquement le serveur à chaque modification du code.

## 💾 Où sont mes données ?

- Base de données : `data/gestion.db` (SQLite)
- Fichiers importés : dossier `uploads/`

Pour **sauvegarder** toutes tes données, il suffit de copier ces deux dossiers.
Ils sont ignorés par Git (`.gitignore`) pour rester privés.

## 🛠️ Stack technique

- **Backend** : Node.js + Express + SQLite (better-sqlite3)
- **Upload** : multer
- **Frontend** : HTML / CSS / JavaScript (sans framework, sans étape de build)

## 📁 Structure du projet

```
gestion-candidatures/
├── server.js          # Serveur Express + API REST
├── db.js              # Connexion SQLite + schéma
├── package.json
├── public/            # Frontend
│   ├── index.html
│   ├── css/style.css
│   └── js/app.js
├── data/              # Base de données (généré, ignoré par git)
└── uploads/           # Fichiers importés (généré, ignoré par git)
```
