/**
 * TankLabel - native-print.js
 * Label printing from the Android app (Capacitor) through the
 * @devlas/capacitor-thermal-printer plugin: Bluetooth SPP (printers paired in
 * Android settings) or USB OTG.
 *
 * The Android WebView has no Web Bluetooth, so printViaBluetooth() delegates here
 * when the page runs inside the app. The plugin only moves raw bytes: the TSPL
 * packet is the same one built for Web Bluetooth (captureLabel + buildTsplPacket
 * in bluetooth-print.js).
 *
 * The Capacitor bridge exposes window.Capacitor.Plugins.ThermalPrinter on every
 * page served by the app, so no bundler or @capacitor/core import is needed.
 * In the browser this file only defines functions and does nothing; isNativeApp()
 * lives in bluetooth-print.js, so the website keeps working without this file.
 */

"use strict";

const NATIVE_PRINTER_STORAGE_KEY = "nativePrinter";

const NATIVE_PRINT_ERRORS = {
  unavailable: "Bluetooth o USB non disponibile su questo dispositivo.",
  not_found: "Stampante non trovata. Verifica che sia accesa e associata (o collegata via USB).",
  permission_denied: "Permesso negato. Consenti Bluetooth/USB dalle impostazioni dell'app e riprova.",
  connect_failed: "Connessione non riuscita. Verifica che il Bluetooth sia attivo e che la stampante sia accesa e vicina.",
  write_failed: "Invio interrotto a metà stampa. Riprova.",
};

// Errors that choosing another printer can solve; the others are only reported
const PRINTER_SWITCH_ERRORS = ["not_found", "connect_failed"];

if (isNativeApp()) {
  // Shows the .native-only controls (see styles.css)
  document.documentElement.classList.add("native-app");
}

function getThermalPrinter() {
  const plugin = window.Capacitor?.Plugins?.ThermalPrinter;
  if (!plugin) {
    throw new Error("Plugin di stampa non disponibile in questa versione dell'app.");
  }
  return plugin;
}

/** Same as the plugin's bytesToBase64: chunked to stay below the call argument limit. */
function bytesToBase64(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Plugin target without the display name. */
function printerTarget({ transport, address, vendorId, productId }) {
  return transport === "usb"
    ? { transport, vendorId, productId }
    : { transport, address };
}

function samePrinter(a, b) {
  return !!a && !!b && JSON.stringify(printerTarget(a)) === JSON.stringify(printerTarget(b));
}

function loadNativePrinter() {
  try {
    return JSON.parse(localStorage.getItem(NATIVE_PRINTER_STORAGE_KEY));
  } catch (_) {
    return null;
  }
}

function describeNativePrintError(err) {
  return NATIVE_PRINT_ERRORS[err?.code] ?? err?.message ?? String(err);
}

function setButtonStatus(btn, iconClass, text) {
  const icon = document.createElement("i");
  icon.className = iconClass;
  btn.replaceChildren(icon, ` ${text}`);
}

/* =========================================================
 * SCELTA STAMPANTE
 * ========================================================= */

/**
 * Paired Bluetooth devices plus USB devices that expose a printer endpoint.
 * Listing Bluetooth asks for BLUETOOTH_CONNECT the first time (Android 12+).
 */
async function listNativePrinters() {
  const plugin = getThermalPrinter();
  const printers = [];
  let bluetoothError = null;

  try {
    const { devices } = await plugin.list({ transport: "bluetooth" });
    for (const d of devices) {
      printers.push({ transport: "bluetooth", address: d.address, name: d.name || d.address });
    }
  } catch (err) {
    // No adapter or permission denied: USB printers can still be offered
    console.warn("[NativePrint] Bluetooth:", err);
    bluetoothError = err;
  }

  try {
    const { devices } = await plugin.list({ transport: "usb" });
    for (const d of devices.filter((device) => device.canPrint)) {
      printers.push({
        transport: "usb",
        vendorId: d.vendorId,
        productId: d.productId,
        name: d.name || `USB ${d.vendorId}:${d.productId}`,
      });
    }
  } catch (err) {
    console.warn("[NativePrint] USB:", err);
  }

  if (!printers.length) {
    throw new Error(
      bluetoothError?.code === "permission_denied"
        ? NATIVE_PRINT_ERRORS.permission_denied
        : "Nessuna stampante trovata.\n\nVerifica che il Bluetooth sia attivo e che la stampante sia associata nelle impostazioni Bluetooth di Android (o collegala via USB), poi riprova."
    );
  }
  return printers;
}

/** Opens #printerModal and resolves with the chosen printer, or null if cancelled. */
function pickNativePrinter(printers, current) {
  const modal = document.getElementById("printerModal");
  const list = document.getElementById("printerList");

  return new Promise((resolve) => {
    const close = (printer) => {
      modal.classList.remove("active");
      list.replaceChildren();
      resolve(printer);
    };

    for (const printer of printers) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "btn btn-secondary printer-option";

      const icon = document.createElement("i");
      icon.className = printer.transport === "usb" ? "fab fa-usb" : "fab fa-bluetooth-b";
      const name = document.createElement("span");
      name.className = "printer-option-name";
      name.textContent = printer.name;
      item.append(icon, name);
      if (samePrinter(printer, current)) {
        const check = document.createElement("i");
        check.className = "fas fa-check";
        item.append(check);
      }

      item.onclick = () => close(printer);
      list.append(item);
    }

    document.getElementById("printerModalCancel").onclick = () => close(null);
    modal.classList.add("active");
  });
}

