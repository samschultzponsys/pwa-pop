# Changelog

All notable changes to WebRoost (called PWA Pop up to 4.0) are listed here.

Versions are `MAJOR.MINOR`: each release adds one to the minor number, and
after `.9` it rolls over to the next major (1.8 → 1.9 → 2.0). Every version
has a GitHub release with all the Linux packages attached, and the version
is in every file name (e.g. `pwa-pop-1.0-x86_64.rpm`).

## [Unreleased]

## [4.9] - 2026-11-11

### Fixed
- **"Sign in with Google" failed with "Couldn't sign you in: this browser or
  app may not be secure".** Google blocks sign-in from Chromium-based
  embedded browsers. On Google's account pages only, WebRoost now presents
  itself as a current Firefox: in the request headers, without Chrome's
  client-hint headers, and in the page's own `navigator`. Every other site,
  including the app itself after sign-in, is unchanged.

## [4.8] - 2026-11-11

### Changed
- **Minimize to the tray is on by default for new apps**, whether added in the
  manager, duplicated from one that has it, or added with `webroost --add`.
  Existing apps keep their setting.
- README brought up to date: minimize-to-tray on KDE, quieter new-mail
  popups, a version-independent update command, and step-by-step second
  accounts.

## [4.7] - 2026-11-11

### Changed
- **New-mail popups no longer show the unread total** ("4,295 unread"). Tick
  *Add the unread total to these popups* (`notify_show_unread_total`) to get
  it back.

### Added
- *Only pop up when the new message can be shown*
  (`notify_only_with_message`). It skips the plain "New message" popups that
  appear when the count goes up but no new message reaches the top of the
  inbox list (mail filed by a rule into another folder, something marked
  unread again…).

## [4.6] - 2026-11-11

### Fixed
- **Minimize to the tray on KDE Plasma.** KWin handles the minimize button
  itself and tells the app nothing, so nothing in the app could notice.
  WebRoost now loads a small KWin script over D-Bus:
  - when an app with *Minimize to the tray* is minimized, its window leaves
    the taskbar; restoring it brings it back;
  - clicking the tray icon brings the window back, reopening it if KWin won't
    raise it;
  - changing the setting updates the script with no restart.

  The Flatpak may talk to `org.kde.KWin` for this.
- **ConnectWise hid itself to the tray when changing screens.** A page that
  is unloading reports "hidden", which looked like a minimize. KDE no longer
  guesses from page visibility at all. Elsewhere a guess needs the window to
  have lost focus too, and pages that are navigating away are ignored.
- **Phone links from Chrome and other apps opened KDE Connect instead of the
  phone app.**
  - Inside the Flatpak, the default could never be saved:
    `~/.config/mimeapps.list` was written through a temporary file next to
    it, which the sandbox doesn't allow. It's now written in place.
  - KDE's own `kde-mimeapps.list`, which takes priority, is updated too.
  - The phone app claims the tel:/callto:/sip: default again each time it
    starts.

## [4.5] - 2026-11-11

### Fixed
- **Apps with "Minimize to the tray" still showed no window in 4.4**, and
  clicking their tray icon minimized and restored every window on the
  desktop. Running these apps under XWayland (since 3.9) doesn't work on
  every system, so they now stay on native Wayland like all other apps.
  Minimizing to the tray there relies on the page being reported as hidden.
  For these apps WebRoost no longer turns off Chromium's hidden-window
  detection, which was what stopped later minimizes from being noticed. This
  is best effort: if a minimize isn't noticed, the window simply stays on
  the taskbar.
- XWayland is still available, opt-in, with `WEBROOST_XWAYLAND=1`.
- **Click-to-call presses Call more reliably.** The call button now gets a
  real mouse click at its position (scrolled into view first) instead of a
  scripted click, which some web dialers ignore. Without a known call button,
  Enter is still pressed in the number field.

## [4.4] - 2026-11-11

### Fixed
- **Apps with "Minimize to the tray" crashed on start (no window, tray icon
  only).** Under XWayland, Chromium's GPU (drawing) process segfaulted inside
  the Flatpak with the system's graphics driver, so the window could never be
  drawn. Apps running under XWayland now draw in software. If the GPU process
  still crashes twice within a minute, the app remembers XWayland doesn't
  work on this machine, restarts on native Wayland and says so in a
  notification.

