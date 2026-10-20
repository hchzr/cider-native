# Native for Cider

A [Cider](https://cider.sh) plugin that makes Cider look and behave like Music on macOS 26: Music's glass sidebar with content
running under it, the Up Next panel, the floating glass player, SF Symbols for every icon, and Music's spacing, pages and
library lists. Sizes and colours were measured against Music.app side by side at the same window size.

It also adds **Discover**, a page of new music picked from your own listening (see [How Discover works](#how-discover-works)).

Everything is controlled from one place, **… > Plugins > Native…**: a settings sheet with a switch for each part. Changes
apply immediately, and the master switch at the top returns stock Cider.

Not affiliated with Apple or the Cider Collective.

## Requirements

- macOS with Cider 4 (tested with Cider 4.0.31)
- The Xcode command line tools (`xcode-select --install`) and `python3`: the install step renders the SF Symbols on your Mac

## Install

```sh
git clone https://github.com/hchzr/cider-native.git
cd cider-native
./install.sh
```

Then in Cider open **Settings > Extensions**, enable **Native**, and quit and reopen Cider.
To update, `git pull` and run `./install.sh` again. To remove it, turn it off in Settings > Extensions and delete
`~/Library/Application Support/sh.cider.genten/plugins/native`.

## Parts

| Group | Part | Notes |
|---|---|---|
| Interface | Sidebar | Search field (search as you type), Home/New/Radio, library, pins, playlists, account row |
| | Discover | The sidebar's Discover New Music row opens it |
| | Up Next panel | Autoplay and AutoMix buttons, drag to reorder |
| | Floating player | Player size: smaller, default, larger |
| | Toolbar | Plain toolbar buttons; library titles and controls in the title bar |
| | Window controls | Traffic lights where Music places them |
| | SF Symbols | Cider's own icons drawn with the macOS symbol set |
| | System font, Apple Music red | |
| Pages | Window layout | Edge-to-edge content running under the glass sidebar |
| | Home and browse, Album/playlist/artist pages, Library lists | |
| | Compact Mac sizing | Cider setting |
| Covers and Effects | Animations | Apple-style menus, sheets, page changes and press feedback |
| | Animated covers, Keep covers moving in the background, Efficient background effects | Cider settings |
| System | Overlay scrollbars, Arrow pointer, Song notifications, Music keyboard shortcuts | ⌘→ ⌘← next/previous, ⌘↑ ⌘↓ volume |

Parts marked "Cider setting" read and write Cider's own config, so they always agree with Cider's Settings window.

The player's AirPlay button opens the AirPlay picker of a small companion app (`cidercompanion://airplay`), which is not
part of this repository; without it the button does nothing.

## How Discover works

Discover lives at Cider's plugin page route (`/ugc/plugins/ce/native-discover`), so back, forward and tabs work as on any
other page. It shows a Discover Mix, one mix per taste it finds in your listening, Artists to Try, Deeper Cuts from artists
you play, new releases from your artists, and what it knows about your taste.

1. **Taste profile.** Recent plays, a play log Discover keeps itself (Apple only returns about the last 100 plays), heavy
   rotation, Favourite Songs, your own playlists, subscribed playlists and the library each add weight to artists, genres
   and years. Songs from cast recordings and collaborations count for the album artist, so a musical is one taste rather
   than fifty singers. Anything you own or have played is "known" and never recommended.
2. **Tastes.** Your top artists are clustered by how much their similar-artist lists overlap. Each cluster gets its own
   mix and a fair share of the main mix.
3. **Relevance.** Personalised PageRank over Apple's similar-artist graph, restarting at your artists (40 artists and
   all their views per request, cached for a week). The Adventure slider sets how far it wanders.
4. **Songs.** Scored on graph relevance, how many of your artists agree, genre and era fit, popularity (a new artist's
   best-known songs, but not a superstar's mega-hit; a deeper cut for an artist you know), editors' playlists ("Inspired
   by…", "Deep Cuts"), Apple's own recommendations and your reactions.
5. **Learning.** Favourite, Add, Not for Me, Never Suggest, skips in the first 30 seconds and songs played through are
   labelled examples; a regularised logistic regression adjusts the scoring weights, and the page says what it learned.
6. **Picking.** Diversified selection (at most two songs per artist, one per album, an exploration share of artists two
   steps away), then ordered in short blocks that move from one of your tastes to the next.

Measured on a holdout of the author's own listening (20% of the top artists hidden, 40 random splits), the ranking finds
22% of the hidden artists in its top 50, against 17.5% for the scoring of the Smart Discover plugin it replaces; adding
reverse edges or stronger hub damping made it worse, so neither is used.

Everything Discover learns stays in Cider's local storage. **Save as Playlist** writes one "Discover Mix" playlist and
replaces its songs on later saves; Apple Music adds the songs of any library playlist to your library, so saving is
always a separate action.

## How it works

- `plugin.js` entry: settings, applying parts, the menu entry, and `window.CiderNative` for the console
  (`CiderNative.open()`, `.set(id, on)`, `.setEnabled(on)`, `.diagnostics()`)
- `settings.js` the parts and their defaults; plugin settings live in `localStorage['native/settings']`
- `sidebar.js`, `player.js`, `system.js`, `panel.js` the runtime modules; `*-logic.js` their pure, tested logic
- `discover.js` the Discover page and its generation job, `discover-data.js` Apple Music requests and caching,
  `discover-engine.js` the recommendation engine (pure, tested)
- `css/*.css` one stylesheet per part, compiled into `styles.js` by `tools/build.py` (every declaration made `!important`,
  as Cider's theme loader does)
- `tools/build.py` + `tools/sfgen.swift` render the SF Symbols from your Mac into `sf.js` and `css/icons.css`

Native is event-driven: placement follows Cider's sidebars through a ResizeObserver, the appearance through one observer on
`<html>`/`<body>`, icons are tagged when Quasar renders them, and the progress bar is a compositor-driven animation. On the
Home page it uses less main-thread time than stock Cider (46.5 ms/s against 56.5 ms/s with the window focused), mostly
because the floating player replaces Cider's bottom bar.

## Develop

```sh
python3 tools/build.py                 # regenerate sf.js, styles.js and css/icons.css
for t in test/*.mjs; do node "$t"; done
```

## License

MIT. SF Symbols are Apple's: they are rendered on your own Mac at install time and are not distributed here.
