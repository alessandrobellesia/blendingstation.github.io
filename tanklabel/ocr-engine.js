/**
 * TankLabel - ocr-engine.js
 * Motore di riconoscimento ottico per display analizzatori subacquei.
 * Estratto da index.html come parte del refactoring v4.0
 *
 * v2: la cattura non usa più un feed video live (getUserMedia) — troppo
 * spesso mosso/sfocato. Ora si usa lo scatto foto nativo del telefono
 * tramite <input type="file" capture="environment">, che resta dentro il
 * flusso dell'app (nessuna app fotocamera separata da cui tornare) ma
 * sfrutta autofocus/esposizione della fotocamera di sistema. La foto
 * catturata resta disponibile per rianalizzarla con soglie diverse senza
 * dover riscattare.
 *
 * Dipendenze:
 *   - digit-templates.js (deve essere caricato prima)
 *   - DOM: #photoInput, #capturedPhotoImg, #cameraPlaceholder, #captureBtn,
 *          #retakeBtn, #captureCanvas, #ocrModal, #thresholdSlider,
 *          #maskPreviewWrap, #maskCanvas, #scanResults, #detectedO2,
 *          #detectedHe, #confirmBtn, #scanInstructions, #debugPanel,
 *          #debugText, #quickO2, #quickHe
 */

"use strict";

/* ---- Stato OCR ---- */
const OCR = {
  get canvas() {
    return document.getElementById("captureCanvas");
  },
  get modal() {
    return document.getElementById("ocrModal");
  },
  detectedO2: null,
  detectedHe: null,
  _usedFallback: false,
  _photoObjectUrl: null,
};

/* ---- Pattern 7 segmenti (non più usati attivamente, mantenuti per riferimento) ---- */
const DIGIT_PATTERNS = {
  0: [1, 1, 1, 0, 1, 1, 1],
  1: [0, 0, 1, 0, 0, 1, 0],
  2: [1, 0, 1, 1, 1, 0, 1],
  3: [1, 0, 1, 1, 0, 1, 1],
  4: [0, 1, 1, 1, 0, 1, 0],
  5: [1, 1, 0, 1, 0, 1, 1],
  6: [1, 1, 0, 1, 1, 1, 1],
  7: [1, 0, 1, 0, 0, 1, 0],
  8: [1, 1, 1, 1, 1, 1, 1],
  9: [1, 1, 1, 1, 0, 1, 1],
};

/* ---- Costanti template ---- */
const GRID_W = DIGIT_TEMPLATES.GRID_WIDTH; // 14
const GRID_H = DIGIT_TEMPLATES.GRID_HEIGHT; // 24

/* =========================================================
 * APERTURA / CHIUSURA MODALE
 * ========================================================= */

function openOcrModal() {
  OCR.modal.classList.add("active");
  document.body.style.overflow = "hidden";
  document.body.style.position = "fixed";
  document.body.style.width = "100%";
  OCR.detectedO2 = null;
  OCR.detectedHe = null;

  // Reset UI
  document.getElementById("scanResults").style.display = "none";
  document.getElementById("confirmBtn").style.display = "none";
  document.getElementById("debugPanel").style.display = "none";
  document.getElementById("maskPreviewWrap").style.display = "none";
  document.getElementById("scanInstructions").textContent =
    "Tocca \"Scatta Foto\" e inquadra il display dell'analizzatore";

  // Reset foto precedente (se l'utente riapre la modale dopo una scansione)
  const img = document.getElementById("capturedPhotoImg");
  img.style.display = "none";
  img.removeAttribute("src");
  document.getElementById("cameraPlaceholder").style.display = "flex";
  document.getElementById("captureBtn").style.display = "inline-flex";
  document.getElementById("retakeBtn").style.display = "none";

  // Pre-riempi i campi manuali con i valori correnti
  document.getElementById("quickO2").value =
    (typeof DOM !== "undefined" ? DOM.inputs.o2Input.value : 21.0) || 21.0;
  document.getElementById("quickHe").value =
    (typeof DOM !== "undefined" ? DOM.inputs.heInput.value : 0.0) || 0.0;
}

function closeOcrModal() {
  if (OCR._photoObjectUrl) {
    URL.revokeObjectURL(OCR._photoObjectUrl);
    OCR._photoObjectUrl = null;
  }
  OCR.modal.classList.remove("active");
  document.body.style.overflow = "";
  document.body.style.position = "";
  document.body.style.width = "";
}

/* =========================================================
 * SCATTO FOTO (nativo, resta dentro l'app)
 * ========================================================= */

