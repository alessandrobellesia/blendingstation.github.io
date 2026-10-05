/**
 * TankLabel - export-utils.js
 * Funzioni di esportazione: PDF, Immagine, Stampa nativa, Condivisione.
 * Estratto da index.html come parte del refactoring v4.0
 *
 * Dipendenze:
 *   - jsPDF (caricato via CDN)
 *   - html2canvas (caricato via CDN)
 *   - DOM e CONFIG definiti in index.html
 *   - window.NativeApp (../native-app.js), only inside the Android app: share sheet
 *     and print dialog in place of downloads and window.print()
 */

"use strict";

/* =========================================================
 * UTILITÀ INTERNE
 * ========================================================= */

async function prepareCapture() {
  DOM.previewContainer.classList.add("printing");
  await new Promise((r) => setTimeout(r, 50));
  return DOM.labelContent;
}

async function cleanupCapture() {
  DOM.previewContainer.classList.remove("printing");
}

/* =========================================================
 * PDF
 * ========================================================= */

/**
 * Captures the label and returns a jsPDF whose page is exactly the label (rotated when
 * the "Ruota etichetta 90°" switch is on). Shared by PDF, Stampa WiFi and, in the
 * Android app, Stampa.
 */
async function buildLabelPdf() {
  const element = await prepareCapture();

  try {
    const canvas = await html2canvas(element, {
      scale: 4,
      useCORS: true,
      backgroundColor: "#ffffff",
    });
    const { jsPDF } = window.jspdf;
    const widthMm = parseFloat(DOM.inputs.labelWidth.value);
    const heightMm = parseFloat(DOM.inputs.labelHeight.value);
    const rotate = localStorage.getItem("labelRotate90") === "1"; // interruttore manuale "Ruota etichetta 90°"

    let imgData, pageW, pageH;
    if (rotate) {
      const rot = document.createElement("canvas");
      rot.width = canvas.height;
      rot.height = canvas.width;
      const rctx = rot.getContext("2d");
      rctx.translate(rot.width / 2, rot.height / 2);
      rctx.rotate((90 * Math.PI) / 180);
      rctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
      imgData = rot.toDataURL("image/png");
      pageW = heightMm;
      pageH = widthMm;
    } else {
      imgData = canvas.toDataURL("image/png");
      pageW = widthMm;
      pageH = heightMm;
    }

    // Pagina = esattamente le dimensioni dell'etichetta (ruotata o no), nessun margine,
    // orientamento sempre "p": passando un array "format" a jsPDF con
    // orientation "l" (o "p" con altezza<larghezza) jsPDF può scambiare
    // internamente width/height, disallineando la pagina dall'immagine e
    // facendo apparire l'etichetta piccola su una pagina bianca enorme.
    const doc = new jsPDF({
      orientation: "p",
      unit: "mm",
      format: [pageW, pageH],
    });

    // "FAST" = lossless Flate: without it jsPDF embeds the raw pixels (about 9 MB for a
    // 50x50 mm label instead of about 100 KB)
    doc.addImage(imgData, "PNG", 0, 0, pageW, pageH, undefined, "FAST");
    return doc;
  } finally {
    cleanupCapture();
  }
}

async function generatePdf() {
  try {
    const doc = await buildLabelPdf();
    const fileName = `TankLabel_Label_${Date.now()}.pdf`;
    if (window.NativeApp) {
      // Android app: no downloads in the WebView, hand the PDF to the share sheet
      await NativeApp.shareFile(doc.output("blob"), fileName, "Etichetta TankLabel");
    } else {
      doc.save(fileName);
    }
  } catch (e) {
    console.error("Errore PDF:", e);
    alert("Errore nella generazione del PDF.");
  }
}

/* =========================================================
 * IMMAGINE PNG
 * ========================================================= */

/**
 * Esporta l'etichetta come PNG ad alta risoluzione.
 * - Desktop: download diretto tramite <a download>
 * - iOS/Mobile: usa navigator.share() per aprire il pannello
 *   di condivisione nativo (Salva su Foto, AirDrop, ecc.)
 * - Android app: Android share sheet (native-app.js)
 */
async function generateImage() {
  const element = await prepareCapture();
  try {
    const canvas = await html2canvas(element, {
      scale: 4,
      backgroundColor: null,
    });

    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    const fileName = `TankLabel_Label_${Date.now()}.png`;

    if (isIOS) {
      // iOS Safari non supporta <a download> — usa il pannello di condivisione nativo
      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, "image/png")
      );
      const file = new File([blob], fileName, { type: "image/png" });

      if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        // iOS 15+: condivisione file nativa → "Salva su Foto" / AirDrop / ecc.
        await navigator.share({
          files: [file],
          title: "Etichetta TankLabel",
          text: "Etichetta bombola subacquea",
        });
      } else {
        // Fallback iOS: apri immagine in nuova tab → tieni premuto per salvare
        const url = canvas.toDataURL("image/png");
        const w = window.open();
        if (w) {
          w.document.write(`<img src="${url}" style="max-width:100%;touch-action:pinch-zoom">`);
          w.document.title = fileName;
        } else {
          alert("Tieni premuto sull'immagine per salvarla.");
        }
      }
    } else if (window.NativeApp) {
      // Android app: no downloads in the WebView, hand the image to the share sheet
      await NativeApp.shareFile(canvas.toDataURL("image/png"), fileName, "Etichetta TankLabel");
    } else {
      // Desktop / Android: download classico
      const link = document.createElement("a");
      link.download = fileName;
      link.href = canvas.toDataURL("image/png");
      link.click();
    }
  } catch (e) {
    if (e.name !== "AbortError") {
      console.error("Errore immagine:", e);
      alert("Errore nella generazione dell'immagine.");
    }
  } finally {
    cleanupCapture();
  }
}

