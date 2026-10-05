/**
 * TankLabel - bluetooth-print.js
 * Stampa diretta su Clabel CT221B (e stampanti termiche TSPL compatibili)
 * tramite Web Bluetooth API.
 *
 * Flusso:
 *  1. Connessione BLE con auto-discovery della caratteristica di scrittura
 *  2. Cattura etichetta via html2canvas
 *  3. Ridimensionamento a 203 DPI (dots esatti)
 *  4. Conversione in bitmap 1-bit (formato TSPL BITMAP)
 *  5. Invio pacchetto TSPL in chunk da 512 byte
 *
 * Dipendenze: html2canvas (CDN), DOM e CONFIG definiti in index.html
 *
 * In the Android app the same TSPL packet is sent through the native plugin
 * instead: see native-print.js.
 */

"use strict";

/* =========================================================
 * COSTANTI
 * ========================================================= */

const BT_DPI = 203;
const BT_MM_TO_DOTS = BT_DPI / 25.4; // dot per mm ≈ 7.992

// UUID dei servizi BLE candidati per stampanti termiche CTA/Clabel.
// Il discovery automatico tenterà tutti questi in ordine.
const BT_CANDIDATE_SERVICES = [
  "000018f0-0000-1000-8000-00805f9b34fb", // CTA IoT / Clabel (più probabile)
  "0000ff00-0000-1000-8000-00805f9b34fb", // Generico cinese (fallback)
  "e7810a71-73ae-499d-8c15-faa9aef0c3f2", // Peripage / Goojprt
  "49535343-fe7d-4ae5-8fa9-9fafd205e455", // ISSC (Microchip BLE)
];

// Dimensione chunk per la trasmissione BLE.
// 512 byte funziona con MTU negoziata; se la stampante disconnette, scendere a 128.
const BT_CHUNK_SIZE = 512;

/* =========================================================
 * STATO
 * ========================================================= */

const BT = {
  device: null,
  server: null,
  writeChar: null,
};

/* =========================================================
 * CONNESSIONE
 * ========================================================= */

/**
 * Apre il selettore dispositivi BLE e si connette alla stampante.
 * Scopre automaticamente la caratteristica di scrittura tra i servizi disponibili.
 * @returns {string} Nome del dispositivo connesso
 */
async function connectPrinter() {
  if (!navigator.bluetooth) {
    throw new Error(
      "Web Bluetooth non supportato.\nUsa Chrome o Edge su Android/desktop (non Safari/Firefox)."
    );
  }

  const device = await navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: BT_CANDIDATE_SERVICES,
  });

  const server = await device.gatt.connect();
  const services = await server.getPrimaryServices();

  let writeChar = null;
  let foundService = null;

  for (const service of services) {
    try {
      const chars = await service.getCharacteristics();
      for (const char of chars) {
        if (char.properties.writeWithoutResponse || char.properties.write) {
          writeChar = char;
          foundService = service;
          break;
        }
      }
    } catch (_) {
      // Servizio non accessibile (non dichiarato in optionalServices), skip
    }
    if (writeChar) break;
  }

  if (!writeChar) {
    const uuids = services.map((s) => s.uuid).join("\n  ");
    throw new Error(
      `Nessuna caratteristica di scrittura trovata.\n\nServizi rilevati:\n  ${uuids}\n\nInvia questo log a chi ha sviluppato l'app.`
    );
  }

  BT.device = device;
  BT.server = server;
  BT.writeChar = writeChar;

  console.log(`[BT] Dispositivo: ${device.name ?? "(senza nome)"}`);
  console.log(`[BT] Service:     ${foundService.uuid}`);
  console.log(`[BT] Char write:  ${writeChar.uuid}`);
  console.log(
    `[BT] writeWithoutResponse: ${writeChar.properties.writeWithoutResponse}`
  );

  return device.name ?? "Stampante";
}

/* =========================================================
 * INVIO DATI
 * ========================================================= */

/**
 * Invia un Uint8Array alla stampante in chunk da BT_CHUNK_SIZE byte.
 * Usa writeValueWithoutResponse se disponibile (più veloce), altrimenti writeValue.
 */
async function sendChunked(characteristic, data) {
  const useWWR = characteristic.properties.writeWithoutResponse;
  let offset = 0;

  while (offset < data.length) {
    const chunk = data.slice(offset, offset + BT_CHUNK_SIZE);
    if (useWWR) {
      await characteristic.writeValueWithoutResponse(chunk);
    } else {
      await characteristic.writeValue(chunk);
    }
    offset += BT_CHUNK_SIZE;
    // Piccola pausa tra chunk per non saturare il buffer BLE
    if (offset < data.length) await new Promise((r) => setTimeout(r, 8));
  }
}

/* =========================================================
 * CATTURA ETICHETTA
 * ========================================================= */

/**
 * Cattura DOM.labelContent tramite html2canvas e restituisce il canvas ad alta risoluzione.
 */
