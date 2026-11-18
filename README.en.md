# dsh-rss-news-zhuikan

**A site you follow has no RSS feed? Paste its list page URL — AI does the rest.**

[中文](./README.md) | English

[![npm version](https://img.shields.io/npm/v/dsh-rss-news-zhuikan)](https://www.npmjs.com/package/dsh-rss-news-zhuikan)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

`dsh-rss-news-zhuikan` ("watchlist") is a companion plugin for [dsh-rss-news-daily](https://github.com/terry2010/dsh-rss-news-daily). It closes a common gap: many sites — streaming catalogs, game download pages, forum boards, announcement lists — publish no RSS/Atom at all. Zhuikan lets you subscribe to those **plain list pages** directly: AI reads the page structure once, learns where the title/link/date live, then polls on a schedule and pushes only what's new.

New items land in the main plugin's unified "All News" feed alongside regular RSS items — no separate place to check.

## What you can do with it

### Subscribe to list pages that have no feed

Paste a list page URL. The plugin fetches the page, condenses its structure for AI, generates an extraction rule and verifies it with a live trial extraction. Pages with several list blocks (e.g. "Latest Movies / Series / Anime") are detected individually — you pick which to follow, each with real sample items you can click to verify.

### New items join the unified feed

Once enabled, items appear under a `[追]`-prefixed source in the main plugin's "All News". Since watchlist sources are user-curated, their items skip the AI scoring/translation/digest/brief pipelines by default — each can be re-enabled per-source in the main plugin's source settings.

### Push only on keyword hits

Attach keywords per site or globally. With keywords set, only matching new items trigger desktop notifications; sites with no applicable keyword push all their updates. A hits log shows which term, site and confidence fired each push.

### Sites heal themselves

If a site redesign breaks its rule, it's flagged "possibly redesigned" — re-analyze with one click and confirm the new rule to take over. Login walls and bot challenges open in a dedicated browser for one-time auth, reused automatically afterwards. Blocked sites inherit the main plugin's global proxy with a single checkbox.

## Usage

1. Install the main plugin `dsh-rss-news-daily` first — this plugin activates automatically once it detects it.
2. In the reader's "追看" tab, paste a list page URL and click "Analyze".
3. Wait for the AI rule (about 1–3 min on a local model, with live step progress), pick the list blocks to follow, confirm.
4. Site cards let you adjust interval, fetch now, re-analyze, toggle proxy or delete; new items appear in "All News".

## Data & privacy

- Sites, rules, items, keywords and hits are stored locally.
- Rule generation calls the AI model you configured in dsh, sending a structural summary of the page — not the full HTML.
- Authenticated sites are handled through a dedicated browser instance; cookies stay in a local browser profile.

## Install

This is a companion plugin — install [dsh-rss-news-daily](https://www.npmjs.com/package/dsh-rss-news-daily) first, then `dsh-rss-news-zhuikan` via dsh's plugin manager.

## Development

```bash
npm test                 # tsc build + asset copy + node --test
node scripts/install-to-profile.mjs <profile>   # install to ~/.dsh/profiles/<profile>, restart dsh
```

## Related

- [dsh-rss-news-daily](https://github.com/terry2010/dsh-rss-news-daily) — main plugin: RSS reader with AI daily digest & hourly briefs
- [dsh-rss-news-flash-kuaixun](https://github.com/terry2010/dsh-rss-news-flash-kuaixun) — real-time finance flash-news companion
- [dsh-rss-news-browser-fetch](https://github.com/terry2010/dsh-rss-news-browser-fetch) — dedicated-browser fetch service (challenge/login/render fallback)

## License

Apache-2.0