/* =========================================================
 * STAMPA NATIVA
 * ========================================================= */

async function printLabel() {
  if (window.NativeApp) {
    // Android app: window.print() does nothing in the WebView, print the label PDF
    // through the Android print dialog instead
    try {
      const doc = await buildLabelPdf();
      await NativeApp.printPdf(doc.output("blob"), "Etichetta TankLabel");
    } catch (e) {
      console.error("Errore stampa:", e);
      alert("Errore nella stampa dell'etichetta.");
    }
    return;
  }

  const widthMm = parseFloat(DOM.inputs.labelWidth.value) || 50;
  const heightMm = parseFloat(DOM.inputs.labelHeight.value) || 50;
  const basePx = parseFloat(DOM.inputs.basePxSize.value) || 16;
  const rotate = localStorage.getItem("labelRotate90") === "1"; // scelta manuale dell'utente (interruttore "Ruota etichetta 90°"), indipendente dalla skin

  const printArea = document.getElementById("print-area");
  const clone = DOM.labelContent.cloneNode(true);

  clone.style.width = `${widthMm}mm`;
  clone.style.height = `${heightMm}mm`;
  clone.style.fontSize = `${basePx}px`;
  clone.style.setProperty("--base-px-size", `${basePx}px`);
  if (rotate) {
    clone.style.transformOrigin = "top left";
    clone.style.transform = "rotate(90deg) translateY(-100%)";
  }

  printArea.innerHTML = "";
  printArea.appendChild(clone);

  const pageStyle = document.createElement("style");
  pageStyle.id = "_kiko_page_size";
  pageStyle.textContent = rotate
    ? `@page { size: ${heightMm}mm ${widthMm}mm; margin: 0; }`
    : `@page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }`;
  document.head.appendChild(pageStyle);

  await new Promise((r) => setTimeout(r, 80));
  window.print();

  setTimeout(() => {
    printArea.innerHTML = "";
    document.getElementById("_kiko_page_size")?.remove();
  }, 1000);
}

/* =========================================================
 * STAMPA WIFI (AirPrint diretto su PC, foglio di condivisione su mobile/PWA)
 * ========================================================= */

async function printLabelWiFi() {
  // Verifica se il dispositivo supporta la condivisione di file.
  // Se non la supporta (tipicamente desktop), usa esattamente printLabel()
  // già esistente e già corretto — nessuna modifica al comportamento su PC.
  const probeFile = new File(["x"], "probe.pdf", { type: "application/pdf" });
  const canShareFiles = !!(navigator.canShare && navigator.canShare({ files: [probeFile] }));
  if (!canShareFiles) {
    return printLabel();
  }

  // Mobile / PWA installata: window.print() da una finestra aperta via
  // script non è affidabile (limite noto di iOS sulle app installate in
  // Home) — passiamo dal foglio di condivisione di sistema, che apre
  // sempre "Stampa" via AirPrint. Il PDF è generato alla dimensione
  // esatta dell'etichetta, senza margini aggiuntivi.
  const btn = document.getElementById("btnPrintWiFi");
  const originalHTML = btn ? btn.innerHTML : "";
  if (btn) { btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generando...'; btn.disabled = true; }

  try {
    const doc = await buildLabelPdf();
    const blob = doc.output("blob");
    const file = new File([blob], `TankLabel_${Date.now()}.pdf`, { type: "application/pdf" });
    await navigator.share({ files: [file], title: "Etichetta TankLabel" });
  } catch (e) {
    if (e.name !== "AbortError") {
      console.error("Errore Stampa WiFi:", e);
      alert("Errore nella generazione della stampa.");
    }
  } finally {
    if (btn) { btn.innerHTML = originalHTML; btn.disabled = false; }
  }
}


async function shareViaBluetooth() {
  if (!navigator.share) {
    alert(
      "⚠️ Condivisione non supportata su questo browser.\n\nSuggerimento: usa il pulsante 'Immagine' per salvare il file, poi condividilo manualmente.",
    );
    return;
  }

  const element = await prepareCapture();

  try {
    const canvas = await html2canvas(element, {
      scale: 4,
      backgroundColor: "#ffffff",
    });
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    const fileName = `TankLabel_Label_${Date.now()}.png`;
    const file = new File([blob], fileName, { type: "image/png" });

    if (navigator.canShare && !navigator.canShare({ files: [file] })) {
      alert(
        "⚠️ Questo dispositivo non supporta la condivisione file.\n\nUsa il pulsante 'Immagine' per salvare e poi condividi manualmente.",
      );
      cleanupCapture();
      return;
    }

    await navigator.share({
      files: [file],
      title: "Etichetta TankLabel",
      text: "Etichetta bombola subacquea generata con TankLabel",
    });

    console.log("Etichetta condivisa con successo.");
  } catch (error) {
    if (error.name !== "AbortError") {
      console.error("Errore condivisione:", error);
      alert(
        "Errore durante la condivisione. Prova con il pulsante 'Immagine'.",
      );
    }
  } finally {
    cleanupCapture();
  }
}