async function captureLabel() {
  DOM.previewContainer.classList.add("printing");
  await new Promise((r) => setTimeout(r, 50));

  try {
    return await html2canvas(DOM.labelContent, {
      scale: 4,
      backgroundColor: "#ffffff",
      useCORS: true,
    });
  } finally {
    DOM.previewContainer.classList.remove("printing");
  }
}

/* =========================================================
 * CONVERSIONE IN PACCHETTO TSPL
 * ========================================================= */

/**
 * Converte il canvas catturato in un pacchetto TSPL pronto per la trasmissione.
 *
 * Formato TSPL generato:
 *   SIZE {w} mm,{h} mm\r\n
 *   GAP 2 mm,0 mm\r\n
 *   CLS\r\n
 *   BITMAP 0,0,{widthBytes},{heightDots},0\r\n
 *   [binary bitmap: widthBytes × heightDots bytes, MSB first, 1=nero]
 *   PRINT 1,1\r\n
 *
 * @param {HTMLCanvasElement} captured - Canvas ad alta risoluzione
 * @returns {Uint8Array} Pacchetto TSPL completo
 */
function buildTsplPacket(captured) {
  const widthMm = parseFloat(DOM.inputs.labelWidth.value) || 50;
  const heightMm = parseFloat(DOM.inputs.labelHeight.value) || 50;

  // Calcolo dimensioni in dots (arrotondato al multiplo di 8 per il byte-alignment)
  const widthDots = Math.round(widthMm * BT_MM_TO_DOTS);
  const heightDots = Math.round(heightMm * BT_MM_TO_DOTS);
  const widthBytes = Math.ceil(widthDots / 8);
  const widthDotsAligned = widthBytes * 8; // larghezza effettiva (multiplo di 8)

  // Ridimensiona al formato esatto della stampante
  const printCanvas = document.createElement("canvas");
  printCanvas.width = widthDotsAligned;
  printCanvas.height = heightDots;
  const ctx = printCanvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, widthDotsAligned, heightDots);
  ctx.drawImage(captured, 0, 0, widthDotsAligned, heightDots);

  // Converti in bitmap 1-bit: MSB first, 1 = pixel nero
  const pixels = ctx.getImageData(0, 0, widthDotsAligned, heightDots).data;
  const bitmap = new Uint8Array(widthBytes * heightDots);

  for (let y = 0; y < heightDots; y++) {
    for (let bx = 0; bx < widthBytes; bx++) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit++) {
        const px = bx * 8 + bit;
        const i = (y * widthDotsAligned + px) * 4;
        const luma = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
        if (luma < 128) byte |= 1 << (7 - bit); // scuro = nero = 1
      }
      bitmap[y * widthBytes + bx] = byte;
    }
  }

  console.log(
    `[BT] Etichetta: ${widthMm}×${heightMm} mm → ${widthDots}×${heightDots} dots, ${widthBytes} byte/riga, ${bitmap.length} byte totali`
  );

  // Assembla il pacchetto TSPL
  const enc = new TextEncoder();
  const header = enc.encode(
    `SIZE ${widthMm} mm,${heightMm} mm\r\n` +
    `GAP 2 mm,0 mm\r\n` +
    `CLS\r\n` +
    `BITMAP 0,0,${widthBytes},${heightDots},0\r\n`
  );
  const footer = enc.encode(`PRINT 1,1\r\n`);

  const packet = new Uint8Array(header.length + bitmap.length + footer.length);
  packet.set(header, 0);
  packet.set(bitmap, header.length);
  packet.set(footer, header.length + bitmap.length);

  return packet;
}

/* =========================================================
 * ENTRY POINT — chiamato dal pulsante UI
 * ========================================================= */

async function printViaBluetooth() {
  // Android app: the WebView has no Web Bluetooth, print through the native plugin
  if (isNativeApp()) return printViaThermalPlugin();

  const btn = document.getElementById("btPrintBtn");

  try {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Connessione...';

    // Riconnetti se necessario
    if (!BT.writeChar || !BT.server?.connected) {
      BT.writeChar = null;
      BT.server = null;
      BT.device = null;
      const name = await connectPrinter();
      btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Stampa su ${name}...`;
    } else {
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Stampa...';
    }

    const canvas = await captureLabel();
    const packet = buildTsplPacket(canvas);

    btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Invio ${packet.length} byte...`;
    await sendChunked(BT.writeChar, packet);

    btn.innerHTML = '<i class="fas fa-check"></i> Stampato!';
    if (navigator.vibrate) navigator.vibrate([100, 50, 100]);

    setTimeout(() => {
      btn.disabled = false;
      btn.innerHTML = '<i class="fab fa-bluetooth-b"></i> Stampa BT';
    }, 2500);

  } catch (err) {
    btn.disabled = false;
    btn.innerHTML = '<i class="fab fa-bluetooth-b"></i> Stampa BT';

    // NotFoundError = utente ha annullato il selettore dispositivi
    if (err.name !== "NotFoundError") {
      console.error("[BT] Errore:", err);
      alert(`Errore stampa Bluetooth:\n\n${err.message}`);
    }
  }
}
