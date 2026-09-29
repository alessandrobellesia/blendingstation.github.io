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

/* ---- Stato riquadro di ritaglio (crop box) ----
 * Coordinate in pixel "a schermo" relative a #photoWrap (non pixel naturali
 * della foto). La conversione a pixel naturali avviene in
 * getCropRectNatural() al momento dell'analisi.
 */
const CROP = {
  x: 0,
  y: 0,
  w: 0,
  h: 0,
  dragging: false,
  resizing: false,
  resizingTL: false,
  startX: 0,
  startY: 0,
  startRect: null,
  _wired: false,
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
  img.removeAttribute("src");
  document.getElementById("photoWrap").style.display = "none";
  document.getElementById("cropBox").style.display = "none";
  document.getElementById("cropHint").style.display = "none";
  document.getElementById("analyzeBtn").style.display = "none";
  document.getElementById("cameraPlaceholder").style.display = "flex";
  document.getElementById("captureBtn").style.display = "inline-flex";
  document.getElementById("retakeBtn").style.display = "none";
  CROP.w = 0;
  CROP.h = 0;

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
    document.getElementById("photoWrap").style.display = "block";
    document.getElementById("captureBtn").style.display = "none";
    document.getElementById("retakeBtn").style.display = "inline-flex";
    document.getElementById("analyzeBtn").style.display = "inline-flex";
    document.getElementById("cropHint").style.display = "block";
    initCropBox();
    analyzePhoto();
  };
  img.src = OCR._photoObjectUrl;
}

/** Chiamata quando si sposta lo slider soglia: rianalizza la stessa foto già scattata, senza dover riscattare. */
function onThresholdChange(value) {
  document.getElementById("thresholdValue").textContent = value;
  const wrap = document.getElementById("photoWrap");
  if (wrap && wrap.style.display !== "none") {
    analyzePhoto();
  }
}

/* =========================================================
 * RIQUADRO DI RITAGLIO (crop box) — trascinabile e ridimensionabile
 * ========================================================= */

/** Inizializza/riposiziona il riquadro di ritaglio con un default centrato
 * sulla foto appena caricata, e collega i gestori di trascinamento/resize
 * (una sola volta). */
function initCropBox() {
  const wrap = document.getElementById("photoWrap");
  const box = document.getElementById("cropBox");
  const img = document.getElementById("capturedPhotoImg");

  box.style.display = "block";

  // Rettangolo di default: centrato, 90% larghezza, 35% altezza del display
  const ww = wrap.clientWidth;
  const wh = img.clientHeight || wrap.clientHeight;
  const w = ww * 0.9;
  const h = Math.max(50, wh * 0.35);
  const x = (ww - w) / 2;
  const y = (wh - h) / 2;
  setCropRect(x, y, w, h);

  wireCropHandlers();
}

function setCropRect(x, y, w, h) {
  const wrap = document.getElementById("photoWrap");
  const img = document.getElementById("capturedPhotoImg");
  const box = document.getElementById("cropBox");
  if (!wrap || !img || !box) return;

  const maxW = wrap.clientWidth;
  const maxH = img.clientHeight;
  if (!maxW || !maxH) return;

  w = Math.max(30, Math.min(w, maxW));
  h = Math.max(20, Math.min(h, maxH));
  x = Math.max(0, Math.min(x, maxW - w));
  y = Math.max(0, Math.min(y, maxH - h));
  w = Math.min(w, maxW - x);
  h = Math.min(h, maxH - y);

  CROP.x = x;
  CROP.y = y;
  CROP.w = w;
  CROP.h = h;

  box.style.left = x + "px";
  box.style.top = y + "px";
  box.style.width = w + "px";
  box.style.height = h + "px";
}

function wireCropHandlers() {
  if (CROP._wired) return;
  CROP._wired = true;

  const box = document.getElementById("cropBox");
  const handle = document.getElementById("cropHandle");
  const handleTL = document.getElementById("cropHandleTL");

  box.addEventListener("pointerdown", function (e) {
    if (e.target === handle || e.target === handleTL) return; // il resize lo gestiscono gli handle
    e.preventDefault();
    CROP.dragging = true;
    CROP.startX = e.clientX;
    CROP.startY = e.clientY;
    CROP.startRect = { x: CROP.x, y: CROP.y, w: CROP.w, h: CROP.h };
    try { box.setPointerCapture(e.pointerId); } catch (err) {}
  });

  handle.addEventListener("pointerdown", function (e) {
    e.preventDefault();
    e.stopPropagation();
    CROP.resizing = true;
    CROP.startX = e.clientX;
    CROP.startY = e.clientY;
    CROP.startRect = { x: CROP.x, y: CROP.y, w: CROP.w, h: CROP.h };
    try { handle.setPointerCapture(e.pointerId); } catch (err) {}
  });

  handleTL.addEventListener("pointerdown", function (e) {
    e.preventDefault();
    e.stopPropagation();
    CROP.resizingTL = true;
    CROP.startX = e.clientX;
    CROP.startY = e.clientY;
    CROP.startRect = { x: CROP.x, y: CROP.y, w: CROP.w, h: CROP.h };
    try { handleTL.setPointerCapture(e.pointerId); } catch (err) {}
  });

  box.addEventListener("pointermove", handleCropMove);
  handle.addEventListener("pointermove", handleCropMove);
  handleTL.addEventListener("pointermove", handleCropMove);
  box.addEventListener("pointerup", handleCropEnd);
  handle.addEventListener("pointerup", handleCropEnd);
  handleTL.addEventListener("pointerup", handleCropEnd);
  box.addEventListener("pointercancel", handleCropEnd);
  handle.addEventListener("pointercancel", handleCropEnd);
  handleTL.addEventListener("pointercancel", handleCropEnd);
}

