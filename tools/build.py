#!/usr/bin/env python3
"""Builds the generated parts of the plugin from its sources.

  1. Renders the SF Symbols it needs from this Mac's own symbol set (tools/sfgen.swift) and writes
       sf.js            glyph masks for the sidebar, Up Next and player (exact point sizes, measured on Music.app)
       css/icons.css    Cider's own icons (nucleo set + Quasar font icons) drawn as SF Symbols
  2. Compiles css/*.css into styles.js: comments stripped, whitespace collapsed, and every declaration made !important
     (what Cider's theme loader did for these rules when they shipped as a theme).

The generated files contain images of Apple's symbols, so they are built on your Mac and never committed.

Glyphs are black-on-transparent PNG masks (3x) tinted with currentColor, so they follow text colour, accent, light/dark
mode and the inactive-window state like native symbols.

Run:  python3 tools/build.py          (needs the Xcode command line tools for swiftc)
"""
import json
import pathlib
import re
import subprocess

PLUGIN = pathlib.Path(__file__).resolve().parents[1]
SF_DIR = PLUGIN / 'tools'
BUILD = SF_DIR / '.build'

# ---- glyphs drawn by the plugin itself: key -> (symbol, point size[, weight[, app bundle for app-private symbols]]) ----
SIDEBAR = {
    'search': ('magnifyingglass', 16), 'home': ('house', 16), 'grid': ('square.grid.2x2', 16),
    'radio': ('dot.radiowaves.left.and.right', 16), 'clock': ('clock', 16), 'mic': ('music.microphone', 16),
    'stack': ('square.stack', 16), 'note': ('music.note', 16), 'video': ('music.note.tv', 16),
    'person': ('person.crop.square', 16), 'grid9': ('square.grid.3x3', 16), 'star': ('star.square', 16),
    'pin': ('pin', 16), 'spark': ('sparkles', 16), 'list': ('music.note.list', 12),
    'chevron': ('chevron.right', 10, 'semibold'), 'collab': ('person.2.fill', 11),
    # Up Next panel
    'infinity': ('infinity', 17), 'automix': ('automix', 17, 'regular', '/System/Applications/Music.app'), 'shuffle': ('shuffle', 15), 'repeat': ('repeat', 15), 'repeat1': ('repeat.1', 15),
    'dots': ('ellipsis', 15), 'play': ('play.fill', 13),
}
PLAYER = {
    'shuffle': ('shuffle', 14), 'repeat': ('repeat', 14), 'repeatOne': ('repeat.1', 14),
    'prev': ('backward.fill', 17), 'next': ('forward.fill', 17), 'play': ('play.fill', 23), 'pause': ('pause.fill', 23),
    'more': ('ellipsis', 17, 'medium'), 'lyrics': ('quote.bubble', 17, 'medium'), 'queue': ('list.bullet', 17, 'medium'), 'airplay': ('airplay.audio', 17, 'medium'),
    'vol': ('speaker.wave.2.fill', 17, 'medium'), 'volLow': ('speaker.wave.1.fill', 17, 'medium'), 'mute': ('speaker.slash.fill', 17, 'medium'),
    'star': ('star', 11), 'starFill': ('star.fill', 11), 'expand': ('arrow.up.left.and.arrow.down.right', 17),
    'apple': ('applelogo', 23),
}

