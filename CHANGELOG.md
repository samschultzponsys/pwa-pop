# Changelog

All notable changes to PWA Pop are listed here.

Versions are `MAJOR.MINOR`: each release adds one to the minor number, and
after `.9` it rolls over to the next major (1.8 → 1.9 → 2.0). Every version
has a GitHub release with all the Linux packages attached, and the version
is in every file name (e.g. `pwa-pop-1.0-x86_64.rpm`).

## [Unreleased]

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