## [4.3] - 2026-11-11

### Changed
- **License: Apache 2.0** (was MIT). It's still free to use, change and
  share, commercially too. Anyone who redistributes WebRoost or a work based
  on it must now include the `NOTICE` file crediting the original project, and
  mark the files they changed. Releases up to 4.2 stay under MIT.
- `LICENSE` and `NOTICE` ship inside every package (and the Flatpak's
  `share/licenses`).
- The README has a "Name and logo" note asking forks to use their own name
  and icon. The manager's footer credits the author, with a link to the
  project.

### Fixed
- The README's logo comes from a new file name, so GitHub's image cache can't
  keep showing the old icon.

## [4.2] - 2026-11-11

### Added
- **New icon:** a birdhouse, home for your web apps, with its resident peeking
  out. There's a simplified version for 16–32 px so it stays clear in the tray
  and menus.
- **Welcome banner after moving from PWA Pop.** It says how many apps (with
  icons and logins) were brought over, and has a Copy button for the command
  that removes the old PWA Pop Flatpak.

### Changed
- README rewritten for WebRoost: screenshots, what it's for, the features as
  they are today, a step-by-step move from PWA Pop, and the settings table
  folded away.
- The Memory view's savings line reads "A, B and C" rather than "A, B, C".

## [4.1] - 2026-11-11

### Changed
- **PWA Pop is now WebRoost**, with one name everywhere:
  - the app;
  - the `webroost` command;
  - `~/.config/webroost`;
  - the Flatpak `io.github.samschultzponsys.WebRoost`;
  - `webroost-<version>-…` packages;
  - desktop entries and `WEBROOST_*` settings;
  - the repository `samschultzponsys/webroost`.

  The new tagline is "Any website, roosting in your tray".

### Added
- **Automatic move-over from PWA Pop** on first start:
  - `~/.config/webtray` is copied, with apps, icons, window state and the
    apps' logins. Chromium lock files are left behind, and apps starting
    together wait for one copy.
  - Icon paths are updated.
  - Old menu and autostart entries (`webtray-<id>`,
    `io.github.samschultzponsys.PwaPop.<id>`) are replaced with WebRoost
    ones, so PWA Pop no longer autostarts.
  - The tel:/sip: default handler moves over.
- **Compatibility:**
  - The `webtray` command still works: an alias in every package.
  - `WEBTRAY_*` environment settings still work.
  - `.pwapop` export files still import.
  - rpm/deb/pacman packages replace the old `pwa-pop` package.

## [4.0] - 2026-11-11

Rolls over from 3.9 under the MAJOR.MINOR scheme. Never published: the release
could not be tagged after 4.1 was pushed during its build. Its changes ship in 4.1.

### Added
- **Memory view** in the manager (header button, or click an app's RAM
  badge). For each running app it shows:
  - memory now, split into browser core and pages
  - a 6-hour graph with the memory limit marked
  - the 6-hour peak
  - a per-process list

  Totals cover all running apps. The view also estimates the savings if the
  apps shared one browser core, keeping the phone app separate. It refreshes
  every 15 s while open.
- Memory is measured as PSS (shared memory split fairly), so per-app numbers
  no longer count Chromium's shared libraries several times. Processes in
  another PID namespace (Flatpak sandboxes) are checked before /proc is
  trusted, with the working set as the fallback.

## [3.9] - 2026-11-10

### Fixed
- **Minimize to the tray on KDE Wayland.** Diagnostics showed KWin handles
  the minimize button itself and tells the app nothing except that it lost
  focus, so minimizing went to the taskbar (after the first time, at best).
  Apps with *Minimize to the tray* now run under XWayland, where every
  minimize is reported. Ticking or unticking the option restarts the app to
  switch. `WEBTRAY_NATIVE_WAYLAND=1` keeps the app on native Wayland.

### Changed
- The Flatpak now has full X11 (XWayland) access (`--socket=x11`) instead
  of X11 only as a fallback, which the fix above needs.

