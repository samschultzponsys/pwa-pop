<p align="center"><img src="assets/icons/256x256.png" width="128" alt="PWA Pop icon"></p>

<h1 align="center">PWA Pop</h1>

<p align="center"><b>Web apps that live in your tray.</b><br>
Run Outlook, Claude, the Yeastar Linkus softphone or any other site as a real desktop app,
with its own window, tray icon, login, notifications, unread badge, autostart and headset buttons.</p>

<p align="center">Current version: <b>2.0</b> · <a href="CHANGELOG.md">Changelog</a> · <a href="https://github.com/samschultzponsys/pwa-pop/releases">Downloads</a> · <a href="TESTING.md">Test checklist</a></p>

---

PWA Pop (command: `webtray`) is a small Electron wrapper. It is built to fully
replace Chrome "installed PWAs" on Linux, especially **KDE Plasma 6 on Wayland**,
and it works on any desktop with a StatusNotifierItem / AppIndicator tray.

## Features

| | |
|---|---|
| **One process per app** | `webtray --app outlook`, with its own single-instance lock. Launching it again just shows the window. |
| **Tray icon per app** | Left-click shows or hides the app's windows. The right-click menu has Show, Reload, Mute notifications, Manage apps…, Quit. |
| **Close to tray** | The close button (and Ctrl+W) hides the window. Quit only from the tray. |
| **Always awake** | Background throttling is off and hidden windows aren't throttled, so calls ring while the app is hidden. |
| **Own login per app** | Persistent `persist:<id>` sessions, so logins survive restarts. |
| **Native notifications** | freedesktop/KDE notifications. Clicking one opens the app. Optional "urgent" mode for incoming calls, plus mute from the tray. |
| **Permissions** | Mic, camera, notifications, clipboard and speaker selection are granted automatically **only** for `allowed_origins`; everything else is denied. |
| **Headsets (WebHID)** | The configured headset (e.g. Yealink WH64) is selected automatically and stays granted, so answer, hang-up and mute buttons work. |
| **Links** | The app and its sign-in pages stay inside; other links open in your default browser. OAuth popups open as child windows. |
| **Unread badges** | "(3) Inbox" in the title puts a numbered badge on the tray icon and taskbar entry. |
| **Remembers windows** | Size and position per app. |
| **Wayland native** | `--ozone-platform-hint=auto` and `WaylandWindowDecorations`, with correct icons and taskbar grouping per app. |
| **Manager UI** | Paste any URL. PWA Pop reads the site's manifest for name, icon and start page, and can detect your headset. |
| **Autostart** | One checkbox (or `autostart: true`). Apps start hidden in the tray at login. |

## Install

