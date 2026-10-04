# Talk Vote Worker — setup

About 30 minutes, best done at a computer. The KV store **eq-rs-talk-vote** already exists in your Cloudflare account (created by Zion Claude, 2026-10-03).

## 1. Create the Worker (5 minutes)

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Create Worker**. Name it `eq-rs-talk-vote` → **Deploy**.
2. **Edit code** → delete the sample → paste all of `worker.js` → **Deploy**.
3. Note the address it gives you, `https://eq-rs-talk-vote.<your-subdomain>.workers.dev`. The ballot page will call this.

## 2. Connect the storage

Worker → **Bindings** → **Add binding** → **KV namespace** → Variable name `BALLOTS` → namespace `eq-rs-talk-vote` → **Add binding**.

## 3. Add the settings

Worker → **Settings** → **Variables and Secrets** → **Add**.

As plain **Text** variables (values are in `wrangler.toml`):
`SEASON`, `ROUND`, `BUDGET`, `SLOTS`, `CLOSES_AT`, `ALLOWED_ORIGIN`, `TALKS_URL`, `PINS`, `ANONYMOUS`, `TRELLO_LIST_ID`.
Leave `ALLOWED_ORIGIN` and `TALKS_URL` as placeholders until the GitHub page exists.

As **Secret** variables:
- `VOTERS` and `ADMIN_KEY` — copy from `SECRETS-keep-private.txt`.
- `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN` — step 4.
- `TRELLO_KEY`, `TRELLO_TOKEN` — step 5.

## 4. Dropbox app (10 minutes)

1. https://www.dropbox.com/developers/apps → **Create app** → **Scoped access** → **App folder** → name it `EQ RS Talk Vote`.
2. **Permissions** tab → tick `files.content.write` and `files.content.read` → **Submit**.
3. **Settings** tab → copy the **App key** and **App secret** into the two secrets.
4. Get a refresh token, which lets the Worker keep working without you. In a browser, visit (with your app key):
   `https://www.dropbox.com/oauth2/authorize?client_id=APP_KEY&response_type=code&token_access_type=offline`
   Allow it, and copy the code shown. Then in a terminal:
   `curl https://api.dropboxapi.com/oauth2/token -d code=THE_CODE -d grant_type=authorization_code -u APP_KEY:APP_SECRET`
   Copy `refresh_token` from the reply into `DROPBOX_REFRESH_TOKEN`.

Results will appear in your Dropbox at `/Apps/EQ RS Talk Vote/2026-10/`, where Zion Claude can read them.

## 5. Trello key (5 minutes)

1. https://trello.com/power-ups/admin → create a Power-Up for your workspace (name: `Talk Vote`) → **API key** → generate. Copy it into `TRELLO_KEY`.
2. On the same page, follow the **Token** link, allow access, and copy the token into `TRELLO_TOKEN`.

The Worker uses these only to post one card in the Elder's Quorum board's Inbox.

## 6. The 6:00 AM watcher

Worker → **Settings** → **Triggers** → **Cron Triggers** → add `0 12 * * *` and `0 13 * * *`.
Cloudflare runs cron on UTC, and Utah changes clocks on Nov 1, so two triggers cover both; the Worker acts only on the one that is 6:00 AM in St. George.

## 7. Check it

Open `https://eq-rs-talk-vote.<subdomain>.workers.dev/api/admin/status?k=YOUR_ADMIN_KEY`.
You should see 0 of 8 ballots and all eight names under `waitingOn`.

Later, `/api/admin/run?k=YOUR_ADMIN_KEY` shows a dry-run tally without writing anything. Add `&dry=0` only to finalize by hand.

## Privacy

The Worker holds names, organizations, talk ids, and points. It holds no phone numbers, emails, or addresses. Never paste the secrets file into a chat or an email; send each person only their own link.