# ---- Cider's own icon set ("nucleo", <svg><use href="#ni-NAME">) -> SF Symbol ----
NUCLEO = {
    'search': 'magnifyingglass', 'home': 'house', 'browse': 'square.grid.2x2', 'radio': 'dot.radiowaves.left.and.right',
    'ticket': 'ticket', 'pin': 'pin', 'unpin': 'pin.slash', 'play': 'play.fill', 'pause': 'pause.fill', 'stop': 'stop.fill',
    'previous': 'backward.fill', 'rewind': 'backward.fill', 'recently-added': 'clock', 'apple-music-note': 'music.note',
    'albums': 'square.stack', 'artists': 'music.microphone', 'artist': 'music.microphone', 'genres': 'guitars',
    'podcast': 'antenna.radiowaves.left.and.right', 'menu-dots': 'ellipsis', 'plus': 'plus', 'grid-9': 'square.grid.3x3',
    'star-sparkle': 'star.square', 'star': 'star', 'star-filled': 'star.fill', 'collaborate': 'person.2',
    'chevron-left': 'chevron.left', 'chevron-right': 'chevron.right', 'sidebar-opened': 'sidebar.left',
    'sidebar-closed': 'sidebar.left', 'sidebar-left': 'sidebar.left', 'sidebar-left-hide': 'sidebar.left',
    'lyrics': 'quote.bubble', 'hud-lyrics': 'quote.bubble', 'full-lyrics': 'quote.bubble', 'headphones': 'headphones',
    'refresh': 'arrow.clockwise', 'shuffle': 'shuffle', 'repeat': 'repeat', 'repeat-one': 'repeat.1', 'infinity': 'infinity',
    'mini-player': 'pip', 'immersive': 'arrow.up.left.and.arrow.down.right', 'immersiveFull': 'arrow.up.left.and.arrow.down.right',
    'fullscreen': 'arrow.up.left.and.arrow.down.right', 'volume-mute': 'speaker.slash.fill', 'volume-low': 'speaker.wave.1.fill',
    'volume': 'speaker.wave.2.fill', 'volume-high': 'speaker.wave.3.fill', 'share': 'square.and.arrow.up',
    'shareAlt': 'square.and.arrow.up', 'check': 'checkmark', 'trash': 'trash', 'trash-filled': 'trash.fill',
    'circle-info': 'info.circle', 'download': 'arrow.down.circle', 'box-down': 'arrow.down.circle',
    'box-download': 'arrow.down.circle', 'box-check': 'checkmark.circle', 'box-minus': 'minus.circle',
    'thumbs-down': 'hand.thumbsdown', 'thumbs-down-fill': 'hand.thumbsdown.fill', 'settings': 'gearshape', 'close': 'xmark',
    'queue': 'list.bullet', 'upNext': 'list.bullet', 'queueUp': 'text.line.first.and.arrowtriangle.forward',
    'play-next': 'text.line.first.and.arrowtriangle.forward', 'play-later': 'text.line.last.and.arrowtriangle.forward',
    'remove-from-list': 'minus.circle', 'queueRemove': 'minus.circle', 'libraryRemove': 'minus.circle',
    'airplay': 'airplay.audio', 'music-playlist': 'music.note.list', 'playlist': 'music.note.list',
    'media-library': 'music.note.house', 'music-video': 'music.note.tv', 'video': 'video', 'folder': 'folder',
    'folder-closed': 'folder', 'folder-opened': 'folder', 'folderOpen': 'folder', 'profile': 'person.crop.circle',
    'logout': 'rectangle.portrait.and.arrow.right', 'edit': 'pencil', 'copy': 'doc.on.doc', 'history': 'clock.arrow.circlepath',
    'sleepTimer': 'moon.zzz', 'bell-outlined': 'bell', 'bell-filled': 'bell.fill', 'bell-filled-ring': 'bell.badge.fill',
    'url': 'link', 'eye': 'eye', 'image': 'photo', 'gridView': 'square.grid.2x2', 'listView': 'list.bullet',
    'sortIcon': 'arrow.up.arrow.down', 'microphone': 'mic', 'microphoneOff': 'mic.slash', 'speaker': 'hifispeaker',
    'smartQueue': 'wand.and.stars', 'plugins': 'puzzlepiece.extension', 'extension': 'puzzlepiece.extension',
    'themes': 'paintbrush', 'marketplace': 'bag', 'help': 'questionmark.circle', 'command': 'command',
    'private': 'hand.raised', 'megaphone': 'megaphone', 'bug': 'ladybug', 'power': 'power', 'tabs': 'square.on.square',
    'tabs-plus': 'plus.square.on.square', 'new-tab': 'plus.square.on.square', 'move-obj-up': 'arrow.up', 'arrowUp': 'arrow.up',
    'arrowDown': 'arrow.down', 'calendar': 'calendar', 'clipboard': 'doc.on.clipboard', 'textAa': 'textformat.size',
    'sound-waves': 'waveform', 'wave': 'waveform', 'accessibility': 'accessibility', 'layout': 'rectangle.split.2x1',
}
# Quasar QIcon font icons used by Cider: Material Icons ligatures (the element's text) and Ionicons classes.
QICON = {
    'add': 'plus', 'album': 'opticaldisc', 'all_inclusive': 'infinity', 'apps': 'square.grid.3x3', 'arrow_upward': 'arrow.up',
    'auto_awesome': 'sparkles', 'casino': 'dice', 'category': 'square.grid.2x2', 'check': 'checkmark', 'check_circle': 'checkmark.circle',
    'chevron_left': 'chevron.left', 'chevron_right': 'chevron.right', 'close': 'xmark', 'cloud_download': 'icloud.and.arrow.down',
    'content_copy': 'doc.on.doc', 'delete': 'trash', 'download': 'arrow.down.circle', 'drag_indicator': 'line.3.horizontal',
    'edit': 'pencil', 'error': 'exclamationmark.circle', 'error_outline': 'exclamationmark.circle', 'event': 'calendar',
    'expand_less': 'chevron.up', 'expand_more': 'chevron.down', 'folder': 'folder', 'fullscreen': 'arrow.up.left.and.arrow.down.right',
    'grade': 'star.fill', 'graphic_eq': 'waveform', 'headphones': 'headphones', 'help': 'questionmark.circle', 'history': 'clock.arrow.circlepath',
    'home': 'house', 'image': 'photo', 'info': 'info.circle', 'keyboard_arrow_down': 'chevron.down', 'keyboard_arrow_left': 'chevron.left',
    'keyboard_arrow_up': 'chevron.up', 'lyrics': 'quote.bubble', 'menu': 'line.3.horizontal', 'music_note': 'music.note',
    'open_in_new': 'arrow.up.right.square', 'pause': 'pause.fill', 'person': 'person', 'picture_in_picture_alt': 'pip',
    'play_arrow': 'play.fill', 'playlist_add': 'text.badge.plus', 'playlist_play': 'music.note.list', 'playlist_remove': 'minus.circle',
    'queue_music': 'music.note.list', 'radio': 'dot.radiowaves.left.and.right', 'refresh': 'arrow.clockwise', 'remove': 'minus',
    'repeat': 'repeat', 'restart_alt': 'arrow.counterclockwise', 'schedule': 'clock', 'search': 'magnifyingglass', 'settings': 'gearshape',
    'share': 'square.and.arrow.up', 'shuffle': 'shuffle', 'skip_next': 'forward.end.fill', 'sort': 'arrow.up.arrow.down',
    'speaker': 'hifispeaker', 'star': 'star.fill', 'stop': 'stop.fill', 'swap_horiz': 'arrow.left.arrow.right', 'swap_vert': 'arrow.up.arrow.down',
    'translate': 'character.bubble', 'tune': 'slider.horizontal.3', 'upload': 'square.and.arrow.up', 'verified': 'checkmark.seal',
    'volume_up': 'speaker.wave.2.fill', 'warning': 'exclamationmark.triangle', 'widgets': 'square.grid.2x2', 'grid_view': 'square.grid.2x2',
    'view_module': 'square.grid.2x2', 'view_list': 'list.bullet', 'library_music': 'music.note.house', 'account_circle': 'person.crop.circle',
    'favorite': 'heart.fill', 'favorite_border': 'heart', 'more_horiz': 'ellipsis', 'more_vert': 'ellipsis', 'filter_list': 'line.3.horizontal.decrease',
    'ion-ios-star': 'star.fill', 'ion-ios-shuffle': 'shuffle', 'ion-ios-repeat': 'repeat', 'ion-ios-play': 'play.fill', 'ion-ios-pause': 'pause.fill',
    'ion-ios-search': 'magnifyingglass', 'ion-ios-list': 'list.bullet', 'ion-ios-trash': 'trash', 'ion-ios-share': 'square.and.arrow.up',
    'ion-ios-add': 'plus', 'ion-ios-close': 'xmark', 'ion-close': 'xmark', 'ion-ios-close-circle': 'xmark.circle', 'ion-ios-arrow-back': 'chevron.left',
    'ion-arrow-back': 'chevron.left', 'ion-ios-arrow-forward': 'chevron.right', 'ion-ios-refresh': 'arrow.clockwise', 'ion-ios-cog': 'gearshape',
    'ion-ios-copy': 'doc.on.doc', 'ion-ios-link': 'link', 'ion-ios-musical-note': 'music.note', 'ion-ios-musical-notes': 'music.note.list',
    'ion-musical-notes': 'music.note.list', 'ion-ios-radio': 'dot.radiowaves.left.and.right', 'ion-ios-information-circle-outline': 'info.circle',
    'ion-ios-folder': 'folder', 'ion-ios-cloud-download': 'icloud.and.arrow.down', 'ion-ios-checkmark': 'checkmark', 'ion-checkmark-circle': 'checkmark.circle',
    'ion-ios-thumbs-up': 'hand.thumbsup', 'ion-ios-thumbs-down': 'hand.thumbsdown', 'ion-ios-infinite': 'infinity', 'ion-infinite': 'infinity',
    'ion-ios-eye': 'eye', 'ion-ios-lock': 'lock', 'ion-ios-unlock': 'lock.open', 'ion-ios-mail': 'envelope', 'ion-ios-warning': 'exclamationmark.triangle',
    'ion-warning': 'exclamationmark.triangle', 'ion-ios-reorder': 'line.3.horizontal', 'ion-ios-undo': 'arrow.uturn.backward',
    'ion-ios-color-wand': 'wand.and.stars', 'ion-grid': 'square.grid.2x2', 'ion-sync': 'arrow.triangle.2.circlepath', 'ion-notifications': 'bell',
    'ion-ios-notifications-off': 'bell.slash', 'ion-logo-apple': 'applelogo', 'ion-ios-book': 'book', 'ion-ios-bulb': 'lightbulb', 'ion-ios-camera': 'camera',
}
NUCLEO_PT = 20      # rendered size; the mask is scaled into Cider's own icon box (16-20px)
NUCLEO_SCALE = 2    # 2x is what a Retina display needs for that box
NUCLEO_PAD = 1.18   # square canvas = max(pt * pad, glyph): keeps optical size consistent across symbols