## [3.8] - 2026-11-10

### Changed
- **Tidier new-mail popups.** The sender is the title, with the subject and
  preview on separate lines below. Outlook writes them on one line, so 3.7
  ran them together with the time ("Sam Schultz Let's hope 4:29 PM To god").
  The pieces are now read from their own elements, and the time is dropped.
- Popup titles no longer repeat the app name ("Outlook: …"); the popup header
  already shows the app's name and icon.
- Save diagnostics… no longer sends its own test popup.

## [3.7] - 2026-11-10

### Fixed
- **Popups on KDE Plasma (Flatpak).** Notifications reached Plasma's history
  but never popped up. Tests showed Plasma accepts the same notification from
  any process except the app's own and the processes it starts. PWA Pop now
  sends popups from a small helper (plain Node, no browser engine) that the
  Flatpak portal starts. Popups keep each app's own name and icon (Outlook,
  Linkus…), and clicking one still opens the app and reaches the page. If the
  helper can't run, Electron's notifications are used as before;
  `WEBTRAY_NOTIFY=electron` forces that.
- Diagnostics say which way notifications are sent.

## [3.6] - 2026-11-10

### Added
- **Stay signed in across restarts, updates and reboots** (on by default,
  per-app checkbox). Single sign-on logins such as ConnectWise's OIDC are
  often only kept in session cookies, which are thrown away whenever the app
  closes, so every update signed you out. PWA Pop now keeps them for 14 days,
  like Chrome's "continue where you left off". They are saved every few
  minutes and before a restart. Untick it, or set
  `forget_session_cookies: true`, for the old behaviour.

## [3.5] - 2026-11-10

### Added
- **Save diagnostics…** now checks the desktop's notification service. It
  records which server answers and whether Do Not Disturb is on, and sends
  one popup straight to the service, bypassing Electron. That tells "PWA Pop
  isn't sending" apart from "the desktop isn't showing" (KDE turns on Do Not
  Disturb by itself while a full-screen app is focused or screens are
  mirrored).

## [3.4] - 2026-11-10

### Fixed
- **New-mail popups show the sender and subject.** In 3.3 the popup said
  "1 new item": Outlook's badge moves a few seconds before the new message
  appears in the list. PWA Pop now waits up to about 10 seconds for a newer
  unread message at the top of the list. It never reuses one it has already
  seen, so with thousands of unread mails it won't show an older message.
  If none appears, the popup says "New message" with the unread total.

## [3.3] - 2026-11-10

### Fixed
- **Outlook new-mail popups**, based on a diagnostics file from 3.2:
  - Unread counts with thousands separators were misread: "4,270 unread"
    became 270.
  - Every source of the count can now trigger the popup, not only the one
    shown on the icon. Outlook's app badge counts new mail and moves even
    when the folder count doesn't. Sources rising together give one popup.
  - Apps with *Notify when the unread count goes up* now always look visible
    to the page, as a desktop mail client would. Outlook keeps updating its
    mail list and counts while hidden in the tray, instead of pausing.
    Minimize to the tray still sees the real window state.
  - `setAppBadge()` without a number (a "something new" flag) counts as new
    mail.
- Diagnostics now note the unread counts every 5 minutes, so they show
  whether the page kept updating while in the tray.

## [3.2] - 2026-11-10

### Changed
- **Pop-up windows open at a usable size.** A site's own pop-ups, such as
  ConnectWise's *Time Entry*, used to open at the narrow size the site asked
  for. They now open at most of the app window's size and centred over it.
  Resize one and the next opens at that size, remembered per app. Sign-in
  pop-ups keep their small size.

### Fixed
- Release builds no longer fail (and send failure emails) when GitHub Pages
  isn't enabled for the repository. The Flatpak repository site is skipped
  instead.
- Release builds delete their temporary package copies once the release is
  published, so they don't fill the account's Actions storage.

## [3.1] - 2026-11-09

### Added
- **Export and import.** *Export…* in the manager saves all apps, with their
  settings and icons, to one `.pwapop` file. *Import…* on another computer adds
  them, along with their menu and autostart entries. You choose whether apps
  that already exist are replaced. Logins are not included.
