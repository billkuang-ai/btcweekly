# BTC Weekly — Handoff Notes
## Context
This is the approved design template for btcweekly.org — a weekly Bitcoin news roundup
aimed at being balanced, trusted, and concise. The design is Template C, V6 Final.

Key design decisions made:
- Warm canvas background (#FFF6EC) with Bitcoin orange (#F7931A) as the sole accent color
- Single-column, mobile-first layout
- Stories ranked 1–N by importance (1 = most important), number-only ranking system
- Story #1 uses a stronger left border and larger title to signal it as the lead
- All numbers same Bitcoin orange shade — no gradient hierarchy
- No hover motion on cards — desktop gets a subtle border tint only
- Centered static date/week pill beneath the wordmark (not a link)
- Wordmark uses Black Han Sans + Inter fonts (loaded from Google Fonts)
- No section header above story list (removed as redundant)
- RSS block and footer with archive link included

---

## To-Do List

### 1. Content templating
- [ ] Replace placeholder story data (title, summary, category, source, URL) with real weekly content
- [ ] Update "Week 15 · Apr 5–11, 2026" pill each issue with correct ISO week number and date range
- [ ] Confirm ISO week numbering logic — Week 1 starts the week containing the first Thursday of the year

### 2. Fonts
- [ ] Decide whether to self-host Black Han Sans and Inter or keep Google Fonts CDN
- [ ] If self-hosting: download both fonts, add @font-face rules, remove Google Fonts <link> tags
- [ ] Self-hosting improves load speed, privacy, and avoids GDPR concerns with Google Fonts

### 3. Navigation & archive
- [ ] Build an /archive page listing all past editions (title, date, link)
- [ ] Update the footer archive link href from "#" to "/archive"
- [ ] Update the footer btcweekly.org and RSS hrefs to real URLs

### 4. RSS feed
- [ ] Generate a valid RSS 2.0 or Atom feed at /rss (or /feed)
- [ ] Update the RSS block link href from "#" to the real feed URL
- [ ] Each issue should be a feed item with title, pubDate, link, and description

### 5. Story count flexibility
- [ ] Template currently has exactly 5 stories — decide on a fixed or variable count per issue
- [ ] If variable: test layout with 3, 4, and 7 stories to confirm it holds
- [ ] Consider a minimum of 3 and maximum of 7 for layout consistency

### 6. Sponsor / ad slot
- [ ] The <div class="sponsor"> block exists in the HTML but is display:none
- [ ] When ready to monetize: design a sponsor card component and drop it into that block
- [ ] Recommended placement: between the masthead and story #1 (already positioned there)

### 7. CMS / publishing workflow
- [ ] Decide on publishing platform: static site (Hugo, Jekyll, Eleventy), Ghost, or custom
- [ ] If static: create a template file and a content file (JSON or Markdown) per issue
- [ ] Automate date/week pill update so editors don't need to touch HTML each week
- [ ] Ensure each issue has a canonical URL e.g. btcweekly.org/2026/week-15

### 8. SEO & metadata
- [ ] Add <title> tag per issue: "BTC Weekly: Week 15 (2026) · Apr 5–11"
- [ ] Add <meta name="description"> summarising the top story
- [ ] Add Open Graph tags (og:title, og:description, og:url, og:image) for social sharing
- [ ] Add a Twitter/X card meta tag
- [ ] Consider a static og:image per issue showing the wordmark + week number

### 9. Analytics
- [ ] Add a lightweight analytics script (Plausible or Fathom recommended — privacy-friendly)
- [ ] Avoid Google Analytics if targeting privacy-conscious Bitcoin audience

### 10. Email version
- [ ] The current file is web-first — a separate email-safe version is needed for newsletter sends
- [ ] Email version requires: inline CSS, no external fonts, table-based layout optional,
      max-width 600px, no box-shadow, no CSS variables (use hex values directly)
- [ ] Recommended tool: Maizzle or MJML to generate the email version from the web template

### 11. Dark mode
- [ ] Current template has no dark mode support
- [ ] Optional: add @media (prefers-color-scheme: dark) overrides for background, text, and border colors
- [ ] Keep orange accent unchanged in dark mode — it works well on dark backgrounds
