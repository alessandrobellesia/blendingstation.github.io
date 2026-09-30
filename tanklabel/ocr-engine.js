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
    "Tocca \"Scatta Foto\". Se il display riflette, scatta leggermente in diagonale (non dritto davanti) per non farci vedere il riflesso del telefono.";

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
  OCR._lastCapture = null;
  const manualDetailsReset = document.getElementById("manualInputDetails");
  if (manualDetailsReset) manualDetailsReset.open = false;

  // Pre-riempi i campi manuali con i valori correnti
  document.getElementById("quickO2").value =
    (typeof DOM !== "undefined" ? DOM.inputs.o2Input.value : 21.0) || 21.0;
  document.getElementById("quickHe").value =
    (typeof DOM !== "undefined" ? DOM.inputs.heInput.value : 0.0) || 0.0;

  // Apre subito la fotocamera nativa, senza far toccare "Scatta Foto" come
  // passaggio intermedio. Va chiamato in modo sincrono (non in un
  // setTimeout) per restare dentro lo stesso "gesto utente" del tap sul
  // pulsante Scan, altrimenti alcuni browser/iOS bloccano l'apertura
  // automatica della fotocamera.
  triggerPhotoCapture();
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

/** Prova a individuare da sola la zona del display con i numeri accesi,
 * analizzando la foto intera a bassa risoluzione (stessa soglia luce dello
 * slider) e trovando il riquadro che contiene i pixel ambra/luminosi.
 * Ritorna un rettangolo in percentuale (0-1) rispetto alla foto, o null se
 * non trova nulla di affidabile (es. foto troppo scura/riflettente). */
function autoDetectCropRect(img) {
  try {
    const natW = img.naturalWidth,
      natH = img.naturalHeight;
    if (!natW || !natH) return null;

    // Analisi a bassa risoluzione: basta per trovare la zona, ed è veloce.
    const maxDim = 500;
    const scale = Math.min(1, maxDim / Math.max(natW, natH));
    const w = Math.max(1, Math.round(natW * scale));
    const h = Math.max(1, Math.round(natH * scale));

    const tmpCanvas = document.createElement("canvas");
    tmpCanvas.width = w;
    tmpCanvas.height = h;
    const tctx = tmpCanvas.getContext("2d");
    tctx.drawImage(img, 0, 0, w, h);

    const threshold = parseInt(
      document.getElementById("thresholdSlider")?.value ?? 220,
    );
    const imageData = tctx.getImageData(0, 0, w, h);
    const { mask, count } = extractLightPixels(imageData, threshold);

    // Troppo pochi pixel accesi: non è un rilevamento affidabile.
    if (count < w * h * 0.005) return null;

    const rowDensity = new Array(h).fill(0);
    const colDensity = new Array(w).fill(0);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (mask[y * w + x]) {
          rowDensity[y]++;
          colDensity[x]++;
        }
      }
    }

    const maxRow = Math.max(...rowDensity);
    const maxCol = Math.max(...colDensity);
    if (maxRow === 0 || maxCol === 0) return null;

    const rowThresh = maxRow * 0.08;
    const colThresh = maxCol * 0.08;

    let top = -1,
      bottom = -1,
      left = -1,
      right = -1;
    for (let y = 0; y < h; y++) {
      if (rowDensity[y] > rowThresh) {
        if (top === -1) top = y;
        bottom = y;
      }
    }
    for (let x = 0; x < w; x++) {
      if (colDensity[x] > colThresh) {
        if (left === -1) left = x;
        right = x;
      }
    }
    if (top === -1 || left === -1) return null;

    // Margine di sicurezza attorno alla zona rilevata, per non tagliare i
    // bordi delle cifre (più margine in verticale: le cifre alte e strette
    // come "1" hanno una densità per riga bassa vicino a inizio/fine).
    const boxW = right - left;
    const boxH = bottom - top;
    const padX = Math.max(4, boxW * 0.1);
    const padY = Math.max(4, boxH * 0.2);

    left = Math.max(0, left - padX);
    right = Math.min(w, right + padX);
    top = Math.max(0, top - padY);
    bottom = Math.min(h, bottom + padY);

    return {
      xPct: left / w,
      yPct: top / h,
      wPct: (right - left) / w,
      hPct: (bottom - top) / h,
    };
  } catch (err) {
    return null;
  }
}

