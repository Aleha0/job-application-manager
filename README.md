# 🎯 Gestion des candidatures

Application web **100 % locale** pour gérer tes candidatures, tes CV et lettres de
motivation, et suivre tes relances — avec des **alertes flash** automatiques.

Aucune donnée n'est envoyée sur Internet : tout est stocké sur ton ordinateur.

## ✨ Fonctionnalités

- **Tableau de suivi** des candidatures (entreprise, poste, lieu, statut, salaire,
  type de contrat, **plateforme**, **domaine métier**, recruteur, lien vers l'offre, dates).
- **Statuts** : À postuler → Envoyée → Relancée → Entretien → Acceptée / Refusée,
  ainsi que « En réserve » (candidature « on vous recontactera au besoin » —
  relançable périodiquement) et « Sans réponse » si tu ne souhaites pas relancer.
- **Rappels de relance** : alerte flash en haut de page, basée sur un délai
  automatique configurable **et/ou** une date de relance manuelle par candidature.
- **Documents** : importe tes CV et lettres (PDF, Word, images…) et range-les dans
  des **dossiers**.
- **Notes texte** : crée des fichiers texte pour consigner des informations, et
  rattache-les à une candidature ou à un dossier.
- **Tableau de bord** avec statistiques.
- **Statistiques & graphiques** 📈 : chiffres clés (taux de réponse/entretien, délai
  moyen de réponse), objectif hebdomadaire, candidatures par mois, entonnoir de
  conversion, répartition par statut/plateforme/lieu, taux d'entretien par plateforme
  et **par CV** — graphiques 100 % locaux (sans librairie externe).
- **Recherche globale** 🔍 : cherche en une fois dans les candidatures, documents et
  notes (étiquettes incluses, insensible aux accents). Accès via le bouton de la
  barre latérale ou le raccourci **Ctrl+K**.
- **Mes CVthèques** 🗃️ : liste des plateformes où ton CV est déposé (Indeed,
  LinkedIn, APEC, France Travail…), avec date de dernière mise à jour, CV lié et un
  repère **« à mettre à jour »** (si un CV plus récent existe, ou si la mise à jour
  date de plus de X mois — configurable). Chaque document indique aussi **sur quelles
  plateformes il est déposé**, et signale les CV présents sur **aucune** plateforme.
- **Remplissage auto depuis l'offre** : colle le lien d'une offre et l'app
  pré-remplit les champs (entreprise, poste, lieu, salaire, contrat…).
- **Mode sombre** 🌙 : thème clair/sombre, mémorisé entre les sessions.
- **Notifications de relance** : sur ton téléphone (via ntfy) et/ou sur ton PC
  (notifications du navigateur).
- **Étiquettes** 🏷️ : liste d'étiquettes personnalisable (Paramètres), assignables
  à chaque candidature et utilisables comme filtre dans le tableau.
- **Date de mise à jour des fichiers** 🕒 : demandée à l'import (et pré-remplie
  automatiquement depuis les métadonnées du fichier), avec un repère
  « à vérifier » pour les fichiers de plus de 6 mois — pratique pour savoir si un
  CV est à jour.

## ✨ Remplissage automatique depuis une offre d'emploi

Dans une candidature, colle le lien de l'offre puis clique sur **« ✨ Remplir »** :

1. **Données structurées (gratuit, sans configuration)** — l'app lit le format
   standard `schema.org/JobPosting` présent sur de nombreux sites (Welcome to the
   Jungle, pages carrières d'entreprises, certains Indeed/HelloWork…).
2. **Extraction par IA (optionnelle)** — pour les sites qui ne fournissent pas ces
   données, tu peux activer Claude. L'app bascule dessus automatiquement si une clé
   API est configurée.
3. **Coller le texte** — pour LinkedIn/Indeed (qui bloquent la lecture automatique),
   clique sur « colle le texte de l'offre » et colle le contenu : l'IA l'analyse.

### Activer l'extraction par IA (facultatif)

Crée une clé API sur [console.anthropic.com](https://console.anthropic.com), puis
lance l'app avec la variable d'environnement `ANTHROPIC_API_KEY` :

```powershell
# PowerShell (Windows)
$env:ANTHROPIC_API_KEY="sk-ant-..."
npm start
```

```bash
# macOS / Linux
ANTHROPIC_API_KEY="sk-ant-..." npm start
```

Le modèle utilisé est `claude-opus-4-8` par défaut (modifiable via la variable
`ANTHROPIC_MODEL`). Le coût par offre est de l'ordre de quelques centimes.
Sans clé, seules les méthodes 1 et 3 (données structurées) restent disponibles —
l'app fonctionne donc parfaitement sans aucune configuration.

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

## 🔔 Notifications de relance

### Sur ton téléphone (via ntfy — gratuit)

1. Installe l'app **ntfy** ([Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy) /
   [F-Droid](https://f-droid.org/packages/io.heckel.ntfy/) / iOS App Store).
2. Dans l'app, abonne-toi à un **sujet** au nom unique et difficile à deviner
   (ex : `relances-candidatures-7gK9pZ2q`).
3. Dans l'app web → **Paramètres → Notifications**, saisis le même sujet
   (le bouton **🎲 Générer** en propose un), clique **Tester**, puis **Enregistrer**.

Le serveur envoie un récap des relances une fois par jour (au plus) quand l'app
tourne. Les messages sont neutres (« 3 candidatures à relancer ») — aucune donnée
sensible ne transite.

> 🔒 Sur le service public `ntfy.sh`, le nom du sujet fait office de mot de passe :
> choisis-le long et aléatoire. Pour un usage 100 % privé, tu peux héberger ton
> propre serveur ntfy et renseigner son adresse dans le réglage `ntfy_server`.

### Sur ton PC (navigateur)

Dans **Paramètres → Notifications**, clique sur **Activer les notifications
navigateur**. Tu recevras une notification système (quand l'app est ouverte) s'il
y a des relances en attente.

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