function triggerPhotoCapture() {
  const input = document.getElementById("photoInput");
  input.value = ""; // permette di riselezionare la stessa foto se si rifà lo scatto
  input.click();
}

function handlePhotoSelected(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  const img = document.getElementById("capturedPhotoImg");
  const placeholder = document.getElementById("cameraPlaceholder");

  if (OCR._photoObjectUrl) URL.revokeObjectURL(OCR._photoObjectUrl);
  OCR._photoObjectUrl = URL.createObjectURL(file);

  img.onload = function () {
    placeholder.style.display = "none";
    img.style.display = "block";
    document.getElementById("captureBtn").style.display = "none";
    document.getElementById("retakeBtn").style.display = "inline-flex";
    analyzePhoto();
  };
  img.src = OCR._photoObjectUrl;
}

/** Chiamata quando si sposta lo slider soglia: rianalizza la stessa foto già scattata, senza dover riscattare. */
function onThresholdChange(value) {
  document.getElementById("thresholdValue").textContent = value;
  const img = document.getElementById("capturedPhotoImg");
  if (img && img.style.display !== "none" && img.src) {
    analyzePhoto();
  }
}

/* =========================================================
 * ANALISI PRINCIPALE (sulla foto scattata)
 * ========================================================= */

function analyzePhoto() {
  const img = document.getElementById("capturedPhotoImg");
  const debugPanel = document.getElementById("debugPanel");
  const debugText = document.getElementById("debugText");

  debugPanel.style.display = "block";
  debugText.textContent = "Analisi foto...";

  try {
    OCR.canvas.width = img.naturalWidth;
    OCR.canvas.height = img.naturalHeight;
    const ctx = OCR.canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);

    const threshold = parseInt(
      document.getElementById("thresholdSlider")?.value ?? 110,
    );
    debugText.textContent = `📐 Immagine: ${OCR.canvas.width}x${OCR.canvas.height}\n💡 Soglia luce: ${threshold}\n⚙️ Estrazione pixel...`;

    const imageData = ctx.getImageData(
      0,
      0,
      OCR.canvas.width,
      OCR.canvas.height,
    );
    const lightMask = extractLightPixels(imageData, threshold);

    const totalPx = OCR.canvas.width * OCR.canvas.height;
    const pct = ((lightMask.count / totalPx) * 100).toFixed(1);
    debugText.textContent += `\n✅ Pixel rilevati: ${lightMask.count} (${pct}%)`;

    renderMaskPreview(lightMask.mask, lightMask.width, lightMask.height);

    const pixelRatio = lightMask.count / totalPx;
    if (pixelRatio < 0.005) {
      debugText.textContent += "\n⚠️ Troppo scuro: abbassa la soglia";
    } else if (pixelRatio > 0.4) {
      debugText.textContent += "\n⚠️ Troppa luce: alza la soglia";
    }

    OCR._usedFallback = false;
    const result = recognizeDigits(
      lightMask,
      OCR.canvas.width,
      OCR.canvas.height,
    );

    debugText.textContent += `\n📊 Righe cifre trovate: ${result.rows}`;
    debugText.textContent += `\n🔢 Valori: O₂=${result.o2 !== null ? result.o2.toFixed(1) : "?"}, He=${result.he !== null ? result.he.toFixed(1) : "?"}`;
    if (OCR._usedFallback) {
      debugText.textContent += "\n⚠️ Fallback attivo: cifre parziali recuperate";
    }

    if (result.o2 !== null || result.he !== null) {
      OCR.detectedO2 = result.o2;
      OCR.detectedHe = result.he;

      document.getElementById("detectedO2").textContent =
        result.o2 !== null ? result.o2.toFixed(1) : "--";
      document.getElementById("detectedHe").textContent =
        result.he !== null ? result.he.toFixed(1) : "--";
      document.getElementById("scanResults").style.display = "block";
      document.getElementById("confirmBtn").style.display = "inline-flex";
      document.getElementById("scanInstructions").textContent =
        "✅ Valori rilevati! Verifica e conferma, oppure regola la soglia 💡 o rifai la foto.";

      if (navigator.vibrate) navigator.vibrate(200);
    } else {
      document.getElementById("scanInstructions").textContent =
        "❌ Lettura fallita. Regola la soglia 💡, oppure rifai la foto o usa inserimento manuale.";
    }
  } catch (e) {
    console.error("Scan error:", e);
    debugText.textContent += `\n❌ Errore: ${e.message}`;
    document.getElementById("scanInstructions").textContent =
      "❌ Errore durante l'analisi.";
  }
}