let pendingPrinterChoice = null;

/**
 * Lists the printers, lets the user pick one and remembers it. Returns null if cancelled.
 * Concurrent callers ("Stampa BT" and "Stampante" tapped together) share the same picker.
 */
function chooseNativePrinter() {
  if (!pendingPrinterChoice) {
    pendingPrinterChoice = (async () => {
      const printers = await listNativePrinters();
      const printer = await pickNativePrinter(printers, loadNativePrinter());
      if (printer) localStorage.setItem(NATIVE_PRINTER_STORAGE_KEY, JSON.stringify(printer));
      return printer;
    })().finally(() => {
      pendingPrinterChoice = null;
    });
  }
  return pendingPrinterChoice;
}

/** "Stampante" button: change the remembered printer without printing. */
async function changeNativePrinter() {
  try {
    await chooseNativePrinter();
  } catch (err) {
    alert(describeNativePrintError(err));
  }
}

/* =========================================================
 * STAMPA
 * ========================================================= */

/**
 * The plugin never prompts inside print(): ask first. Bluetooth needs the "Nearby devices"
 * permissions (Android 12+), USB a per-device grant that Android drops when the cable is unplugged.
 */
async function ensureNativePrinterPermission(plugin, printer) {
  const { granted } = await plugin.requestPermission(printerTarget(printer));
  if (!granted) {
    const err = new Error(NATIVE_PRINT_ERRORS.permission_denied);
    err.code = "permission_denied";
    throw err;
  }
}

async function printViaThermalPlugin() {
  const btn = document.getElementById("btPrintBtn");
  const idleChildren = [...btn.childNodes];
  let printer = loadNativePrinter();
  let retryWithAnother = false;

  btn.disabled = true;
  try {
    const plugin = getThermalPrinter();

    if (!printer) {
      setButtonStatus(btn, "fas fa-spinner fa-spin", "Ricerca stampanti...");
      printer = await chooseNativePrinter();
      if (!printer) return; // picker cancelled
    }

    setButtonStatus(btn, "fas fa-spinner fa-spin", `Stampa su ${printer.name}...`);
    await ensureNativePrinterPermission(plugin, printer);

    const packet = buildTsplPacket(await captureLabel());
    setButtonStatus(btn, "fas fa-spinner fa-spin", `Invio ${packet.length} byte...`);
    await plugin.print({ ...printerTarget(printer), data: bytesToBase64(packet) });

    setButtonStatus(btn, "fas fa-check", "Stampato!");
    if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
    await new Promise((r) => setTimeout(r, 2500));
  } catch (err) {
    console.error("[NativePrint] Errore:", err);
    const message = describeNativePrintError(err);
    if (printer && PRINTER_SWITCH_ERRORS.includes(err?.code)) {
      const pickAnother = confirm(
        `Errore stampa su ${printer.name}:\n\n${message}\n\nVuoi scegliere un'altra stampante?`
      );
      // Still before finally, so the button stays disabled while the picker is up. The
      // remembered printer is replaced only when the user actually picks another one.
      if (pickAnother) {
        setButtonStatus(btn, "fas fa-spinner fa-spin", "Ricerca stampanti...");
        try {
          retryWithAnother = !!(await chooseNativePrinter());
        } catch (chooseErr) {
          alert(describeNativePrintError(chooseErr));
        }
      }
    } else {
      alert(printer ? `Errore stampa su ${printer.name}:\n\n${message}` : `Errore stampa:\n\n${message}`);
    }
  } finally {
    btn.disabled = false;
    btn.replaceChildren(...idleChildren);
  }

  if (retryWithAnother) return printViaThermalPlugin();
}
