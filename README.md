# Hunt Map

Per-GMU hunt planner for Washington. Public land, roads by pressure class, gates, timber harvest ages, terrain-based security model (security > food > water), seasons, pins, hunt log, best-days calendar, GPX export.

## One-time setup (about 15 minutes)

### 1. Put the app on GitHub Pages
1. github.com → **New repository** → name `hunt-map`, Public, no README → Create.
2. On the empty repo page click **uploading an existing file**, drag the whole contents of this folder in (all files), Commit.
3. Repo → **Settings → Pages** → Source: *Deploy from a branch*, Branch: `main` / `/ (root)` → Save.
4. Two minutes later the app is at `https://<your-username>.github.io/hunt-map/`. On the iPhone open it in Safari → Share → **Add to Home Screen**.

### 2. Turn on sync (Supabase)
1. supabase.com → your project → **SQL Editor** → paste `supabase.sql` → Run.
2. **Authentication → URL Configuration**: Site URL = your GitHub Pages URL; add it to Redirect URLs too.
3. **Settings → API**: copy the *anon public* key into `config.js` → `SUPABASE_ANON_KEY` (edit the file on GitHub, commit).
4. In the app click **Sign in**, enter your email, open the link on that device. Pins and hunt days now sync between phone and Mac. Never put the service_role key anywhere.

### 3. Calendar (best days)
1. Repo → **Settings → Secrets and variables → Actions → New repository secret**: name `CAL_URL`, value = your iCloud public calendar `webcal://…` link.
2. **Actions** tab → *Refresh calendar* → Run workflow. It runs itself every 6 hours after that and writes `calendar.json`.
   Shift days are detected by event titles containing "shift", "duty", "work", "24", or A/B/C/D-shift.

### 4. Home for drive times
In the app, click your name (top right) → Settings → enter your home town or address.

## Updating
Edit files on GitHub (or push from the Mac). Pages redeploys in about a minute. Seasons live in `regs.js` (generated from the WDFW pamphlet by `gen_regs.py`).

## Data sources (all live, all public)
WDFW GMU boundaries · WA DNR managed parcels and Forest Practice Applications · USGS PAD-US 4.1 · OpenStreetMap roads, gates, rivers (Overpass) · AWS Terrarium elevation tiles · Open-Meteo forecast · OSRM routing · USGS/Esri/OpenTopo basemaps.