function confirmScanValues() {
  let o2 = OCR.detectedO2;
  let he = OCR.detectedHe;

  if (o2 === null)
    o2 = parseFloat(document.getElementById("quickO2").value) || 21;
  if (he === null)
    he = parseFloat(document.getElementById("quickHe").value) || 0;

  if (typeof DOM !== "undefined") {
    DOM.inputs.o2Input.value = o2;
    DOM.inputs.heInput.value = he;
    if (typeof updatePreview === "function") updatePreview();
    if (typeof saveSettings === "function") saveSettings();
  }

  closeOcrModal();
  if (navigator.vibrate) navigator.vibrate(100);
}

/* =========================================================
 * ESTRAZIONE PIXEL (basata su luminosità)
 * ========================================================= */

/**
 * Estrae i pixel "luminosi" dall'imageData usando:
 *  1. Luminosità percepita (luma ITU-R BT.601) > soglia
 *  2. OR colore giallo/ambra specifico (fallback per display Divesoft)
 */
function extractLightPixels(imageData, threshold) {
  const { data, width, height } = imageData;
  const mask = new Uint8Array(width * height);
  let count = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i],
      g = data[i + 1],
      b = data[i + 2];
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    const isYellowAmber = r > 140 && g > 90 && b < 130 && r > b * 1.3;

    if (luma > threshold || isYellowAmber) {
      mask[i / 4] = 1;
      count++;
    }
  }

  return { mask, count, width, height };
}

/** Alias di compatibilità — legge la soglia dallo slider UI */
function extractYellowPixels(imageData) {
  const threshold = parseInt(
    document.getElementById("thresholdSlider")?.value ?? 110,
  );
  return extractLightPixels(imageData, threshold);
}

/* =========================================================
 * ANTEPRIMA MASCHERA DEBUG
 * ========================================================= */

function renderMaskPreview(mask, width, height) {
  const wrap = document.getElementById("maskPreviewWrap");
  const canvas = document.getElementById("maskCanvas");
  if (!canvas) return;

  const scale = Math.min(1, 200 / height);
  const dw = Math.round(width * scale);
  const dh = Math.round(height * scale);

  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext("2d");
  const imgData = ctx.createImageData(dw, dh);

  for (let dy = 0; dy < dh; dy++) {
    for (let dx = 0; dx < dw; dx++) {
      const srcX = Math.floor(dx / scale);
      const srcY = Math.floor(dy / scale);
      const srcIdx = srcY * width + srcX;
      const dstIdx = (dy * dw + dx) * 4;
      const v = mask[srcIdx] ? 255 : 0;
      imgData.data[dstIdx] = v;
      imgData.data[dstIdx + 1] = v;
      imgData.data[dstIdx + 2] = v;
      imgData.data[dstIdx + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  wrap.style.display = "block";
}

/* =========================================================
 * RICONOSCIMENTO CIFRE
 * ========================================================= */

function recognizeDigits(lightMask, width, height) {
  const { mask } = lightMask;

  // Densità per riga
  const rowDensity = new Array(height).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) rowDensity[y]++;
    }
  }

  // Individuazione bande orizzontali (una per ogni numero)
  const maxDensity = Math.max(...rowDensity);
  const threshold = maxDensity * 0.15;
  const allBands = [];
  let inBand = false,
    bandStart = 0;

  for (let y = 0; y < height; y++) {
    if (rowDensity[y] > threshold && !inBand) {
      inBand = true;
      bandStart = y;
    } else if (rowDensity[y] <= threshold && inBand) {
      inBand = false;
      const bandHeight = y - bandStart;
      if (bandHeight > 20) {
        let totalPixels = 0;
        for (let by = bandStart; by < y; by++) totalPixels += rowDensity[by];
        allBands.push({
          start: bandStart,
          end: y,
          pixels: totalPixels,
          height: bandHeight,
        });
      }
    }
  }

  // Le due bande con più pixel (O₂ in cima, He in basso)
  allBands.sort((a, b) => b.pixels - a.pixels);
  const bands = allBands.slice(0, 2).sort((a, b) => a.start - b.start);

  return {
    o2: bands.length >= 1 ? extractNumberFromBand(mask, width, bands[0]) : null,
    he: bands.length >= 2 ? extractNumberFromBand(mask, width, bands[1]) : null,
    rows: bands.length,
  };
}

