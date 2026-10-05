# Blending Station Android app

A [Capacitor](https://capacitorjs.com) shell that packages the static site (Blending Station and
TankLabel) as an Android app, so labels can be printed on thermal printers through
[@devlas/capacitor-thermal-printer](https://github.com/devlas-cl/capacitor-thermal-printer).

The site at the repository root stays build-free and keeps being served by GitHub Pages as is.
`npm run copy:web` copies a snapshot of it into `www/`, which Capacitor bundles into the APK.

## Requirements

- Node.js 22 or newer
- JDK 21 (the one bundled with a recent Android Studio works)
- Android SDK with platform 36 (Android Studio installs it on first sync)

## Commands

```bash
cd app
npm install
npm run sync          # copy the site into www/ and update the Android project
npm run open          # open the project in Android Studio (run / debug from there)
npm run build:debug   # sync and build android/app/build/outputs/apk/debug/app-debug.apk
```

Run `npm run sync` after every change to the site, before building.

## Label printing

In the app the TankLabel "Stampa BT" button prints through the plugin instead of Web Bluetooth,
which the Android WebView does not provide (see `tanklabel/native-print.js`). It sends the same
TSPL packet used by the web version over:

- **Bluetooth classic (SPP)**: the printer must first be paired in the Android Bluetooth settings.
  Printers that only speak Bluetooth Low Energy are not supported by the plugin.
- **USB OTG**: Android asks for permission to use the printer the first time it is plugged in.

The first print opens a picker with the paired and connected printers; the choice is remembered
and can be changed with the "Stampante" button.

Downloads, `window.print()` and the share sheet do not exist in the Android WebView, so the PDF,
Immagine, Stampa and Stampa WiFi buttons are hidden in the app.

## Icons and splash screen

The launcher icons and splash screens are generated from the sources in `assets/`, which are
rendered from the logos in `../assets/`:

```bash
npx @capacitor/assets generate --android
```