# ---------------------------------------------------------------------------------------------------------------- symbols
def spec_entries():
    out = []
    for group, table in (('side', SIDEBAR), ('player', PLAYER)):
        for key, v in table.items():
            out.append({'key': f'{group}:{key}', 'name': v[0], 'pt': v[1], 'weight': v[2] if len(v) > 2 else 'regular', 'mode': 'natural',
                        **({'bundle': v[3]} if len(v) > 3 else {})})
    for name in sorted(set(NUCLEO.values()) | set(QICON.values())):
        out.append({'key': f'sym:{name}', 'name': name, 'pt': NUCLEO_PT, 'weight': 'regular', 'mode': 'square', 'pad': NUCLEO_PAD, 'scale': NUCLEO_SCALE})
    return out


def render():
    BUILD.mkdir(exist_ok=True)
    exe = BUILD / 'sfgen'
    if not exe.exists() or exe.stat().st_mtime < (SF_DIR / 'sfgen.swift').stat().st_mtime:
        subprocess.run(['swiftc', '-O', str(SF_DIR / 'sfgen.swift'), '-o', str(exe)], check=True, capture_output=True)
    spec = BUILD / 'spec.json'
    spec.write_text(json.dumps(spec_entries()))
    result = BUILD / 'out.json'
    subprocess.run([str(exe), str(spec), str(result)], check=True)
    return json.loads(result.read_text())