function handleCropMove(e) {
  if (CROP.dragging) {
    e.preventDefault();
    const dx = e.clientX - CROP.startX;
    const dy = e.clientY - CROP.startY;
    setCropRect(
      CROP.startRect.x + dx,
      CROP.startRect.y + dy,
      CROP.startRect.w,
      CROP.startRect.h,
    );
  } else if (CROP.resizing) {
    // Maniglia in basso a destra: l'angolo in alto a sinistra resta fisso.
    e.preventDefault();
    const dx = e.clientX - CROP.startX;
    const dy = e.clientY - CROP.startY;
    setCropRect(
      CROP.startRect.x,
      CROP.startRect.y,
      CROP.startRect.w + dx,
      CROP.startRect.h + dy,
    );
  } else if (CROP.resizingTL) {
    // Maniglia in alto a sinistra: l'angolo in basso a destra resta fisso.
    e.preventDefault();
    const dx = e.clientX - CROP.startX;
    const dy = e.clientY - CROP.startY;
    const fixedRight = CROP.startRect.x + CROP.startRect.w;
    const fixedBottom = CROP.startRect.y + CROP.startRect.h;
    const newX = CROP.startRect.x + dx;
    const newY = CROP.startRect.y + dy;
    setCropRect(newX, newY, fixedRight - newX, fixedBottom - newY);
  }
}

function handleCropEnd() {
  CROP.dragging = false;
  CROP.resizing = false;
  CROP.resizingTL = false;
}

/** Converte il riquadro di ritaglio (in pixel a schermo, relativi a
 * #photoWrap) in pixel naturali della foto scattata. */
function getCropRectNatural() {
  const img = document.getElementById("capturedPhotoImg");
  const wrap = document.getElementById("photoWrap");
  const scale = img.naturalWidth / wrap.clientWidth;
  return {
    x: Math.round(CROP.x * scale),
    y: Math.round(CROP.y * scale),
    w: Math.round(CROP.w * scale),
    h: Math.round(CROP.h * scale),
  };
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
    const box = document.getElementById("cropBox");
    const hasCrop = CROP.w > 0 && CROP.h > 0 && box && box.style.display !== "none";
    const ctx = OCR.canvas.getContext("2d");

    if (hasCrop) {
      const crop = getCropRectNatural();
      OCR.canvas.width = crop.w;
      OCR.canvas.height = crop.h;
      ctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
    } else {
      OCR.canvas.width = img.naturalWidth;
      OCR.canvas.height = img.naturalHeight;
      ctx.drawImage(img, 0, 0);
    }

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
    if (OCR._debugStrings) {
      debugText.textContent += `\n🔤 Stringa letta: O₂="${OCR._debugStrings.o2}" He="${OCR._debugStrings.he}"`;
    }
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

  OCR._debugStrings = { o2: "", he: "" };

  return {
    o2: bands.length >= 1 ? extractNumberFromBand(mask, width, bands[0], "o2") : null,
    he: bands.length >= 2 ? extractNumberFromBand(mask, width, bands[1], "he") : null,
    rows: bands.length,
  };
}

function extractNumberFromBand(mask, width, band, debugKey) {
  const { start, end } = band;

  // Densità per colonna nella banda
  const colDensity = new Array(width).fill(0);
  for (let y = start; y < end; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) colDensity[x]++;
    }
  }

  // Regioni delle singole cifre. Soglia più bassa del passato (era 0.1) per
  // non fondere cifre molto ravvicinate come "2" e "1" in "21".
  const maxCol = Math.max(...colDensity);
  const threshold = maxCol * 0.06;
  let digitRegions = [];
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
  // Una cifra può toccare il bordo destro della banda ritagliata: senza
  // questo, l'ultima cifra andrebbe persa.
  if (inDigit) {
    const digitWidth = width - digitStart;
    if (digitWidth > 3) {
      digitRegions.push({
        x1: digitStart,
        x2: width,
        y1: start,
        y2: end,
        width: digitWidth,
      });
    }
  }

  // Se due cifre si toccano (spaziatura del display troppo stretta perché la
  // densità di colonna scenda sotto soglia), la regione risultante è molto
  // più larga delle altre. Usiamo la larghezza "di riferimento" (mediana
  // delle regioni non-punto) per dividerla in N cifre uguali invece di farla
  // riconoscere come un unico simbolo sbagliato (es. "21" letto come "7").
  const roughAvg =
    digitRegions.reduce((s, r) => s + r.width, 0) / (digitRegions.length || 1);
  const singleWidths = digitRegions
    .filter((r) => r.width >= roughAvg * 0.4)
    .map((r) => r.width)
    .sort((a, b) => a - b);
  const refWidth = singleWidths.length
    ? singleWidths[Math.floor(singleWidths.length / 2)]
    : roughAvg;

  if (refWidth > 0) {
    const splitRegions = [];
    for (const region of digitRegions) {
      const isLikelyDecimal = region.width < roughAvg * 0.4;
      const parts = isLikelyDecimal
        ? 1
        : Math.max(1, Math.round(region.width / refWidth));
      if (parts <= 1) {
        splitRegions.push(region);
        continue;
      }
      const partWidth = (region.x2 - region.x1) / parts;
      for (let p = 0; p < parts; p++) {
        splitRegions.push({
          x1: Math.round(region.x1 + p * partWidth),
          x2: Math.round(region.x1 + (p + 1) * partWidth),
          y1: region.y1,
          y2: region.y2,
          width: partWidth,
        });
      }
    }
    digitRegions = splitRegions;
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

  if (debugKey && OCR._debugStrings) OCR._debugStrings[debugKey] = numberStr;

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