- **Save diagnostics…** in each app's tray menu writes a text file to
  Downloads with the app's settings, unread-count sources and a recent log. No
  terminal or `WEBTRAY_DEBUG` is needed.

### Fixed
- **New-mail popups in Outlook.** Once a site had called `setAppBadge` (the new
  Outlook does at start-up), PWA Pop stopped reading the page's unread count.
  Later updates to the badge only arrive through web push, which Electron
  doesn't have, so the count froze and new mail never notified. Every source
  (Inbox folder count, app badge, title, unread rows in the inbox) is now read
  all the time. The most precise one drives the count and the popup, and the
  first value from each source is only a baseline.
- The Inbox count is also read when Outlook's folder list shows it as plain
  text, or as no number at all when nothing is unread. With the folder pane
  collapsed, the unread rows at the top of the inbox are used instead.

## [3.0] - 2026-11-06

Rolls over from 2.9 under the MAJOR.MINOR scheme.

### Added
- **The whole of PWA Pop switches over after an update.** The manager window
  now reopens on the new version too, like the apps. It waits while an edit
  form or the update guide is open, so nothing unsaved is lost.

## [2.9] - 2026-11-06

### Added
- `WEBTRAY_DEBUG=1` also logs window minimize/restore/focus events and page
  visibility changes, to diagnose "Minimize to the tray" on KDE Wayland
  (the first minimize is caught, later ones are not).

## [2.8] - 2026-11-06

### Added
- **"Send test notification"** in every app's tray menu, to check that
  PWA Pop's popups reach the desktop.
- More detail with `WEBTRAY_DEBUG=1`: version and key settings at start, where
  the unread count comes from (app badge, page title or folder list), every
  change in the count, and every notification shown, skipped or failed.

### Changed
- The manager checks which apps are running every 10 seconds, and only while
  its window is focused. This avoids filling app logs with "Invalid socket
  message" lines.

## [2.7] - 2026-11-06

### Added
- **New-mail notifications show the message.** When the unread count goes up,
  the notification shows the newest unread item from the page's message list:
  the sender as the title, then the subject and preview (e.g. "Outlook:
  Melissa Waugh — Fwd: Order Confirmation…"). If the list isn't showing, for
  example when another folder is open, it falls back to the count.

## [2.6] - 2026-11-06

### Fixed
- **Settings apply to running apps.** Changes saved in the manager (or in
  apps.yaml) reach a running app within a few seconds. Before, they only took
  effect after quitting and reopening the app, so new options like "Minimize
  to the tray" or "Notify when the unread count goes up" seemed to do nothing.
- **Outlook unread notifications:** when a site sets neither an app badge nor
  a "(3)" title, PWA Pop reads the count from the page's folder list (e.g. the
  new Outlook's "Inbox, 3 unread"). Counts seen while the app is starting up
  are the baseline, so you're only notified about mail that arrives after
  that.
- **Minimize to the tray on KDE Wayland:** KDE handles the minimize button
  itself and the app was never told. The page now reports when it stops being
  visible while its window is open, and the app goes to the tray. (Switching
  to another virtual desktop can do the same for apps with this option on;
  click the tray icon to bring it back.)
- The manager's checkbox labels no longer break into columns around
  `tel:`, `callto:` and `sip:`.

## [2.5] - 2026-11-06

### Added
- **Apps restart themselves after an update.** Every PWA Pop process records
  its version when it starts. Older running apps see that and restart onto the
  new version at a quiet moment: not during a call, and not while you're using
  the window. Hidden apps stay hidden. Until then, the tray menu shows
  "Restart to finish updating". The update commands in "How to update" (and
  the Install update button) end with the new `webtray --restart-all`, so
  everything switches over right after updating.
- **Quit** button on running apps in the manager, and the cards' running
  state refreshes every few seconds.
- **Minimize to the tray** option (`minimize_to_tray`): the minimize button
  hides the app to its tray icon instead of the taskbar.

### Fixed
- Flatpak: the manager nearly always showed apps as running ("Show"), even
  after quitting. It compared process IDs from other sandboxes, where small
  PIDs always exist. It now checks the app's singleton socket instead.
- Flatpak: restarts (memory limit, updates) now start the newest installed
  version (`flatpak-spawn --latest-version`) rather than the running one.

## [2.4] - 2026-11-06

### Added
- **"Notify when the unread count goes up"** (`notify_on_unread`). The new
  Outlook sends its desktop notifications only through Chrome's web push
  service, which no Electron app can use, so it never asks PWA Pop to show
  anything. With this option, PWA Pop shows a normal, self-dismissing
  notification whenever the unread count rises (e.g. "Outlook: 1 new item",
  "4 unread"). It stays quiet if the site sent its own notification just
  before. Ticked automatically when you add Outlook.
- Unread counts now also come from the **app badge API**
  (`navigator.setAppBadge`, from the page or its service worker), which is
  what the new Outlook uses. Pages also see themselves as an installed app
  (`display-mode: standalone`), like in Chrome, so they turn on their
  installed-app features.

## [2.3] - 2026-11-06

### Fixed
- **Company sign-in (OIDC/SAML/SSO) stays inside the app.** Logging in through
  an identity provider that wasn't in `allowed_origins` (e.g. ConnectWise
  with an OIDC provider) opened the browser, and the app never got the login.
  Pages that look like sign-in (OAuth/OIDC/SAML parameters, `/authorize`,
  `/login`, `/sso`, Microsoft, Google, Okta, Duo, ConnectWise SSO…) now load
  in the app window, as does every further step of the flow (MFA, consent)
  until it returns to the app. Sign-in popups open as app windows. Ordinary
  links still open in the browser.