def glyph_map(data, group):
    rows = [f"  {json.dumps(k.split(':', 1)[1])}: {{ u: {json.dumps(v['uri'])}, w: {v['w']}, h: {v['h']} }},"
            for k, v in sorted(data.items()) if k.startswith(group + ':')]
    return '{\n' + '\n'.join(rows) + '\n}'


def sf_module(data):
    return ("// GENERATED by tools/build.py - do not edit. SF Symbols rendered from this Mac as alpha masks (size = the symbol's box in pt).\n"
            f"export const SIDE = {glyph_map(data, 'side')};\n"
            f"export const PLAYER = {glyph_map(data, 'player')};\n"
            "// Quasar icon names the icons stylesheet can draw as SF Symbols.\n"
            f"export const SF_QICONS = new Set({json.dumps(sorted(QICON))});\n"
            "// CSS for a shadow root: `.sf` paints currentColor through the glyph mask.\n"
            "export const sfCss = (map) => '.sf{display:inline-block;flex:none;background-color:currentColor;-webkit-mask:var(--m) center/100% 100% no-repeat}'\n"
            "  + Object.entries(map).map(([k, v]) => `.sf-${k}{--m:url(${v.u})}`).join('');\n"
            "export const sfTag = (map, k) => { const v = map[k]; return v ? `<i class=\"sf sf-${k}\" style=\"width:${v.w}px;height:${v.h}px\" aria-hidden=\"true\"></i>` : ''; };\n")


