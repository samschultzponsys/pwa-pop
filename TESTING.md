# PWA Pop — manual test checklist

Run this on the target machine (Fedora 44, KDE Plasma 6, Wayland) before
announcing a release. Note the version under test: `webtray --version`.

Setup: install the rpm (`sudo dnf install ./pwa-pop-<ver>-x86_64.rpm`), copy
`examples/apps.yaml` to `~/.config/webtray/apps.yaml`, replace the PBX host,
then run `webtray --install linkus`, `webtray --install outlook` and
`webtray --install claude`.

Tip: start an app from a terminal with `WEBTRAY_DEBUG=1 webtray --app <id>` to
see show/hide events, denied permissions and redirects that leave
`allowed_origins`.

## 1. Tray toggle
- [ ] `webtray --app claude` shows the window and a Claude tray icon (not a generic one).
- [ ] Left-click the tray icon: the window hides. Click again: it comes back, focused.
- [ ] Minimise the window, then click the tray icon: it is restored.
- [ ] Right-click the tray icon: the menu shows *Hide Claude / Reload / Mute notifications / Manage apps… / Quit*.
- [ ] The window close button hides it to the tray (the process keeps running: `pgrep -fa "webtray --app claude"`).
- [ ] Ctrl+W hides; Ctrl+Q does **not** quit.
- [ ] *Quit* from the tray menu exits the process.
- [ ] Run `webtray --app claude` while it is running: the existing window appears; no second tray icon.
- [ ] Resize and move the window, quit and restart: the size (and position on X11) is restored.
- [ ] Quit and restart: still logged in.

## 2. Notification while hidden
- [ ] Hide Outlook to the tray. Send yourself an email: a native KDE notification appears with the Outlook icon.
- [ ] Click the notification: the Outlook window appears and is focused.
- [ ] Tray menu → *Mute notifications*. Send another email: no notification. Unmute: notifications return (the setting survives a restart).
- [ ] The unread count in the page title (e.g. "(3)") shows a red badge with the number on the tray icon and taskbar entry; it clears when read.

## 3. Linkus incoming call while hidden
- [ ] Linkus started from autostart, hidden (`--hidden`), with only its tray icon visible.
- [ ] Wait at least 10 minutes hidden (to catch timer throttling), then call the extension from another phone.
- [ ] The ringtone plays through the headset/speakers while the window is still hidden.
- [ ] A call notification appears and stays on screen (`urgent_notifications: true`).
- [ ] Clicking the notification shows Linkus; you can answer and the audio works both ways.
- [ ] No microphone permission prompt appears (granted for `allowed_origins`).
- [ ] Suspend and resume the laptop, then call again: it still rings (`reload_on_resume`).

## 4. Headset buttons (Yealink WH64, WebHID)
- [ ] `ls -l /dev/hidraw*` shows the headset node with an ACL for your user (`getfacl /dev/hidraw<N>`) — the udev rule is active.
- [ ] Linkus shows the headset as connected without any device chooser.
- [ ] Incoming call: the headset's answer button answers. The hang-up button ends the call.
- [ ] Mute on the headset mutes in Linkus (and the LED follows).
- [ ] Quit and restart Linkus: the headset is picked up again with no prompt.
- [ ] Unplug and replug the headset (or power-cycle the dongle): it reconnects.

## 5. Microsoft 365 login
- [ ] Clear the profile (`rm -rf ~/.config/webtray/profiles/outlook`) and start Outlook.
- [ ] The Microsoft sign-in (login.microsoftonline.com) stays inside the app window, MFA included.
- [ ] If your tenant uses ADFS/Okta: add its origin to `allowed_origins`. Sign-in must not open the browser.
- [ ] "Stay signed in?" → Yes. Quit and restart: still signed in.
- [ ] Popups from Outlook (e.g. pop-out compose, OAuth consent) open as child windows of the app.

## 6. External link handling
- [ ] Click a link to a foreign site in an email: it opens in the default browser, not in the app.
- [ ] Right-click a link → *Open link in browser* / *Copy link address* work.
- [ ] In Claude, a link in a chat response opens in the browser.
- [ ] `mailto:` links open the default mail handler.
- [ ] Download an attachment: it lands in ~/Downloads, and a notification opens the folder.

## 7. Autostart
- [ ] `ls ~/.config/autostart/` shows `webtray-linkus.desktop` and `webtray-outlook.desktop` (apps with `autostart: true`).
- [ ] Log out and back in: Linkus and Outlook start hidden, with tray icons only.
- [ ] In the manager, turn off autostart for Outlook: the autostart file is removed. Log in again: Outlook doesn't start.
- [ ] `webtray --uninstall outlook` removes both the menu and autostart entries.

## 8. Manager UI & adding apps
- [ ] Launch *PWA Pop* from the app menu. The manager lists the configured apps with icons.
- [ ] *+ Add app* → paste `https://claude.ai` → *Fetch details*: name, icon and origins fill in.
- [ ] Save with "Add to the application menu": the app appears in the KDE menu with its icon.
- [ ] Linkus *Edit* → *Headset / HID devices* → *Detect connected devices*: the WH64 is listed; *Any from vendor* adds `vendorId 0x6993`.
- [ ] Changes are written to `~/.config/webtray/apps.yaml`, and its comments are kept.

## 9. Duplicates, icons and service-worker notifications
- [ ] Manager → **Duplicate** on Claude: the form shows `claude-2`, "Claude (2)", a colour and label "2". Save, open it, and sign in with a second account. The first Claude stays signed in to the first account.
- [ ] Both Claude tray icons are visibly different (colour + "2" chip). The menu entries show the same icons.
- [ ] Add `https://outlook.cloud.microsoft` fresh: the icon has no white square behind it ("Restore background" is offered). After signing in, the icon is Outlook's own.
- [ ] Outlook hidden in the tray → send yourself an email: a KDE popup appears (not just the sound). Clicking it opens Outlook on that email.
- [ ] Unread badge at tray size is readable (digit or "9+") and doesn't hide the icon.

## 10. Packaging
- [ ] `rpm -ql pwa-pop | grep -E '^/opt/webtray/webtray$|^/usr/lib/udev'` and `/usr/bin/webtray` exist.
- [ ] `sudo dnf remove pwa-pop` removes `/usr/bin/webtray` and the udev rule. `~/.config/webtray` is untouched.
- [ ] The AppImage runs (`chmod +x` it, then `./pwa-pop-<ver>-x86_64.AppImage`) and `--install` writes `Exec=` pointing at the AppImage.
- [ ] Flatpak: `flatpak install --user ./pwa-pop-<ver>-x86_64.flatpak`, then repeat sections 1, 2 and 4.