Grab the files for the latest version from the
[Releases page](https://github.com/samschultzponsys/pwa-pop/releases). Every release
has all formats, with the version in each file name:

| Distro | Package | Install |
|---|---|---|
| Fedora, RHEL, Alma, openSUSE | `pwa-pop-<ver>-x86_64.rpm` | `sudo dnf install ./pwa-pop-<ver>-x86_64.rpm` |
| Debian, Ubuntu, Mint, Pop!_OS | `pwa-pop-<ver>-amd64.deb` | `sudo apt install ./pwa-pop-<ver>-amd64.deb` |
| Arch, Manjaro, EndeavourOS | `pwa-pop-<ver>-x64.pacman` | `sudo pacman -U pwa-pop-<ver>-x64.pacman` |
| Any distro, sandboxed | `pwa-pop-<ver>-x86_64.flatpak` | `flatpak install --user ./pwa-pop-<ver>-x86_64.flatpak` |
| Any distro, portable | `pwa-pop-<ver>-x86_64.AppImage` | `chmod +x pwa-pop-*.AppImage && ./pwa-pop-*.AppImage` |
| Manual | `pwa-pop-<ver>-x64.tar.gz` | extract anywhere, run `./webtray` |

The rpm/deb/pacman packages install to `/opt/webtray` and add `/usr/bin/webtray`,
a "PWA Pop" menu entry and the headset udev rule.

**Flatpak with automatic updates:** install from the PWA Pop Flatpak repository
instead of a downloaded file, and Discover / `flatpak update` keep it current:

```bash
flatpak install --user https://samschultzponsys.github.io/pwa-pop/pwa-pop.flatpakref
```

### Which one should I use?

**Use the native package (rpm/deb/pacman) if you rely on a USB headset.** It
installs the udev rule that lets your user open the headset over hidraw, with
nothing else to set up. The Flatpak and AppImage support headsets too, but you
have to install the rule yourself once:

```bash
curl -LO https://raw.githubusercontent.com/samschultzponsys/pwa-pop/main/build/70-webtray-hid.rules
```

```bash
sudo cp 70-webtray-hid.rules /usr/lib/udev/rules.d/ && sudo udevadm control --reload-rules && sudo udevadm trigger
```

Then replug the headset. The Flatpak is granted `--device=all` (hidraw +
webcams), the system tray, notifications, `~/.config/webtray`, the autostart
folder and `~/.local/share/applications`, so every feature works inside the sandbox.

> **Ubuntu 24.04+ AppImage note:** Ubuntu blocks unprivileged user namespaces,
> so Chromium's sandbox won't start from an AppImage. Use the `.deb` (it ships
> an AppArmor profile), or run the AppImage with `--no-sandbox`.

## Quick start

1. Open **PWA Pop** from your app menu (or run `webtray`).
2. Click **+ Add app**, paste an address such as `https://outlook.office.com/mail`
   and press **Fetch details**.
3. Tick *Start automatically when I log in* / *Start hidden in the tray* as you like, then **Save**.
4. The app appears in your menu as its own entry. Start it, sign in, done.

### "Should I use the PWA link?"

No. Paste the **normal address** of the site. If the site publishes a web app
manifest (Outlook, Claude and most modern apps do), PWA Pop reads its name,
start page and icon automatically. Chrome-only install links
(`chrome-extension://…`, `--app-id=…`) aren't needed and won't work. For sites
behind a login (such as an on-prem PBX), the manifest may be hidden. In that case
PWA Pop uses the page's favicon after your first sign-in, or you can pick an icon.

## Command line

```
webtray                          Open the PWA Pop manager
webtray --app <id> [--hidden]    Run the app <id> (--hidden: tray only)
webtray --install <id>           Write ~/.local/share/applications/webtray-<id>.desktop
                                 (+ ~/.config/autostart/webtray-<id>.desktop if autostart: true)
webtray --uninstall <id>         Remove both entries
webtray --list                   Show configured apps and what is installed
webtray --add <url> [--id x] [--name "X"] [--autostart] [--start-hidden]
webtray --check-update           Check for a newer PWA Pop
webtray --update                 Download, verify and install it
webtray --version
```

Set `WEBTRAY_DEBUG=1` to log show/hide events. Denied permissions and redirects
that leave `allowed_origins` are always logged to stderr.

## Configuration

Everything lives in **`~/.config/webtray/apps.yaml`**. The manager edits it for
you and keeps your comments. A full, commented example is in
[`examples/apps.yaml`](examples/apps.yaml):

```yaml
- id: linkus
  name: Linkus
  url: https://pbx.example.com/
  icon: ~/.config/webtray/icons/linkus.png
  start_hidden: true
  autostart: true
  allowed_origins: ["https://pbx.example.com"]
  hid_devices: [{ vendorId: 0x6993 }]   # auto-select Yealink WH64
  urgent_notifications: true
- id: outlook
  name: Outlook
  url: https://outlook.office.com/mail
  allowed_origins: ["https://outlook.office.com", "https://*.office.com", "https://login.microsoftonline.com", "https://login.live.com"]
- id: claude
  name: Claude
  url: https://claude.ai
```

| Key | Default | Meaning |
|---|---|---|
| `id` | required | Lowercase letters, digits, `-`, `_`. Used for `--app`, the profile folder and the `.desktop` name. |
| `name` | id | Display name. |
| `url` | required | Start page. |
| `icon` | `icons/<id>.png`, then the favicon | PNG or SVG. |
| `start_hidden` | `false` | Start in the tray. |
| `autostart` | `false` | Start at login (hidden). |
| `allowed_origins` | origin of `url` | Stay in-app and get auto-granted permissions. `https://*.example.com` matches subdomains; ports are honoured. |
| `hid_devices` | `[]` | `[{ vendorId: 0x…, productId: 0x… }]`. `productId` is optional. |
| `extra_permissions` | `[]` | More Chromium permissions, e.g. `display-capture` (screen sharing through the desktop portal), `geolocation`. |
| `urgent_notifications` | `false` | Notifications stay on screen until dismissed. |
| `raise_on_notification` | `false` | Show the window when the page posts a notification. |
| `badge_regex` | `\((\d+)\)` | How to read the unread count from the title. |
| `reload_on_resume` | `false` | Reload after suspend (re-registers softphones). |
| `ignore_certificate_errors` | `false` | Accept self-signed certificates on allowed origins only. |
| `user_agent` | Chrome UA | Override the user agent. |
| `width`, `height` | 1200×800 | Initial size. |
| `handle_schemes` | – | Link types this app opens and dials, e.g. `[tel, callto, sip]` (click-to-call). The app becomes their default. |
| `dial_input`, `dial_button`, `dial_open` | – | CSS selectors for click-to-call, set from the app's right-click menu ("Use for click-to-call"). |
| `memory_limit_mb` | – | Reload, then restart, the app when it uses more than this many MB. Never during calls or while you're using it. |
| `icon_color` | – | Recolour the icon: `blue`, `green`, `purple`, `orange`, `teal`, `pink`, `red`, `yellow`. Used for duplicates. |
| `icon_label` | – | 1–2 characters in a coloured chip on the icon's top-left corner (e.g. `2` or `W`). |
| `icon_auto` | – | Set by the manager when it picked the icon: PWA Pop swaps in the site's own icon after you sign in. |

Other files under `~/.config/webtray/`: `icons/` (app icons), `state/<id>.json`
(window geometry, mute) and `profiles/<id>/` (cookies, logins, storage; delete it
to log out completely).

### Adding an app by hand

1. Add an entry to `apps.yaml` (or run `webtray --add https://app.example.com --name Example`).
2. Put the site and its sign-in origins in `allowed_origins`. Run the app from a
   terminal: any redirect that leaves the list is logged, so you can see what to add.
3. Run `webtray --install <id>`. The app is now in the menu (and in autostart if `autostart: true`).

### Several accounts on the same site

Every app has its own profile (`~/.config/webtray/profiles/<id>/`), so two
entries for the same site are fully separate: different logins, cookies and
settings. In the manager, click **Duplicate** on an app. The copy gets a unique
ID and name (`claude-2`, "Claude (2)"), a different icon colour and a numbered
label so the tray icons are easy to tell apart. Open it and sign in with the
other account. Rename it to something like "Claude (Work)" whenever you like.

### Click-to-call (Linkus and other softphones)

Edit the softphone app and tick **Open phone links (tel:, callto:, sip:)**.
Clicking a phone number or call icon anywhere (ConnectWise, CRMs, email,
browsers) then opens the app and dials the number. If it opens the app but
doesn't dial, right-click the dialpad's number field and choose **Use for
click-to-call → Number field**, then the same on the call button. Use **Test**
in that menu to check it without placing a call.

### Headsets

Find your headset's IDs with **Manager → Edit → Headset / HID devices → Detect
connected devices**, or with `lsusb` (`ID 6993:b0ab` → `vendorId: 0x6993`). Common
vendors: Yealink `0x6993`, Jabra `0x0b0e`, Poly/Plantronics `0x047f`,
EPOS/Sennheiser `0x1395`.

## Build from source

Requires Node.js 20+ and, for rpm, `rpmbuild` (`sudo dnf install rpm-build`).

```bash
git clone https://github.com/samschultzponsys/pwa-pop && cd pwa-pop
```

```bash
npm ci
```

```bash
npm start
```

That last command runs the manager from source. To run one app from source:

```bash
npm run build && npx electron . --app claude
```

Packages (they land in `release/`):

```bash
npm run dist:rpm
```

```bash
npm run dist:appimage
```

```bash
npm run dist
```

`npm run dist` builds every target: AppImage, rpm, deb, pacman and tar.gz.

Flatpak (needs `flatpak-builder`, and run `npm run dist` first):

```bash
cd flatpak && flatpak-builder --user --install-deps-from=flathub --force-clean --repo=repo build-dir io.github.samschultzponsys.PwaPop.yml
```

```bash
flatpak build-bundle repo ../release/pwa-pop.flatpak io.github.samschultzponsys.PwaPop
```

Unit tests: `npm test`. Manual release checks: [TESTING.md](TESTING.md).

## Updates

PWA Pop checks GitHub Releases shortly after it starts and then every 12 hours,
and tells you once per new version (notification, tray menu item and a banner
in the manager). You can turn this off in the manager's footer.

| Installed as | How updates are installed |
|---|---|
| AppImage | **Install update** downloads the new AppImage, verifies it, and replaces the file. |
| rpm / deb / pacman | **Install update** downloads the package, verifies it, and installs it with your password (`pkexec dnf/apt/pacman`). |
| Flatpak (from the repository, or a 1.2+ bundle) | Automatic through Discover / GNOME Software / `flatpak update`. |
| tar.gz | You're told about the release; download it yourself. |

The manager's footer shows how this copy was installed. **How to update**
opens the exact steps for that install, with copyable commands (also printed
by `webtray --check-update`).

Every download is checked against the release's `SHA256SUMS.txt` before it is
installed. Running apps switch to the new version when you restart them
(Quit from the tray, then open them again).

### Maintainer setup for the Flatpak repository (one time)

1. Repository **Settings → Pages → Build and deployment → Source: GitHub Actions**.
   The workflow then publishes the Flatpak repository to
   `https://samschultzponsys.github.io/pwa-pop/` on every release.
2. Optional, recommended: sign the repository. Without a key it is published
   unsigned (still served over HTTPS). Create a key on your own machine:

   ```bash
   gpg --batch --passphrase '' --quick-gen-key "PWA Pop Flatpak <sam.schultz2014@gmail.com>" ed25519 sign never
   ```

   ```bash
   gpg --armor --export-secret-keys "PWA Pop Flatpak" > pwa-pop-flatpak.key
   ```

   Paste the contents of `pwa-pop-flatpak.key` into **Settings → Secrets and
   variables → Actions → New repository secret** named `FLATPAK_GPG_PRIVATE_KEY`,
   then delete the file. Once a release has been signed, keep using the same key;
   changing it later means users have to re-add the repository.

## Versioning & releases

* Versions are **`MAJOR.MINOR`**: 1.0, 1.1 … 1.9, then **2.0**. (`package.json`
  stores `1.0.0` because npm needs three numbers. Everywhere else shows `1.0`.)
* To release: add your notes under `## [Unreleased]` in `CHANGELOG.md`, run
  `npm run version:bump`, commit and push to `main`.
* GitHub Actions ([`release.yml`](.github/workflows/release.yml)) builds every
  package. When a version has no release yet, it publishes **one GitHub release
  `v<version>`** with every distro's package and `SHA256SUMS.txt` attached. File
  names carry the version, e.g. `pwa-pop-1.1-x86_64.rpm`.

## How it works

```
webtray --app linkus
  └─ Electron main process (src/main.ts)
       ├─ userData = ~/.config/webtray/profiles/linkus   → per-app single-instance lock
       ├─ CHROME_DESKTOP = webtray-linkus.desktop        → Wayland app_id, icon, badge
       └─ AppRuntime (src/runtime.ts)
            ├─ session persist:linkus  → permission / WebHID / download handlers
            ├─ BrowserWindow (backgroundThrottling: false, close → hide)
            │    └─ preload: Notification shim → IPC → native notification (src/notifications.ts)
            └─ Tray (StatusNotifierItem) + unread badge (src/badge.ts)
```

## Troubleshooting

* **No tray icon on GNOME:** install the *AppIndicator and KStatusNotifierItem
  Support* extension. KDE, XFCE, Cinnamon and others work out of the box.
* **Headset not detected:** check `getfacl /dev/hidraw*` lists your user. If not,
  install the udev rule (above) and replug.
* **Sign-in opens in the browser:** the sign-in origin isn't in `allowed_origins`.
  Run the app from a terminal and look for the `redirect outside allowed_origins` line.
* **A site says the browser is unsupported:** set `user_agent:` to a current
  Chrome user agent string.
* **Start fresh:** quit the app, then `rm -rf ~/.config/webtray/profiles/<id>`.

## License

[MIT](LICENSE)