- Notifications raised from embedded frames now go through PWA Pop's bridge
  too. Before, they could be dropped, along with "Pop the window up" and
  urgency for them.

## [2.2] - 2026-11-06

### Added
- **"How to update" shows a ready-to-paste terminal command** for your
  install type. It downloads the exact package (e.g.
  `pwa-pop-2.2-x86_64.flatpak` for Flatpak, the `.rpm` for Fedora), checks it
  against the release's `SHA256SUMS.txt`, then installs it with the right
  tool (flatpak, dnf/zypper/rpm, apt, pacman, or unpacks the tar.gz). The
  README lists the same commands.
- "Send all keyboard shortcuts to the page" option (`pass_shortcuts`) for
  remote desktop tools such as MeshCentral and web terminals. Ctrl+W, Ctrl+R,
  F5, F12 and Alt+arrows then go to the remote session instead of hiding or
  reloading the app.
- Ready-made sign-in origins for ConnectWise (`*.myconnectwise.net`,
  `*.connectwise.com`) and for Teams' new address `teams.cloud.microsoft`.
  Without them, Teams would bounce to the browser after sign-in.

## [2.1] - 2026-11-06

### Fixed
- Flatpak: with both the old `master` branch (1.0–1.1 bundles) and the new
  `stable` branch installed, menu and autostart entries could start the old
  version, so fixes like the per-app taskbar icon never showed up. Entries
  now run `flatpak run --branch=<the branch that wrote them>`, and existing
  entries are rewritten on start. To remove a leftover old copy:
  `flatpak uninstall --user io.github.samschultzponsys.PwaPop//master`.

## [2.0] - 2026-11-06

### Added
- **Primary phone app.** The click-to-call setting is now "Primary phone
  app", and only one app can have it. Ticking it on one app removes it from
  any other app and moves the system's default for phone links. The phone app
  gets a "phone app" badge in the manager.

### Fixed
- The manager's edit form could silently refuse to save when a value in
  apps.yaml was outside a field's range (e.g. a memory limit under 200 MB).
  It now shows an error message instead.

## [1.9] - 2026-11-06

### Added
- **Click-to-call.** Tick "Open phone links" on a softphone app (e.g. Linkus).
  PWA Pop registers it for `tel:`, `callto:` and `sip:` links and makes it the
  default, so clicking a phone icon in ConnectWise, a CRM or an email opens the
  app and **dials the number**. It shows the app, types the cleaned number
  (`+12059797522`) into the dialpad and presses call, like Yeastar's own Linkus
  browser extension.
