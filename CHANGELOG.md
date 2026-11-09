# Changelog

All notable changes to PWA Pop are listed here.

Versions are `MAJOR.MINOR`: each release adds one to the minor number, and
after `.9` it rolls over to the next major (1.8 → 1.9 → 2.0). Every version
has a GitHub release with all the Linux packages attached, and the version
is in every file name (e.g. `pwa-pop-1.0-x86_64.rpm`).

## [Unreleased]

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
