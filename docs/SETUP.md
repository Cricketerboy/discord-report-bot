# Setup & deployment guide (step by step)

Everything here is free and needs **no credit card**. If any page asks for a card, you're on the wrong plan: go back and pick the free one.

Total time: about 45 minutes. Do the steps in order; each one says exactly what to copy and where it goes.

Keep a scratch note open with these slots. You'll fill them as you go:

```
DISCORD_APPLICATION_ID =
DISCORD_PUBLIC_KEY     =
DISCORD_BOT_TOKEN      =
DISCORD_CLIENT_SECRET  =
DATABASE_URL           =
GROQ_API_KEY           =
APP_SECRET             =
ADMIN_EMAIL / ADMIN_PASSWORD =
Mirror webhook URL     =   (pasted in the dashboard later, not an env var)
Render URL             =   https://<name>.onrender.com
```

---

## 0. Prerequisites

- A GitHub account, a Discord account, Node.js 22, and git.
- Generate the app secret now and save it as `APP_SECRET`:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
- Decide the Render service name now (for example `report-bot-yourname`). Your URL will be `https://report-bot-yourname.onrender.com`. Render adds a suffix if the name is taken, so confirm the final URL after step 7.

## 1. Push the code to GitHub

```bash
git remote add origin https://github.com/<you>/<repo>.git
git branch -M main
git push -u origin main
```

(The repo already has a local commit history. Create an **empty** repository on GitHub first: no README, no .gitignore.)

## 2. Create the Discord application and bot

1. Go to <https://discord.com/developers/applications> → **New Application** → name it (for example "Report Bot") → accept the terms → **Create**.
2. **General Information** page:
   - Copy **Application ID** → `DISCORD_APPLICATION_ID`
   - Copy **Public Key** → `DISCORD_PUBLIC_KEY`
   - Leave *Interactions Endpoint URL* empty for now (step 8).
3. **Bot** page (left menu):
   - Click **Reset Token** → confirm → **Copy** → `DISCORD_BOT_TOKEN`. It is shown only once.
   - **Public Bot**: ON, so reviewers can add the bot to their own servers.
   - **Requires OAuth2 Code Grant**: OFF.
   - Privileged Gateway Intents: leave all OFF (not needed; this bot uses HTTP interactions only).
4. **OAuth2** page:
   - Under *Client Secret* click **Reset Secret** → copy → `DISCORD_CLIENT_SECRET`.
   - Under **Redirects**, click *Add Redirect* and enter `https://<name>.onrender.com/connect/discord/callback` → **Save Changes**. If you don't know the final URL yet, come back after step 7.
5. **Installation** page: make sure **Guild Install** is ticked. Setting *Install Link* to **None** is fine, since the dashboard generates its own link.

## 3. Create a test Discord server

1. In the Discord app, click **+** (Add a Server) → **Create My Own** → **For me and my friends** → name it.
2. Create these text channels:
   - `#reports`: where the bot posts report cards with buttons.
   - `#mod-alerts`: the mirror channel (if you use a Discord webhook in step 5).
3. *(Optional, for role pings)* Server Settings → **Roles** → **Create Role** → name it `mods`. Enable **Allow anyone to @mention this role**, then save and give yourself the role.
4. Invite link for reviewers: right-click the server → **Invite People** → *Edit invite link* → Expire after **Never**, Max uses **No limit** → copy.

## 4. Database: Neon (free Postgres)

1. Go to <https://neon.tech> → **Sign up** (GitHub login is quickest) → the free plan is selected by default.
2. **Create project**: pick any name, Postgres 16 or 17, and a region close to where you'll run Render (for example *AWS US East (Ohio)* for Render *Ohio*, or *AWS Asia Pacific (Singapore)* for Render *Singapore*).
3. On the project dashboard click **Connect** and copy the connection string. It looks like
   `postgresql://neondb_owner:...@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require`
   → paste it as-is into `DATABASE_URL` (the app ignores `channel_binding`). Pooled and direct strings both work.

You don't need to create tables. The app runs its migrations on every boot.

## 5. Mirror channel: pick one

**Option A: Discord channel webhook (simplest)**
In your test server: `#mod-alerts` → ⚙ **Edit Channel** → **Integrations** → **Webhooks** → **New Webhook** → **Copy Webhook URL**.

**Option B: Slack Incoming Webhook**
1. Create a free Slack workspace (or use one you own).
2. Go to <https://api.slack.com/apps> → **Create New App** → **From scratch** → name it and pick the workspace.
3. **Incoming Webhooks** → toggle **On** → **Add New Webhook to Workspace** → choose a channel → **Allow** → copy the `https://hooks.slack.com/services/...` URL.

Don't put this URL in an env var. You'll paste it into the dashboard in step 9, where it's stored encrypted.

## 6. AI key: Groq (optional but recommended)

1. Go to <https://console.groq.com> → sign in → **API Keys** → **Create API Key** → copy → `GROQ_API_KEY`.
2. Check <https://console.groq.com/docs/models>. If `llama-3.1-8b-instant` isn't listed any more, set `GROQ_MODEL` to a current fast model. (If the model is wrong the bot still works: it falls back to keyword triage and logs an `ai.fallback` warning.)

## 7. Deploy on Render