- The dialpad is found automatically. If a softphone's layout isn't
  recognised, right-click its number field / call button / dialpad tab and
  choose **Use for click-to-call**. PWA Pop remembers it (`dial_input`,
  `dial_button`, `dial_open`). The same menu has a test that fills in a
  number without calling. If dialling fails, the number is copied to the
  clipboard and a notification explains what to do.

## [1.8] - 2026-11-06

### Added
- **Memory limit per app** (`memory_limit_mb`, or "Memory limit" in the
  manager). Every minute the app adds up the memory of all its processes. Over
  the limit, it reloads the page first (you stay signed in). If it's still over
  a couple of minutes later, it restarts the app, staying hidden in the tray if
  it was hidden. It never does this while audio is playing or played in the
  last minute (calls), or while you're typing or clicking in the window. A
  notification tells you when it happened.
- The manager shows each running app's current memory use on its card
  ("RAM 412 MB / 1.5 GB"), turning amber near the limit.

## [1.7] - 2026-11-06

### Fixed
- Flatpak: windows in the taskbar showed the PWA Pop icon instead of the app's
  own (Outlook, Linkus…). KDE only matches sandboxed windows to desktop
  entries whose name starts with the Flatpak's id. Each app's entry is now
  `io.github.samschultzponsys.PwaPop.<id>.desktop`, and its window uses that
  id. Existing menu and autostart entries are renamed automatically the next
  time the app or the manager starts. Re-pin any app you had pinned to the
  taskbar.

## [1.6] - 2026-11-06

### Added
- **"How to update" for your install.** The manager's footer shows how PWA Pop
  was installed (Flatpak, AppImage, RPM, Debian or Arch package, tar.gz,
  source). A "How to update" link opens step-by-step instructions for that
  install, with copy buttons for the terminal commands. When an update is
  available, the banner links to the same steps.
- Flatpak: the guide checks whether your Flatpak follows the PWA Pop Flatpak
  repository and whether that repository is online. Until it is, a
  **Download** button saves the new `.flatpak` to ~/Downloads (verified
  against the release checksums) and shows the install command.
- `webtray --check-update` prints the same install-specific steps.

## [1.5] - 2026-11-06

### Added
- **Duplicate** button on every app in the manager: makes a second copy of an
  app with its own login (separate profile), e.g. two Claude or two Outlook
  accounts. Copies get a unique ID (`claude-2`), a readable name
  ("Claude (2)"), their own icon colour and a numbered corner label. Adding a
  site you already have does the same automatically.
- Icon colour and corner label settings (`icon_color`, `icon_label`) for any app.
  They apply to the tray icon, window icon, menu entry and notifications.
