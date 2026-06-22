# 🎯 Job Application Manager

A local-first web app I built to bring some order to my own job search — track
applications, store CVs & cover letters, and never miss a follow-up.

> 👋 Hi, I'm **Aleha0**. I made this for myself, then polished it to share.
> Hope it helps your search too!

_100% local · privacy-first · no framework_

> 🌍 **Language:** the interface is currently in **French**. An English version is on the way.

**Nothing ever leaves your computer.** There's no account, no cloud, no tracker —
the server listens only on `localhost` (127.0.0.1), so it's never exposed to your
network. Your applications, CVs and cover letters stay on your machine.

## ✨ Features

- **Tracking table** for your applications (company, role, location, status, salary,
  contract type, **platform**, **job field**, recruiter, link to the offer, dates).
- **Statuses**: To apply → Sent → Followed up → Interview → Accepted / Rejected,
  plus *On hold* ("we'll get back to you when we need someone" — re-pingable
  periodically) and *No reply* when you don't want to follow up.
- **Follow-up reminders**: a flash alert at the top of the page, based on a
  configurable automatic delay **and/or** a manual follow-up date per application.
- **Documents**: import your CVs and cover letters (PDF, Word, images…) and sort
  them into **folders**.
- **Text notes**: jot down information and attach it to an application or a folder.
- **Dashboard** with key stats.
- **Statistics & charts** 📈: key figures (reply/interview rate, average reply time),
  weekly goal, applications per month, conversion funnel, breakdown by
  status/platform/location, interview rate per platform and **per CV** — all charts
  rendered locally, with no external library.
- **Global search** 🔍: search applications, documents and notes at once (tags
  included, accent-insensitive). Available from the sidebar button or the **Ctrl+K**
  shortcut.
- **Export** ⬇️: export your applications to **Excel (.xlsx)** or **PDF** (from the
  Applications tab), in addition to the full backup (.zip with CSV + JSON).
- **My CV libraries** 🗃️: a list of the platforms where your CV is posted (Indeed,
  LinkedIn, APEC, France Travail…), with the last update date, the linked CV and an
  **"out of date"** flag (if a newer CV exists, or if the update is older than X
  months — configurable). Each document also shows **which platforms it's posted on**,
  and flags CVs that aren't on **any** platform.
- **Auto-fill from a job offer**: paste an offer's link and the app pre-fills the
  fields (company, role, location, salary, contract…).
- **Dark mode** 🌙: light/dark theme, remembered between sessions.
- **Follow-up notifications**: on your phone (via ntfy) and/or on your computer
  (browser notifications).
- **Tags** 🏷️: a customizable tag list (Settings), assignable to each application and
  usable as a filter in the table.
- **File update date** 🕒: asked on import (and pre-filled automatically from the
  file's metadata), with a "to check" flag for files older than 6 months — handy to
  know whether a CV is still up to date.

## ✨ Auto-fill from a job offer

In an application, paste the offer's link then click **"✨ Fill"**:

1. **Structured data (free, no setup)** — the app reads the standard
   `schema.org/JobPosting` format present on many sites (Welcome to the Jungle,
   company career pages, some Indeed/HelloWork listings…).
2. **AI extraction (optional)** — for sites that don't provide this data, you can
   enable Claude. The app switches to it automatically if an API key is configured.
3. **Paste the text** — for LinkedIn/Indeed (which block automated reading), click
   "paste the offer text" and paste the content: the AI analyzes it.

### Enabling AI extraction (optional)

Create an API key at [console.anthropic.com](https://console.anthropic.com), then
start the app with the `ANTHROPIC_API_KEY` environment variable:

```powershell
# PowerShell (Windows)
$env:ANTHROPIC_API_KEY="sk-ant-..."
npm start
```

```bash
# macOS / Linux
ANTHROPIC_API_KEY="sk-ant-..." npm start
```

The model used is `claude-opus-4-8` by default (configurable via the
`ANTHROPIC_MODEL` variable). The cost per offer is around a few cents. Without a key,
only methods 1 and 3 (structured data) remain available — so the app works perfectly
fine with no configuration at all.

## 🚀 Installation & run

Requirements: [Node.js](https://nodejs.org/) (version 18 or higher).

```bash
# 1. Install dependencies (once)
npm install

# 2. Start the app
npm start
```

Then open your browser at **http://localhost:3000**

> Tip: `npm run dev` automatically restarts the server whenever you change the code.

### One-click launcher (Windows)

Prefer not to type commands? This repo ships two helper scripts:

- **`start-app.sh`** — a Bash script that starts the server, waits until it's ready,
  and opens the app in your default browser.
- **`start-app.cmd`** — a Windows launcher that runs the script above through Git
  Bash, so a plain **double-click** works.

Just double-click **`start-app.cmd`**. To keep it handy, right-click it →
**Send to → Desktop (create shortcut)** and launch the app from your desktop. Close
the terminal window to stop it.

> Requires [Git for Windows](https://git-scm.com/download/win) (for Git Bash) and
> Node.js. Of course, `npm start` still works on any OS.

## 🔔 Follow-up notifications

### On your phone (via ntfy — free)

1. Install the **ntfy** app ([Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy) /
   [F-Droid](https://f-droid.org/packages/io.heckel.ntfy/) / iOS App Store).
2. In the app, subscribe to a **topic** with a unique, hard-to-guess name
   (e.g. `follow-ups-7gK9pZ2q`).
3. In the web app → **Settings → Notifications**, enter the same topic (the
   **🎲 Generate** button suggests one), click **Test**, then **Save**.

The server sends a follow-up summary at most once a day while the app is running.
Messages are neutral ("3 applications to follow up") — no sensitive data is sent.

> 🔒 On the public `ntfy.sh` service, the topic name acts as a password: choose it
> long and random. For fully private use, you can self-host your own ntfy server and
> set its address in the `ntfy_server` setting.

### On your computer (browser)

In **Settings → Notifications**, click **Enable browser notifications**. You'll get a
system notification (while the app is open) whenever follow-ups are pending.

## 💾 Backup & where is my data?

The easiest way to save everything is the **Backup** button in **Settings**: it
generates a `.zip` archive containing your database, your imported files, and a
CSV + JSON export of your applications (reusable by other tools).

Under the hood, your data lives in two folders:

- Database: `data/gestion.db` (SQLite)
- Imported files: the `uploads/` folder

You can also back up by simply copying these two folders by hand. Either way, both
are ignored by Git (`.gitignore`), so your data always stays private.

## 🔒 Privacy & security

- The server binds to `127.0.0.1` only — never exposed on your network (override with
  the `GC_HOST` environment variable if you really need to).
- No telemetry, no third-party calls (except the optional AI extraction you enable
  yourself, and ntfy notifications if you set them up).
- Security headers (CSP, `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`), uploaded files are served safely (download for risky types),
  and outbound URL fetching is guarded against SSRF.

## 🛠️ Tech stack

- **Backend**: Node.js + Express + SQLite (better-sqlite3)
- **Upload**: multer
- **Frontend**: HTML / CSS / JavaScript (no framework, no build step)

## 📁 Project structure

```
job-application-manager/
├── server.js          # Express server + REST API
├── db.js              # SQLite connection + schema
├── package.json
├── public/            # Frontend
│   ├── index.html
│   ├── css/style.css
│   └── js/app.js
├── data/              # Database (generated, git-ignored)
└── uploads/           # Imported files (generated, git-ignored)
```

## 📄 License

This project is released under the [MIT](LICENSE) license — free to use, modify and
redistribute.

---

Made with ❤️ by **Aleha0**