/** Inizializza/riposiziona il riquadro di ritaglio: prova prima a
 * posizionarlo da sola sui numeri accesi (autoDetectCropRect), e solo se
 * non trova nulla di affidabile usa un default centrato. Collega poi i
 * gestori di trascinamento/resize (una sola volta). */
function initCropBox() {
  const wrap = document.getElementById("photoWrap");
  const box = document.getElementById("cropBox");
  const img = document.getElementById("capturedPhotoImg");

  box.style.display = "block";

  const ww = wrap.clientWidth;
  const wh = img.clientHeight || wrap.clientHeight;

  const detected = autoDetectCropRect(img);
  let x, y, w, h;
  if (detected) {
    w = ww * detected.wPct;
    h = wh * detected.hPct;
    x = ww * detected.xPct;
    y = wh * detected.yPct;
  } else {
    // Rettangolo di default: centrato, 90% larghezza, 35% altezza del display
    w = ww * 0.9;
    h = Math.max(50, wh * 0.35);
    x = (ww - w) / 2;
    y = (wh - h) / 2;
  }
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
      document.getElementById("thresholdSlider")?.value ?? 220,
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
    if (OCR._debugOverrides && OCR._debugOverrides.length) {
      debugText.textContent += `\n🔁 Scambi 1↔4 applicati: ${OCR._debugOverrides.join(", ")}`;
    }
    debugText.textContent += `\n🔢 Valori: O₂=${result.o2 !== null ? result.o2.toFixed(1) : "?"}, He=${result.he !== null ? result.he.toFixed(1) : "?"}`;
    try {
      const learned = loadLearnedTemplates();
      const learnedCount = Object.values(learned).reduce(
        (s, arr) => s + (Array.isArray(arr) ? arr.length : 0),
        0,
      );
      if (learnedCount > 0) {
        debugText.textContent += `\n🧠 Forme imparate da questo dispositivo: ${learnedCount}`;
      }
    } catch (e) {}
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
        "✅ Valori rilevati! Se sono giusti tocca Conferma, se una cifra è sbagliata correggila in \"Inserimento manuale\" qui sotto prima di confermare.";

      // Teniamo i campi di inserimento manuale allineati al valore appena
      // letto: così, se una cifra è sbagliata, l'utente la corregge lì
      // invece di dover ripartire da zero — ed è anche da lì che
      // confirmScanValues() prende il valore definitivo.
      if (result.o2 !== null) {
        document.getElementById("quickO2").value = result.o2.toFixed(1);
      }
      if (result.he !== null) {
        document.getElementById("quickHe").value = result.he.toFixed(1);
      }
      // Apriamo subito i campi correggibili, altrimenti sono nascosti in
      // una sezione richiudibile che l'utente potrebbe non notare.
      const manualDetails = document.getElementById("manualInputDetails");
      if (manualDetails) manualDetails.open = true;

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

/** Se il valore finale confermato ha la stessa "forma" (stesse posizioni di
 * cifre e punto) di quello letto automaticamente, insegna al motore la
 * forma reale di ogni cifra — corretta o già giusta che fosse. Se le
 * lunghezze non coincidono (es. l'utente ha riscritto tutto da zero) non
 * alliniamo nulla, per non insegnare forme sbagliate. */
function learnFromCapture(capture, finalValue) {
  if (!capture || finalValue === null || isNaN(finalValue)) return;
  const finalStr = finalValue.toFixed(1);
  if (finalStr.length !== capture.str.length) return;

  for (let i = 0; i < finalStr.length; i++) {
    const ch = finalStr[i];
    if (ch === ".") continue;
    const grid = capture.grids[i];
    if (grid) learnDigitShape(ch, grid);
  }
}

function confirmScanValues() {
  // Il valore definitivo viene sempre dai campi di "Inserimento manuale":
  // dopo uno scan riuscito vengono precompilati col valore letto, quindi se
  // l'utente non tocca nulla equivalgono al risultato automatico, ma se una
  // cifra era sbagliata l'utente l'ha già corretta lì.
  const o2 = parseFloat(document.getElementById("quickO2").value);
  const he = parseFloat(document.getElementById("quickHe").value);
  const finalO2 = !isNaN(o2) ? o2 : OCR.detectedO2 !== null ? OCR.detectedO2 : 21;
  const finalHe = !isNaN(he) ? he : OCR.detectedHe !== null ? OCR.detectedHe : 0;

  if (OCR._lastCapture) {
    learnFromCapture(OCR._lastCapture.o2, finalO2);
    learnFromCapture(OCR._lastCapture.he, finalHe);
  }

  if (typeof DOM !== "undefined") {
    DOM.inputs.o2Input.value = finalO2;
    DOM.inputs.heInput.value = finalHe;
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
    // Il riflesso di un telefono/luce sul vetro del display è quasi bianco
    // puro (r≈g≈b), mentre le cifre vere del display sono giallo/ambra
    // (r ben più alto di b). Anche sulla via "solo luminosità" scartiamo i
    // pixel troppo neutri, così un riflesso molto luminoso non si mescola
    // alle cifre reali.
    const warmEnough = r - b > 15;

    if ((luma > threshold && warmEnough) || isYellowAmber) {
      mask[i / 4] = 1;
      count++;
    }
  }

  return { mask, count, width, height };
}

/** Alias di compatibilità — legge la soglia dallo slider UI */
function extractYellowPixels(imageData) {
  const threshold = parseInt(
    document.getElementById("thresholdSlider")?.value ?? 220,
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
  OCR._debugOverrides = [];

  return {
    o2: bands.length >= 1 ? extractNumberFromBand(mask, width, bands[0], "o2") : null,
    he: bands.length >= 2 ? extractNumberFromBand(mask, width, bands[1], "he") : null,
    rows: bands.length,
  };
}

/** Un punto decimale occupa solo la parte bassa della cifra (poche righe
 * vicino alla base), mentre qualunque cifra — anche una stretta come "1" —
 * attraversa quasi tutta l'altezza della banda. Guardare la sola larghezza
 * confonde le due cose su font dove il "1" è molto sottile; l'estensione
 * verticale reale dei pixel accesi è un indizio molto più affidabile e non
 * dipende dal font del display. */
function isDecimalPoint(mask, width, region, bandHeight) {
  const { x1, x2, y1, y2 } = region;
  let top = null,
    bottom = null;
  for (let y = y1; y < y2; y++) {
    let rowHas = false;
    for (let x = x1; x < x2; x++) {
      if (mask[y * width + x]) {
        rowHas = true;
        break;
      }
    }
    if (rowHas) {
      if (top === null) top = y;
      bottom = y;
    }
  }
  if (top === null) return false; // regione vuota: non trattarla come punto
  const extent = bottom - top + 1;
  return extent < bandHeight * 0.35;
}

/** Divide una regione (che il rilevatore ritiene contenga `parts` cifre
 * incollate) nei punti di minima densità di pixel colonna-per-colonna,
 * invece che in parti geometricamente uguali. Ripete la ricerca del "punto
 * più stretto" sul pezzo più largo finché non si ottengono `parts` pezzi, o
 * finché non trova più un punto di divisione sensato (evita divisioni
 * degeneri troppo vicine ai bordi). */
function splitRegionAtValleys(colDensity, region, parts) {
  let pieces = [region];

  while (pieces.length < parts) {
    pieces.sort((a, b) => (b.x2 - b.x1) - (a.x2 - a.x1));
    const target = pieces.shift();
    const w = target.x2 - target.x1;
    const margin = Math.max(2, Math.floor(w * 0.22));

    if (w - margin * 2 < 3) {
      // troppo stretto per dividere in modo sensato
      pieces.push(target);
      break;
    }

    let splitX = -1,
      bestVal = Infinity;
    for (let x = target.x1 + margin; x < target.x2 - margin; x++) {
      if (colDensity[x] < bestVal) {
        bestVal = colDensity[x];
        splitX = x;
      }
    }

    if (splitX < 0) {
      pieces.push(target);
      break;
    }

    pieces.push({
      x1: target.x1,
      x2: splitX,
      y1: target.y1,
      y2: target.y2,
      width: splitX - target.x1,
    });
    pieces.push({
      x1: splitX,
      x2: target.x2,
      y1: target.y1,
      y2: target.y2,
      width: target.x2 - splitX,
    });
  }

  pieces.sort((a, b) => a.x1 - b.x1);
  return pieces;
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
  const bandHeight = end - start;
  const singleWidths = digitRegions
    .filter((r) => !isDecimalPoint(mask, width, r, bandHeight))
    .map((r) => r.width)
    .sort((a, b) => a - b);
  const roughAvg =
    digitRegions.reduce((s, r) => s + r.width, 0) / (digitRegions.length || 1);
  const refWidth = singleWidths.length
    ? singleWidths[Math.floor(singleWidths.length / 2)]
    : roughAvg;

  if (refWidth > 0) {
    const splitRegions = [];
    for (const region of digitRegions) {
      const isLikelyDecimal = isDecimalPoint(mask, width, region, bandHeight);
      const parts = isLikelyDecimal
        ? 1
        : Math.max(1, Math.round(region.width / refWidth));
      if (parts <= 1) {
        splitRegions.push(region);
        continue;
      }
      // Non dividiamo a metà esatta: due cifre che si toccano quasi mai hanno
      // la stessa larghezza (es. "2" largo + "1" stretto in "21"). Cerchiamo
      // invece il punto di minima densità di pixel ("valle") tra le due, che
      // segue la vera forma delle cifre invece di una divisione geometrica.
      splitRegions.push(
        ...splitRegionAtValleys(colDensity, region, parts),
      );
    }
    digitRegions = splitRegions;
  }

  // Ricostruzione stringa numerica. Teniamo anche, posizione per posizione,
  // la griglia di ogni cifra (null per il punto): serve dopo, se l'utente
  // conferma/corregge il valore, per "insegnare" quella forma al motore
  // (vedi learnDigitShape).
  let numberStr = "";
  const digitGrids = [];

  for (const region of digitRegions) {
    if (isDecimalPoint(mask, width, region, bandHeight)) {
      numberStr += "."; // punto decimale: pixel confinati in basso
      digitGrids.push(null);
    } else {
      const grid = computeDigitGrid(mask, width, region);
      numberStr += matchDigitGrid(grid).digit;
      digitGrids.push(grid);
    }
  }

  if (debugKey && OCR._debugStrings) OCR._debugStrings[debugKey] = numberStr;
  if (debugKey) {
    if (!OCR._lastCapture) OCR._lastCapture = {};
    OCR._lastCapture[debugKey] = { str: numberStr, grids: digitGrids };
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

/** Costruisce solo la griglia 14×24 di intensità per una regione — la parte
 * "immagine → numeri" del riconoscimento, separata dal confronto coi
 * template così la griglia può essere salvata (per l'apprendimento) anche
 * quando il confronto sbaglia. */
function computeDigitGrid(mask, maskWidth, region) {
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

  return grid;
}

/* =========================================================
 * MODELLI "IMPARATI" DAL DISPOSITIVO DELL'UTENTE
 * ========================================================= *
 * I template statici (digit-templates.js) sono tarati su UN font. I test
 * mostrano che analizzatori diversi (font diversi) confondono cifre diverse
 * fra loro, quindi nessuna correzione fissa va bene per tutti. Invece,
 * quando l'utente conferma/corregge una lettura, salviamo la forma reale
 * delle cifre di QUEL display come "template personale" per quell'app
 * (localStorage): nel tempo il confronto si allinea al font vero in uso.
 */
const LEARN_STORAGE_KEY = "tanklabel_learned_digit_templates_v1";
const LEARN_MAX_VARIANTS_PER_DIGIT = 6;

function loadLearnedTemplates() {
  if (OCR._learnedTemplates) return OCR._learnedTemplates;
  let parsed = {};
  try {
    const raw = localStorage.getItem(LEARN_STORAGE_KEY);
    if (raw) parsed = JSON.parse(raw) || {};
  } catch (e) {
    parsed = {};
  }
  OCR._learnedTemplates = parsed;
  return parsed;
}

function saveLearnedTemplates(templates) {
  OCR._learnedTemplates = templates;
  try {
    localStorage.setItem(LEARN_STORAGE_KEY, JSON.stringify(templates));
  } catch (e) {
    // localStorage pieno/non disponibile: l'apprendimento resta solo in
    // memoria per questa sessione, non è un errore bloccante.
  }
}

/** Copia (o mostra, se il copia-incolla non è disponibile) i modelli
 * imparati su QUESTO telefono, come testo da incollare in chat. Serve per
 * portare l'apprendimento di un dispositivo dentro ai template statici
 * dell'app (digit-templates.js), così tutti partono da una base migliore
 * invece di dover riaddestrare l'app da zero ognuno sul proprio telefono. */
function exportLearnedTemplates() {
  const templates = loadLearnedTemplates();
  const count = Object.values(templates).reduce(
    (s, arr) => s + (Array.isArray(arr) ? arr.length : 0),
    0,
  );
  const statusEl = document.getElementById("exportLearnedStatus");

  if (count === 0) {
    if (statusEl) {
      statusEl.textContent = "Nessun modello ancora imparato su questo telefono — usa lo scan e conferma qualche lettura prima.";
    }
    return;
  }

  const json = JSON.stringify(templates, null, 0);

  const showFallback = () => {
    const ta = document.getElementById("exportLearnedText");
    if (ta) {
      ta.style.display = "block";
      ta.value = json;
      ta.focus();
      ta.select();
    }
    if (statusEl) {
      statusEl.textContent = `${count} forme pronte qui sotto: seleziona tutto (già selezionato) e copia, poi incollalo in chat.`;
    }
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(json)
      .then(() => {
        if (statusEl) {
          statusEl.textContent = `✅ Copiati ${count} modelli imparati negli appunti — incollali in chat.`;
        }
      })
      .catch(showFallback);
  } else {
    showFallback();
  }
}

/** Registra la forma reale (griglia) di una cifra confermata dall'utente
 * come nuova cifra "0"-"9" — usata da confirmScanValues() quando l'utente
 * accetta o corregge una lettura. */
function learnDigitShape(digitChar, grid) {
  if (!grid || !/^[0-9]$/.test(digitChar)) return;
  const templates = loadLearnedTemplates();
  if (!Array.isArray(templates[digitChar])) templates[digitChar] = [];
  templates[digitChar].push({ data: grid });
  // FIFO: teniamo solo le varianti più recenti per cifra.
  while (templates[digitChar].length > LEARN_MAX_VARIANTS_PER_DIGIT) {
    templates[digitChar].shift();
  }
  saveLearnedTemplates(templates);
}

/** Confronta una griglia coi template statici + quelli imparati da questo
 * dispositivo. I modelli imparati competono alla pari con quelli statici:
 * essendo catture reali dello stesso font, con l'uso finiscono per
 * "vincere" naturalmente sulle cifre che quel font confonde. */
function matchDigitGrid(grid) {
  let bestDigit = "?",
    bestScore = Infinity;

  const learned = loadLearnedTemplates();
  const allSources = [
    DIGIT_TEMPLATES,
    ...(typeof LEARNED_TEMPLATES_BASELINE !== "undefined" ? [LEARNED_TEMPLATES_BASELINE] : []),
    learned,
  ];

  for (const source of allSources) {
    for (const [digit, variants] of Object.entries(source)) {
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
  }

  const matchQuality = 1 - bestScore / (GRID_W * GRID_H * 8);
  // Soglia al 40% (tolleranza aumentata rispetto al 50% originale)
  if (matchQuality < 0.4) return { digit: "?", quality: matchQuality };

  return { digit: bestDigit, quality: matchQuality };
}

/** Riconosce una cifra a partire dalla regione nell'immagine: calcola la
 * griglia e la confronta coi template. Usata dove serve solo il carattere
 * (non serve salvare la griglia per l'apprendimento). */
function recognizeDigitGrid(mask, maskWidth, region) {
  const grid = computeDigitGrid(mask, maskWidth, region);
  return matchDigitGrid(grid).digit;
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