- Icon picker: the manager now collects several icons from a site, prefers
  ones with a transparent background, lets you pick another, and has a
  **Remove background** button. Logos sitting on an opaque white plate (like
  Microsoft's) have the plate removed automatically.
- Apps whose icon was chosen automatically switch to the site's own icon after
  you sign in (`icon_auto`). This fixes Outlook showing a stand-in icon because
  its start page redirects to the Microsoft sign-in page.

### Fixed
- **Notifications from service workers now appear.** The new Outlook (and
  other modern web apps) post desktop notifications from their service worker,
  which Electron silently dropped: you heard Outlook's sound but saw no popup.
  A service-worker preload now routes them to native notifications, and
  clicking one opens the app and delivers `notificationclick` to the site.
- The unread badge is smaller and stays legible at tray size (one digit, or
  "9+"), instead of covering most of the icon.
- Blocked or failed notifications are logged (run with `WEBTRAY_DEBUG=1`).

## [1.4] - 2026-11-06

### Fixed
- The Flatpak was missing from the 1.3 release: the CI build stopped at
  "eu-strip not found". The Flatpak manifest no longer strips Electron's
  prebuilt binaries, and CI installs `elfutils` anyway.

## [1.3] - 2026-11-05

First published release since 1.0. It includes everything from 1.1 and 1.2
below: the fix for the Flatpak manager's "Open" crash, update checks and
self-update, and the Flatpak repository.

### Changed
- The update check picks the highest version among published releases instead
  of GitHub's "latest" flag, so publishing an older release late can't hide a
  newer one.
- CI installs packaging tools without recommended packages (faster builds).
- CI: releases are published by a separate job that tags the commit with git
  and then creates the release with `gh`. The 1.1 and 1.2 releases had failed
  with "Resource not accessible by integration" when the release action tried
  to create the tag itself. A manual "Run workflow" with `from_run` republishes
  packages from an earlier run without rebuilding.

## [1.2] - 2026-11-05

_Not published as separate packages (the release step failed in CI); these changes ship in 1.3._

### Added
- **Updates.** Every PWA Pop process checks GitHub Releases (shortly after start,
  then every 12 hours) and shows one notification per new version. The tray menu
  gets an "Update PWA Pop to x.y…" item, and the manager shows an update banner,
  a "Check now" button and a "Check for updates automatically" switch.
- **One-click install** for AppImage (the AppImage file is replaced) and for
  rpm / deb / pacman (installed with `pkexec` + dnf/zypper/rpm, apt or pacman,
  after your password). Every download is checked against the release's
  `SHA256SUMS.txt` before it is installed.
- **Flatpak repository** on GitHub Pages
  (`https://samschultzponsys.github.io/pwa-pop/`), with `.flatpakref` and
  `.flatpakrepo` files. Flatpak installs from it, or from a 1.2+ `.flatpak`
  bundle, update through KDE Discover / `flatpak update`. The repository is
  GPG-signed when the `FLATPAK_GPG_PRIVATE_KEY` secret is set.

## [1.1] - 2026-11-05

_Not published as separate packages (the release step failed in CI); these changes ship in 1.3._

### Fixed
- Flatpak: "Open" in the manager crashed with `spawn flatpak ENOENT`. Apps and
  the manager are now started in a new sandbox through the Flatpak portal
  (`flatpak-spawn`), so they keep running after the manager is closed.
- A failed launch now shows an error message instead of a crash dialog, and
  stray main-process errors are logged instead of stopping the app.
- The manager's "running" badge now works across Flatpak sandboxes (it checks
  the app's singleton socket instead of a PID from another namespace).
- `--no-sandbox` is passed on to apps started from the manager or tray.

## [1.0] - 2026-11-04

First release.

### Added
- One process per app (`webtray --app <id>`) with a single-instance lock per app;
  launching it again shows the existing window.
- Its own tray icon per app (StatusNotifierItem on KDE). Left-click shows or hides
  all of the app's windows. The right-click menu has Show/Hide, Reload, Mute
  notifications, Manage apps… and Quit.
- The close button and Ctrl+W hide to the tray. Quit only from the tray menu.
- A persistent login session per app (`persist:<id>`), with window size and
  position remembered per app.
- Background throttling disabled, plus Chromium switches so hidden windows keep
  ringing. The renderer reloads automatically if it crashes.
- Native freedesktop notifications for page and service-worker notifications.
  Clicking one shows and focuses the app. Optional urgent mode keeps call
  notifications on screen.
- Microphone, camera, notifications, clipboard and speaker selection granted
  automatically only on `allowed_origins`; everything else denied.
- WebHID: the configured headset (e.g. Yealink WH64, `vendorId: 0x6993`) is
  selected automatically, and the grant persists across restarts. A udev rule
  for common headset vendors comes with the rpm/deb/pacman packages.
- Navigation guard: allowed origins and sign-in redirects stay in the app;
  other links open in the default browser. OAuth popups open as child windows.
- Unread badge on the tray icon and taskbar entry from page titles such as "(3)".
- Wayland-native on KDE Plasma 6 (`--ozone-platform-hint=auto`,
  `WaylandWindowDecorations`).
- `webtray --install/--uninstall/--list/--add` CLI with menu and autostart entries.
- PWA Pop manager window: paste a URL to add an app. It reads the site's web app
  manifest for name, start URL and icon; you can detect connected headsets and
  toggle autostart / start hidden.
- Right-click menu with spell check, copy/paste and link handling. Zoom, reload
  and devtools shortcuts.
- Downloads go to ~/Downloads, with a notification when done.
- Packages: AppImage, rpm (installs to `/opt/webtray` + `/usr/bin/webtray`), deb,
  pacman, tar.gz and Flatpak.
