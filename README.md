# AC Remote

Control your Panasonic air conditioner from your Windows PC and your phone, at home and away: temperature dial, modes, fan, presets with schedules, timers, and (optionally, through MirAIe) Powerful, Eco, Clean, Converti7 and energy use.

AC Remote runs on your PC. The PC talks to the AC directly over Matter on your home Wi-Fi, so there is no cloud account in the middle. Your phone opens the same control screen from the PC, protected by a PIN.

```
 Phone (browser / home-screen app)
        |  home Wi-Fi, or Tailscale when you're out
        v
 Windows PC running AC Remote  --Matter over Wi-Fi-->  Panasonic AC
```

## What you need

- A Windows 10 or 11 PC that stays switched on, on the same Wi-Fi as the AC.
- Your AC's Matter QR sticker and 11-digit pairing code (on the indoor unit or in the manual).
- For pairing a brand-new AC directly from the PC: Bluetooth on the PC. Without Bluetooth, use method B below.
- Internet access during installation (to download Node.js and the app's components).

## 1. Install

1. Unzip this folder somewhere permanent, for example `C:\ACRemote` (not a temporary folder; the app runs from here).
2. Double-click **Install AC Remote.bat** and click **Yes** when Windows asks for permission. It:
   - installs Node.js if it isn't on the PC,
   - installs the app,
   - allows your phone and the AC through Windows Firewall on your home network only,
   - offers to set your Wi-Fi to Private (needed) and to stop the PC sleeping while plugged in (needed for control from outside),
   - makes AC Remote start by itself whenever you sign in to Windows, and starts it now.
3. A browser opens at `http://localhost:8080`. Choose a 4 to 8 digit PIN. (The first PIN can only be set on the PC itself.)

## 2. Pair the AC

Open **Pair an AC** in the app. There are two ways; use whichever fits.

**A. Over the PC's Bluetooth (AC not set up in any app yet)**
1. Take the PC (laptop) within a few metres of the AC.
2. On the AC remote, press **SMART** until the Wi-Fi light blinks and the display shows **SE**.
3. In AC Remote choose **Over Bluetooth**, enter your 2.4 GHz Wi-Fi name and password and the 11-digit code from the AC's sticker, then **Pair AC**. It can take up to two minutes.

**B. Through MirAIe or Google Home first (most reliable)**
1. Set up the AC in the Panasonic MirAIe app or Google Home as usual, using the Matter QR code.
2. In that app, open the AC's settings and look for the option to share it with another Matter app (Google Home calls it **Linked Matter apps & services**). It shows a new pairing code.
3. In AC Remote choose **From a phone app**, enter that code and tap **Pair AC** within a few minutes (shared codes expire).

The AC keeps working in MirAIe / Google Home as well; Matter allows several apps at once.

## 3. Use it on your phone at home

Settings in AC Remote lists the address to open on your phone, e.g. `http://192.168.1.20:8080`. Open it in Chrome or Safari while the phone is on the same Wi-Fi, enter your PIN, then use **Add to Home screen** for a one-tap icon.

Tip: give the PC a fixed IP address in your router (often called "DHCP reservation") so this address never changes.

## 4. Use it from anywhere

Double-click **Set up remote access.bat** on the PC. It installs [Tailscale](https://tailscale.com) (free for personal use), asks you to sign in, and gives you a private address like `https://your-pc.tailnet-name.ts.net`.

On your phone, install the Tailscale app, sign in with the same account, and open that address. It works both at home and away, uses HTTPS, and lets you install AC Remote as an app. Nothing on your PC is exposed to the public internet.

Do **not** forward port 8080 on your router instead; that would expose the PC to the internet.

## 5. Presets and timers

**Presets** save a full setup: mode, temperature, fan, swing, Powerful or Eco, a start time, an end time and the days to repeat. Tap **Start** on a preset card to apply it straight away; it switches the AC off at its end time. Tap **Stop** to switch the AC off. Turn on **Auto** on a card and the PC starts that preset by itself at its start time on the chosen days. Tap a preset's name to edit or delete it.

**Off timer:** tap the stopwatch on the AC card to switch the AC off after 30 minutes to 8 hours, or at a set time.

Presets and timers are run by the PC, so it needs to be on (not asleep) at those times.

## 6. Panasonic extras through MirAIe (optional)

Matter only carries the standard controls. To also get **Powerful, Eco, Clean, AC Display, nanoe, Converti7, vertical swing positions and monthly energy use (kWh)**, open Settings, go to **Panasonic MirAIe**, and sign in with the same mobile number or email and password you use in the MirAIe app.

- Your login is stored encrypted on this PC only (in `%LOCALAPPDATA%\ACRemote`).
- If the AC is paired over Matter too, AC Remote treats them as one AC: everyday controls go over Matter on your Wi-Fi, the extras go through MirAIe. If you have more than one AC, choose which MirAIe AC is which in Settings.
- If Matter can't reach the AC, AC Remote falls back to MirAIe for the basics.
- You can also skip Matter pairing and use AC Remote with MirAIe alone.
- This uses MirAIe's internet service, the same way the open-source Home Assistant integrations do. Panasonic doesn't officially support it for other apps, so it could stop working if they change it. Matter control keeps working regardless.

## Everyday

| To | Do this |
| --- | --- |
| Open the remote on the PC | **Open AC Remote.bat** or `http://localhost:8080` |
| Start it if it's not running | **Start AC Remote.bat** (it normally starts at sign-in) |
| Stop it | **Stop AC Remote.bat** |
| Change the PIN or sign out other phones | Settings in the app |
| Link or unlink MirAIe | Settings in the app |
| Rename or remove an AC, pair another one | Settings in the app |
| See the log | `%LOCALAPPDATA%\ACRemote\ac-remote.log` |
| Remove everything | **Uninstall AC Remote.bat** |

Your PIN, paired ACs and log live in `%LOCALAPPDATA%\ACRemote`.

## Troubleshooting

- **"AC isn't responding"**: the AC is unpowered or off Wi-Fi, or the PC is on a different network (for example, a guest network). Both must be on the same home network.
- **Phone can't open the address at home**: make sure the Wi-Fi is set to Private on the PC (run the installer again and accept), and that the phone isn't on mobile data or a guest network.
- **Pairing "couldn't find the AC"**: codes from MirAIe or Google Home expire after a few minutes; generate a new one. For Bluetooth pairing, put the AC back in pairing mode (SMART until SE shows) and keep the PC close.
- **Bluetooth pairing keeps failing**: use method B; it does the Bluetooth step on your phone instead.
- **Can't control from outside**: the PC must be on and not asleep, and Tailscale must be on in your phone.
- **Some buttons do nothing on your model**: not every AC accepts every mode or fan speed over Matter. The app shows the AC's reply when it rejects something.

## How it's built (for developers)

- `src/hub.mjs` merges each AC's Matter and MirAIe connections into one device, routes commands, and runs off timers.
- `src/presets.mjs` stores presets, applies them, and starts scheduled ones.
- `src/miraie.mjs` is the optional MirAIe cloud link (login, AC list, MQTT control and status, energy), following the protocol documented by the open-source miraie-ac projects.
- `src/ac.mjs` is the Matter controller, built on [matter.js](https://github.com/project-chip/matter.js) 0.18. It commissions devices into its own fabric and maps the Room Air Conditioner clusters (On/Off, Thermostat, Fan Control) to simple controls.
- `src/server.mjs` is a dependency-free HTTP server: PIN sign-in with signed cookies, a JSON API and live updates over Server-Sent Events.
- `public/` is the installable web app (works on phone and PC).
- `test/mock-miraie.mjs` is a stand-in MirAIe service for development (needs `npm install` with dev dependencies; login 9876543210 / test1234). Point the app at it with `MIRAIE_AUTH_URL=http://localhost:8790 MIRAIE_APP_URL=http://localhost:8790 MIRAIE_MQTT_URL=mqtt://localhost:1884`.
- `test/sim-ac.mjs` runs a simulated Matter AC for development: `npm run simulator`, then pair it in the app with the code it prints (`34970112332`).

API (all routes except status/setup/login need the session cookie and an `x-acr: 1` header on non-GET requests):

| Method | Path | Body |
| --- | --- | --- |
| GET | `/api/devices` | |
| GET | `/api/events` | (event stream) |
| POST | `/api/devices/pair` | `{ code, wifiSsid?, wifiPassword? }` |
| POST | `/api/devices/:id/control` | any of `{ power, mode, targetTemp, fan, swing, name, offTimer }`, plus with MirAIe `{ powerful, eco, clean, display, nanoe, converti, swingV, swingH }` |
| DELETE | `/api/devices/:id` | |
| GET / POST | `/api/presets` | preset `{ deviceId, name, mode, targetTemp, fan, swing, special, start, end, days, once, scheduled }` |
| PUT / DELETE | `/api/presets/:id` | |
| POST | `/api/presets/:id/start`, `/api/presets/:id/stop` | |
| GET / POST / DELETE | `/api/miraie` | `{ username, password }` to link |

Settings are in `%LOCALAPPDATA%\ACRemote\config.json` (`port`, `matterPort`, `bluetooth`).
