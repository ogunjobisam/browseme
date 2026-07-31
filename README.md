# BrowseMe

A desktop browser built on Chromium. It keeps Chrome's layout, adds Brave-style
blocking that is on by default, turns incognito into a switch instead of a
second window, and ships an n8n-style automation editor that can drive the
browser itself.

```bash
npm install
npm start
```

## What's different

### Ad and tracker blocking that is actually built in

Blocking is a first-class part of the browser, not an extension you add later.

A filter engine in the main process parses Adblock Plus syntax — `||domain^`
anchors, wildcards, separators, regex rules, `$script,third-party,domain=…`
options, `@@` exceptions and `##` element hiding — and sits on Chromium's
request pipeline. A bundled list means blocking works on first launch and
offline; EasyList, EasyPrivacy, uBlock's lists and Peter Lowe's list download
in the background and refresh every few days.

Matching a hundred thousand rules on every request would stall page loads, so
every rule is filed under one token drawn from its pattern. A request only
tests the rules filed under a token its URL actually contains, which turns a
full scan into a few dozen regex tests.

Element hiding uses the same trick in reverse: rather than injecting tens of
thousands of generic selectors into every page, the content script surveys the
class names and ids the document actually uses and asks for only the rules that
could match.

The shield button in the toolbar shows what was blocked on the current page and
lets you turn any of it off for that site alone. Alongside blocking, Shields
also upgrades page loads to HTTPS, drops third-party `Set-Cookie` headers, and
trims cross-site referrers to their origin.

Payment providers, captchas and sign-in flows are explicitly allowlisted —
blocking those is how ad blockers get themselves uninstalled.

### Incognito is a switch, not another window

Private browsing is a toolbar toggle. Flip it and the browser changes colour,
your normal tabs are set aside — still loaded, still playing audio — and you
get a private tab strip. Flip it back and your normal tabs return exactly as
you left them.

The two modes run in genuinely separate sessions. Private mode uses an
in-memory partition, records nothing to history, never persists a permission
grant, keeps downloads out of the download list, and never sends what you type
to a search suggestion service. Turning the switch off destroys that session
and increments a generation counter, so the next private tab starts from an
empty one rather than a cleared one.

### Video search with a display worth the name

`browseme://video` searches without an API key by trying Piped, then Invidious,
then falling back to parsing YouTube's own results page. Results render as
tiles starting at 420px wide, with an extra-large and a list layout.

Selecting a result opens a theater player sized to your window above the grid,
so you can keep scanning results while something plays, rather than being
navigated away into a small embedded box.

`Alt+T` promotes the largest video on *any* site to fill the viewport, with the
page dimmed behind it. Escape puts it back.

### Extensions

Load Chrome extensions from an unpacked folder, a `.zip`, or a `.crx` — CRX2
and CRX3 headers are stripped and the archive unpacked in-process, with
zip-slip paths refused. Extensions persist across restarts, can be
enabled and disabled individually, and are off in private mode unless you
explicitly allow one there.

Manifest V2 and V3 both load. Electron does not implement every newer Chrome
extension API, so an extension leaning on one will load but misbehave.

### Flows — automation in the browser

`browseme://flows` is a node-graph editor. Pick a trigger, wire actions after
it, configure each node, and run it.

Triggers fire on page load (URL substring or regex), on a timer, at browser
start, manually, or when Shields blocks past a threshold on a page. Actions
open tabs, wait for elements, extract text or attributes, click, type, screenshot,
call HTTP APIs, filter, branch, deduplicate, notify, and append to JSON/CSV
files. Any text field takes `{{ item.field }}` templates.

Execution is a topological walk over the subgraph reachable from the trigger.
Each node runs at most once and receives everything delivered on its incoming
edges; a node whose inputs all arrived empty is skipped, which is what makes
`If` branches behave — the untaken branch simply never runs. Cycles are
reported rather than hung on.

## Keyboard

| | |
|---|---|
| `Ctrl+T` / `Ctrl+W` | new tab / close tab |
| `Ctrl+Shift+N` | toggle private mode |
| `Ctrl+L` | focus the address bar |
| `Ctrl+F` | find in page |
| `Ctrl+D` | bookmark |
| `Ctrl+Tab` | next tab |
| `Ctrl+1…9` | jump to tab |
| `Alt+T` | theater mode for the video on the page |
| `Ctrl+Y` / `Ctrl+J` | history / downloads |
| `Ctrl+,` | settings |

## Internal pages

`browseme://newtab`, `video`, `flows`, `extensions`, `shields`, `settings`,
`history`, `bookmarks`, `downloads`

## Architecture

```
src/main/
  index.js            app entry; wires everything together
  tabs.js             WebContentsView tab manager, modes, navigation
  sessions.js         normal vs private partitions, permissions, user agent
  shields/
    parser.js         Adblock Plus syntax -> rule objects
    engine.js         token-indexed matcher + cosmetic rule storage
    lists.js          filter list catalog and on-disk cache
    index.js          per-site settings, request filters, per-tab counters
    lists/base.txt    bundled offline seed list
  automation/
    nodes.js          node catalog: metadata + execute functions
    engine.js         DAG executor (no Electron dependency)
    runtime.js        storage, triggers, browser-facing node implementations
  extensions.js       install / enable / remove Chrome extensions
  unzip.js            minimal ZIP + CRX reader
  protocol.js         the browseme:// scheme
  ipc.js              one channel, one route table, one authorisation check
  overlay.js          transparent view for surfaces that draw over pages
src/preload/
  browser.js          the one preload; what a renderer gets is gated by
                      whether it is a trusted surface, an internal page,
                      or a website
src/renderer/
  chrome.*            tab strip and toolbar
  overlay.*           omnibox suggestions, Shields panel, permission prompts
  internal/           the browseme:// pages
```

Two design notes worth knowing before changing things:

**Page views stack above the browser chrome.** Anything the chrome needs to
draw *over* a page cannot live in the chrome document, which is why there is a
separate transparent overlay view. It is hidden — and therefore
click-through — whenever nothing is open.

**Custom schemes are per-session.** `protocol.handle` only binds the default
session, and every tab runs in a named partition, so the `browseme://` handler
is registered per session as each one is created.

**There is one preload file, deliberately.** Sandboxed preloads cannot
`require` local modules, so splitting it would mean giving up the sandbox or
adding a bundler. Instead it is one file whose sections are gated: the IPC
bridge is exposed only to the chrome window, the overlay, and `browseme://`
documents; cosmetic filtering and theater mode only run on `http(s)` pages.

## Security

- Renderers run sandboxed with context isolation and no Node integration.
- The IPC bridge forwards a route name and a payload, nothing else.
  Authorisation happens in the main process by checking the sender: the
  browser's own UI may call anything, `browseme://` pages get a fixed subset,
  and ordinary web pages get nothing.
- Web content cannot spawn a `<webview>`; certificate errors are never
  auto-accepted; non-`http(s)` navigations are handed to the OS rather than
  followed.
- Archive extraction refuses entries that would escape the destination.
- The user agent is plain Chrome — advertising the framework both breaks sites
  and adds a fingerprinting bit.

## Tests

```bash
npm test
```

57 unit tests covering the filter parser and matcher, public-suffix and
third-party logic, cosmetic surveying, the workflow engine (branching,
failure handling, cycles, cancellation), template resolution, ZIP/CRX
extraction, the settings store, and omnibox URL-versus-search handling.

The engines take their side effects by injection — the workflow engine gets its
browser bindings, the filter list store gets its fetch — so both are tested
without launching Electron.