1. Go to <https://render.com> → **Get Started** → sign up with GitHub (no card needed for the free instance).
2. **New +** → **Web Service** → *Build and deploy from a Git repository* → connect GitHub → select your repo.
3. Fill in:
   | Field | Value |
   |---|---|
   | Name | the name you picked in step 0 |
   | Region | same area as your Neon region |
   | Branch | `main` |
   | Runtime | **Node** |
   | Build Command | `npm ci --include=dev && npm run build` |
   | Start Command | `npm start` |
   | Instance Type | **Free** |
4. **Environment Variables** → *Add from .env* or add one by one:
   ```
   NODE_ENV=production
   DATABASE_URL=...
   APP_SECRET=...
   DISCORD_APPLICATION_ID=...
   DISCORD_PUBLIC_KEY=...
   DISCORD_BOT_TOKEN=...
   DISCORD_CLIENT_SECRET=...
   GROQ_API_KEY=...
   ADMIN_EMAIL=reviewer@yourdomain.test
   ADMIN_PASSWORD=<a throwaway password, 12+ chars>
   ```
   (`PUBLIC_BASE_URL` isn't needed on Render. The app reads `RENDER_EXTERNAL_URL`.)
5. **Advanced** → **Health Check Path**: `/health`.
6. **Create Web Service**. The first build takes about 2–4 minutes. Wait for **Live**.
7. Check:
   - `https://<name>.onrender.com/health` → `{"status":"ok",...}`
   - `https://<name>.onrender.com/health/ready` → `{"status":"ready"}` (the database is reachable)
   - The Render **Logs** tab shows JSON lines including `"database ready"` and `"job worker started"`.

> If you ever set `NODE_ENV=production` and use plain `npm install` as the build command, the build fails with `tsc: not found`. That's why the build command has `--include=dev`.

## 8. Point Discord at the app

1. Developer Portal → your app → **General Information** → **Interactions Endpoint URL** = `https://<name>.onrender.com/interactions` → **Save Changes**.
   Discord immediately sends a signed PING and a deliberately invalid request. The save succeeds only if the app answers PONG to the first and `401` to the second.
2. **OAuth2** → **Redirects** must contain exactly `https://<name>.onrender.com/connect/discord/callback` (add it now if you skipped it).

## 9. Connect the server in the dashboard

1. Open `https://<name>.onrender.com` → sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
2. Click **+ Connect a Discord server**. Discord asks which server → pick your test server → **Continue** → **Authorize**.
3. You land on the server's **Settings** page. `/report` and `/status` are already registered.
   - **Report channel**: choose `#reports`. **Alert role**: choose `@mods` (optional). Click **Save**.
   - **Mirror channel**: paste the webhook URL from step 5 → **Save webhook** → **Send test message**. It should appear in `#mod-alerts` or Slack.
4. Open the **Live log** tab and keep it open.

## 10. Try it

In Discord (press Ctrl+R once if the commands don't show up yet):

- `/report text: the website is down` → reply with severity **critical** + card in `#reports` (mentions @mods) + mirror message.
- `/report` with no text → a form opens → submit it.
- On the card click **Acknowledge**, then **Resolve**.
- `/status`

Every step appears in the dashboard's Live log. Click a row to see its full timeline.

## 11. Keep it awake and verify security

- The app pings itself every 10 minutes (`KEEPALIVE=true`). As a backup, create a free monitor at <https://uptimerobot.com> (no card): *HTTP(s)*, URL `https://<name>.onrender.com/health`, interval 5 minutes.
- From your laptop: `npm run probe -- https://<name>.onrender.com`. Every junk request should print `PASS 401`.

## 12. Hand-in checklist

- [ ] README "For reviewers" table filled in (live URL, login, invite link, mirror channel).
- [ ] If reviewers should be able to click **Resolve**: in Settings, untick "Only moderators can Resolve", **or** give their role *Manage Messages* after they join.
- [ ] `AI_NOTES.md` personal sections written (see the TODO markers).
- [ ] `.env` is **not** committed (`git status` should never show it; it's in `.gitignore`).
- [ ] Pushed to GitHub, and Render shows the latest commit as Live.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Portal: *"interactions endpoint url could not be verified"* | The service isn't Live yet, `DISCORD_PUBLIC_KEY` is wrong (copy it again, 64 hex chars), or the URL is missing `/interactions`. Check the Render logs for `rejected interaction request`. |
| Render deploy fails with *Invalid environment configuration* | The log lists which variable is missing or malformed (names only, never values). |
| `Invalid OAuth2 redirect_uri` when connecting | The redirect in the portal must match `https://<name>.onrender.com/connect/discord/callback` exactly (https, no trailing slash). |
| Slash commands don't appear | Settings → **Register / re-sync commands**, then press Ctrl+R in Discord. The bot must have been added with the `applications.commands` scope, which the Connect button does. |
| *"The application did not respond"* in Discord | The instance was probably asleep (check that the keep-alive/UptimeRobot is running) or crashed (see the logs). |
| Card not posted; Failures tab shows `403 Missing Access` | The bot can't see or post in that channel. Channel settings → Permissions → add the bot's role with View Channel, Send Messages, Embed Links. Then **Retry now**. |
| Alert role shown but nobody pinged | The role must be *mentionable* (step 3, item 3). |
| Mirror dead with `HTTP 404` | The webhook was deleted or revoked. Paste a new one in Settings, then **Retry now** on the Failures tab. |
| AI summary missing, `ai.fallback` events | Bad or missing `GROQ_API_KEY`, rate limit, or a retired `GROQ_MODEL`. Reports still work with keyword triage. |
| Supabase instead of Neon: certificate error | Append `?sslmode=no-verify` to the Supabase connection string. |