def icons_css(data):
    """One rule per symbol (each image appears once), selectors grouped with :is()."""
    by_symbol = {}
    for key, name in NUCLEO.items():
        by_symbol.setdefault(name, [[], []])[0].append(key)
    for key, name in QICON.items():
        by_symbol.setdefault(name, [[], []])[1].append(key)
    nucleo_all = ','.join(f'[data-icon-name="{k}"]' for k in sorted(NUCLEO))
    lines = ["/* GENERATED by tools/build.py - Cider's icons drawn as SF Symbols from this Mac.",
             "   nucleo icons: <div class=nucleo-icon data-icon-name=x><svg class=_svg-icon>; Quasar icons get data-sf from the icons module. */",
             f'.nucleo-icon:is({nucleo_all}) > svg._svg-icon {{ background-color: currentColor; -webkit-mask-position: center; -webkit-mask-size: contain; -webkit-mask-repeat: no-repeat; }}',
             f'.nucleo-icon:is({nucleo_all}) > svg._svg-icon > * {{ display: none; }}',
             '.q-icon[data-sf] { position: relative; -webkit-text-fill-color: transparent; }',
             '.q-icon[data-sf]::before { content: ""; position: absolute; inset: 0; background-color: currentColor; -webkit-text-fill-color: initial;'
             ' -webkit-mask-position: center; -webkit-mask-size: contain; -webkit-mask-repeat: no-repeat; }']
    for name, (nucleo, qicon) in sorted(by_symbol.items()):
        uri = data['sym:' + name]['uri']
        sels = []
        if nucleo: sels.append('.nucleo-icon:is(' + ','.join(f'[data-icon-name="{k}"]' for k in sorted(nucleo)) + ') > svg._svg-icon')
        if qicon: sels.append('.q-icon:is(' + ','.join(f'[data-sf="{k}"]' for k in sorted(qicon)) + ')::before')
        lines.append(f"{', '.join(sels)} {{ -webkit-mask-image: url({uri}); }}")
    return '\n'.join(lines) + '\n'


# ---------------------------------------------------------------------------------------------------------------- styles
def strip_comments(css):
    return re.sub(r'/\*.*?\*/', '', css, flags=re.S)


def split_top(text, sep):
    """Split on `sep` outside strings and parentheses."""
    out, buf, depth, quote = [], [], 0, None
    for ch in text:
        if quote:
            buf.append(ch); quote = None if ch == quote else quote; continue
        if ch in '"\'': quote = ch
        elif ch == '(': depth += 1
        elif ch == ')': depth -= 1
        elif ch == sep and depth == 0:
            out.append(''.join(buf)); buf = []; continue
        buf.append(ch)
    out.append(''.join(buf))
    return out


def find_block_end(css, start):
    """Index of the '}' closing the block whose '{' is at css[start]."""
    depth, quote, paren = 0, None, 0
    for i in range(start, len(css)):
        ch = css[i]
        if quote:
            if ch == quote: quote = None
            continue
        if ch in '"\'': quote = ch
        elif ch == '(': paren += 1
        elif ch == ')': paren -= 1
        elif paren == 0 and ch == '{': depth += 1
        elif paren == 0 and ch == '}':
            depth -= 1
            if depth == 0: return i
    raise ValueError('unbalanced braces near: ' + css[start:start + 80])


def important(decls):
    out = []
    for d in split_top(decls, ';'):
        d = d.strip()
        if not d: continue
        if ':' not in d: raise ValueError('not a declaration: ' + d[:80])
        out.append(d if d.endswith('!important') else d + ' !important')
    return ';'.join(out)


def compile_css(css):
    """Statements -> minified CSS with !important declarations (keyframes left alone)."""
    css, out, i = strip_comments(css), [], 0
    while True:
        j = css.find('{', i)
        if j < 0:
            if css[i:].strip(): raise ValueError('trailing text: ' + css[i:i + 80])
            break
        prelude = ' '.join(css[i:j].split())
        end = find_block_end(css, j)
        inner = css[j + 1:end]
        if prelude.startswith('@keyframes'): body = ' '.join(inner.split())
        elif prelude.startswith(('@media', '@supports', '@layer', '@container')): body = compile_css(inner)
        else: body = important(' '.join(inner.split()))
        out.append(f'{prelude}{{{body}}}')
        i = end + 1
    return ''.join(out)


def main():
    data = render()
    (PLUGIN / 'sf.js').write_text(sf_module(data))
    (PLUGIN / 'css' / 'icons.css').write_text(icons_css(data))
    styles = {p.stem: compile_css(p.read_text()) for p in sorted((PLUGIN / 'css').glob('*.css'))}
    js = ('// GENERATED by tools/build.py from css/*.css - do not edit. One string per part; declarations made !important.\n'
          'export const STYLES = {\n' + ''.join(f'  {json.dumps(k)}: {json.dumps(v)},\n' for k, v in styles.items()) + '};\n')
    (PLUGIN / 'styles.js').write_text(js)
    kb = {k: round(len(v) / 1024, 1) for k, v in styles.items()}
    print(f"glyphs: {len(data)}  styles (KB): {kb}")


if __name__ == '__main__':
    main()