function extractNumberFromBand(mask, width, band) {
  const { start, end } = band;

  // Densità per colonna nella banda
  const colDensity = new Array(width).fill(0);
  for (let y = start; y < end; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) colDensity[x]++;
    }
  }

  // Regioni delle singole cifre
  const maxCol = Math.max(...colDensity);
  const threshold = maxCol * 0.1;
  const digitRegions = [];
  let inDigit = false,
    digitStart = 0;

  for (let x = 0; x < width; x++) {
    if (colDensity[x] > threshold && !inDigit) {
      inDigit = true;
      digitStart = x;
    } else if (colDensity[x] <= threshold && inDigit) {
      inDigit = false;
      const digitWidth = x - digitStart;
      if (digitWidth > 3) {
        digitRegions.push({
          x1: digitStart,
          x2: x,
          y1: start,
          y2: end,
          width: digitWidth,
        });
      }
    }
  }

  // Ricostruzione stringa numerica
  let numberStr = "";
  const avgWidth =
    digitRegions.reduce((s, r) => s + r.width, 0) / (digitRegions.length || 1);

  for (const region of digitRegions) {
    if (region.width < avgWidth * 0.4) {
      numberStr += "."; // probabile punto decimale
    } else {
      numberStr += recognizeDigitGrid(mask, width, region);
    }
  }

  const num = parseFloat(numberStr);
  if (!isNaN(num) && num >= 0 && num <= 100) return num;

  // Fallback: se ci sono cifre non riconosciute (?), prova a estrarre il
  // primo numero leggibile ignorando i caratteri ambigui.
  if (numberStr.includes("?")) {
    const cleaned = numberStr.replace(/\?/g, "");
    const match = cleaned.match(/\d+\.?\d*/);
    if (match) {
      const fallback = parseFloat(match[0]);
      if (!isNaN(fallback) && fallback >= 0 && fallback <= 100) {
        OCR._usedFallback = true;
        return fallback;
      }
    }
  }

  return null;
}

function recognizeDigitGrid(mask, maskWidth, region) {
  const { x1, x2, y1, y2 } = region;
  const regWidth = x2 - x1;
  const regHeight = y2 - y1;
  const grid = [];

  for (let gy = 0; gy < GRID_H; gy++) {
    const row = [];
    for (let gx = 0; gx < GRID_W; gx++) {
      const imgX1 = Math.floor(x1 + (gx / GRID_W) * regWidth);
      const imgX2 = Math.floor(x1 + ((gx + 1) / GRID_W) * regWidth);
      const imgY1 = Math.floor(y1 + (gy / GRID_H) * regHeight);
      const imgY2 = Math.floor(y1 + ((gy + 1) / GRID_H) * regHeight);

      let count = 0,
        total = 0;
      for (let y = imgY1; y < imgY2; y++) {
        for (let x = imgX1; x < imgX2; x++) {
          if (mask[y * maskWidth + x]) count++;
          total++;
        }
      }

      const ratio = total > 0 ? count / total : 0;
      let intensity;
      if (ratio > 0.6) intensity = 8;
      else if (ratio > 0.3) intensity = 7;
      else if (ratio > 0.1) intensity = 1;
      else intensity = 0;
      row.push(intensity);
    }
    grid.push(row);
  }

  let bestDigit = "?",
    bestScore = Infinity;

  for (const [digit, variants] of Object.entries(DIGIT_TEMPLATES)) {
    if (digit === "GRID_WIDTH" || digit === "GRID_HEIGHT") continue;
    if (!Array.isArray(variants)) continue;

    for (const variant of variants) {
      let totalDistance = 0;
      for (let y = 0; y < GRID_H; y++) {
        for (let x = 0; x < GRID_W; x++) {
          totalDistance += Math.abs(grid[y][x] - variant.data[y][x]);
        }
      }
      if (totalDistance < bestScore) {
        bestScore = totalDistance;
        bestDigit = digit;
      }
    }
  }

  const matchQuality = 1 - bestScore / (GRID_W * GRID_H * 8);
  // Soglia al 40% (tolleranza aumentata rispetto al 50% originale)
  return matchQuality >= 0.4 ? bestDigit : "?";
}

function sampleRegion(mask, width, x1, y1, x2, y2) {
  x1 = Math.floor(x1);
  y1 = Math.floor(y1);
  x2 = Math.floor(x2);
  y2 = Math.floor(y2);
  let count = 0,
    total = 0;
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      if (mask[y * width + x]) count++;
      total++;
    }
  }
  return total > 0 ? count / total : 0;
}
