/**
 * native-app.js
 * Android app (Capacitor) support shared by Blending Station and TankLabel.
 *
 * The Android WebView has no downloads, no window.print() and no Web Share API, so inside
 * the app this file exposes window.NativeApp:
 *  - shareFile(data, fileName, title): writes the file to the app cache and opens the
 *    Android share sheet (save to Files or Drive, send by mail or chat, ...)
 *  - printPdf(data, jobName): opens the Android print dialog for a PDF (PdfPrinterPlugin)
 * where data is a Blob or a data: URL. It also provides navigator.share and
 * navigator.canShare on top of the share sheet, so the pages' existing "share the PDF"
 * paths work unchanged.
 *
 * In the browser it does nothing and window.NativeApp stays undefined: pages check
 * window.NativeApp before using it.
 */
(function () {
  "use strict";

  const cap = window.Capacitor;
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return;
  const { Filesystem, Share, PdfPrinter } = cap.Plugins;

  async function toBase64(data) {
    const blob = typeof data === "string" ? await (await fetch(data)).blob() : data;
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    return dataUrl.slice(dataUrl.indexOf(",") + 1);
  }

  /** Writes the file under the app cache and returns its file:// URI. */
  async function writeCacheFile(data, fileName) {
    const { uri } = await Filesystem.writeFile({
      path: "exports/" + fileName.replace(/[\\/:*?"<>|]/g, "_"),
      data: await toBase64(data), // the native bridge takes base64, not Blobs
      directory: "CACHE",
      recursive: true,
    });
    return uri;
  }

  // The Share plugin rejects with "Share canceled" when the sheet is dismissed
  const isShareCancel = (err) => /cancel/i.test((err && err.message) || "");

  async function shareFile(data, fileName, title) {
    const uri = await writeCacheFile(data, fileName);
    try {
      await Share.share({ title: title || fileName, files: [uri] });
    } catch (err) {
      if (!isShareCancel(err)) throw err;
    }
  }

  async function printPdf(data, jobName) {
    const uri = await writeCacheFile(data, jobName.replace(/\.pdf$/i, "") + ".pdf");
    await PdfPrinter.print({ uri, name: jobName });
  }

  // Web Share API: the plugin needs files, text or a URL (a title alone is rejected)
  navigator.canShare = (data) =>
    !!data && !!((data.files && data.files.length) || data.text || data.url);

  navigator.share = async (data = {}) => {
    const files = await Promise.all(
      Array.from(data.files || []).map((file) => writeCacheFile(file, file.name || "condivisione"))
    );
    try {
      await Share.share({
        title: data.title,
        text: data.text,
        url: data.url,
        files: files.length ? files : undefined,
      });
    } catch (err) {
      throw isShareCancel(err) ? new DOMException("Share canceled", "AbortError") : err;
    }
  };

  window.NativeApp = { shareFile, printPdf };
})();
