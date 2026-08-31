# Source registry

Where to look for each party's official positions, plus the government/parliamentary record and
two reputable secondary trackers. Only root or top-level section URLs the author is confident
resolve are listed here — no deep article/document links, since those go stale fast and are
exactly the kind of thing that should be found live and then cited with its own date, not copied
from this file. If a listed section path 404s (site redesigns happen), fall back to that site's
own search or navigation from its root.

**Reliability tiers**, used below:
- **Primary** — the party/government's own words. Highest weight; use for `confirmed`.
- **Primary (record)** — the official parliamentary record (Hansard, bill text). Definitive for
  what was said or how a vote went, but a speech or a vote is not automatically "the party's
  position" — read it in context.
- **Secondary** — reputable journalism. Useful for corroboration, for catching a position change
  a party hasn't put in writing yet, or when no primary source exists. Never the sole source for
  `confirmed`; pairs well with a primary source or downgrades a position to `verified: unverified`
  / lower `confidence` if that's all you have.

**Date-stamping claims:** every source you cite needs a `date`. Prefer the date the position was
stated/published (a media release date, a platform "last updated" date, the Hansard sitting date),
not the date you fetched it. If a page has no visible date, use the most specific date you can
find (e.g. a URL slug or article metadata) and prefer a dated alternative if one exists — an
undated primary source is weaker evidence than a dated secondary one reporting the same position.

## Labor (Australian Labor Party)

| Source | URL | Tier | Notes |
|---|---|---|---|
| Official site (root) | https://www.alp.org.au | Primary | Party platform and policy pages live under this domain; navigate from the primary nav ("Policies" / "Our Plan") since exact sub-paths change between campaigns. |
| Prime Minister's official site | https://www.pm.gov.au | Primary | Labor is the governing party (as of this dataset's `as_of` date) — PM announcements here are government policy, which is usually also the clearest statement of Labor's position. Check the `as_of` date against the current government before relying on this. |
| Parliament — see aph.gov.au below | | Primary (record) | Ministerial statements, bill second-reading speeches. |

## Coalition (Liberal Party + The Nationals)

| Source | URL | Tier | Notes |
|---|---|---|---|
| Liberal Party (root) | https://www.liberal.org.au | Primary | Federal Coalition policy is usually stated jointly or by the Liberal Party as senior partner; check for a dedicated policies/platform section from the nav. |
| The Nationals (root) | https://nationals.org.au | Primary | Use for positions where the Nationals have a distinct or more specific stance than the Liberal Party (agriculture, regional/resources issues) — the Coalition is not monolithic and `mixed` may be more honest than picking one partner's line. |
| Parliament — see aph.gov.au below | | Primary (record) | As Opposition (current), watch Question Time responses and dissent/second-reading speeches in Hansard. |

## Greens (Australian Greens)

| Source | URL | Tier | Notes |
|---|---|---|---|
| Official site (root) | https://greens.org.au | Primary | Well-documented, itemised policy platform; usually the easiest party to source cleanly. |
| Parliament — see aph.gov.au below | | Primary (record) | Greens senators are prolific in Senate debate; Hansard is a good corroborating source. |

## One Nation (Pauline Hanson's One Nation)

| Source | URL | Tier | Notes |
|---|---|---|---|
| Official site (root) | https://www.onenation.org.au | Primary | Policy platform is less exhaustively itemised than the majors/Greens — many issues will genuinely be `no_position` here; don't infer a stance from a media appearance alone. |
| Parliament — see aph.gov.au below | | Primary (record) | Senate voting record and speeches are often the *only* verifiable signal for a given issue — check how Senator Hanson's office voted, not just what was said publicly. |

## Parliament of Australia

| Source | URL | Tier | Notes |
|---|---|---|---|
| Root | https://www.aph.gov.au | Primary (record) | Entry point for all of the below; use site search if a specific section path below has moved. |
| Bills & Legislation | https://www.aph.gov.au/Parliamentary_Business/Bills_Legislation | Primary (record) | Bill status, second-reading speeches, and how each party voted — the strongest evidence for "did this party actually act on this" as opposed to just saying it. |
| Hansard | https://www.aph.gov.au/Parliamentary_Business/Hansard | Primary (record) | Verbatim record of debate; good for pinning down a `mixed` or contradicted position with an exact quote and sitting date. |
| Parliamentary Library | https://www.aph.gov.au/About_Parliament/Parliamentary_Departments/Parliamentary_Library | Primary (record) | Non-partisan research and bills digests — excellent for neutral background on what a bill actually does, not for party positions themselves. |

## Secondary: policy trackers / reputable journalism

| Source | URL | Tier | Notes |
|---|---|---|---|
| ABC News | https://www.abc.net.au/news | Secondary | Public broadcaster; during election campaigns ABC typically runs a standalone policy-comparison feature. These features don't have a stable permanent URL across cycles — search ABC News for the current one rather than assuming a fixed path. |
| Guardian Australia | https://www.theguardian.com/australia-news | Secondary | Same caveat as ABC — campaign-period policy trackers are one-off feature pages, not a fixed evergreen URL. Search from this section root. |
| SBS News | https://www.sbs.com.au/news | Secondary | Public broadcaster; strong on migration, multicultural-community and welfare policy detail. |
| news.com.au | https://www.news.com.au/national | Secondary | News Corp's free mastheads' national politics coverage — the fetchable counterweight to the public broadcasters. Straight-news pieces only; skip opinion. |
| The Nightly | https://thenightly.com.au | Secondary | Seven West's free national masthead, centre-right leaning; useful second family for contested claims. |
| Sky News Australia | https://www.skynews.com.au/australia-news | Secondary | Free articles and interview transcripts; a minister or shadow's own words in a transcript count as their words — cite the transcript, not the panel commentary around it. |
| AAP | https://www.aap.com.au | Secondary (wire) | Wire copy — the most framing-neutral secondary option when a wire story exists. AAP FactCheck is also useful for contested numeric claims. |

Use secondary sources to (a) corroborate a primary source, (b) catch a stance change or backflip
not yet reflected on the party's own site, or (c) as the sole source only when no primary source
exists — in that case prefer `confidence: medium` or `low` and be honest in `verified`.

**Balance rule:** a contested characterisation must rest on a primary source or on two secondary
outlets from *different families* (public broadcaster / News Corp / Seven West / Nine / wire /
independent) — never one outlet family alone. The hard-paywalled mastheads (AFR, The Australian,
SMH/Age) generally can't be cited because every URL must be fetch-verified; when their reporting
matters, find the same fact in a fetchable outlet or the underlying primary document. No
Wikipedia or other tertiary references, ever. Audit the current mix any time with
`node scripts/source-balance.mjs`.
