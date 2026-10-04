# Talk Vote

A small ballot that helps the Eagle's Landing Ward elders quorum and Relief Society presidencies choose general conference talks for their weekly Sunday discussions.

- `index.html` — the ballot page (GitHub Pages). Voters open a personal link: `.../?t=THEIR_CODE`. Add `?preview=1` to try it without a link; nothing is saved.
- `data/2026-10/talks.json` — one neutral summary per talk, written with AI assistance and reviewed by Jason Swigert. Talk texts are linked, never copied.
- `worker/` — the Cloudflare Worker that receives ballots, holds them until voting closes, tallies at 6:00 AM, saves results to Dropbox, and posts a Trello card. See `worker/SETUP.md`.

No phone numbers, emails, addresses, or data from Church systems are stored here. Voter codes live only in Cloudflare secrets.
