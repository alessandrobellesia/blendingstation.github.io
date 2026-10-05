package io.github.blendingstation.app;

import android.content.Context;
import android.net.Uri;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.print.PageRange;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintDocumentInfo;
import android.print.PrintManager;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Opens the Android print dialog for a PDF file, for the pages' "Stampa" buttons:
 * window.print() does nothing in the WebView. The print services on the phone
 * (Wi-Fi printers, "Save as PDF") take it from there. Called by native-app.js.
 */
@CapacitorPlugin(name = "PdfPrinter")
public class PdfPrinterPlugin extends Plugin {

    @PluginMethod
    public void print(PluginCall call) {
        String uri = call.getString("uri");
        String path = uri == null ? null : Uri.parse(uri).getPath();
        if (path == null || !new File(path).isFile()) {
            call.reject("PDF file not found: " + uri);
            return;
        }
        File file = new File(path);
        String jobName = call.getString("name", file.getName());

        // PrintManager needs the activity context and the main thread
        getActivity().runOnUiThread(() -> {
            PrintManager printManager = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
            printManager.print(jobName, new PdfFileAdapter(file), null);
            call.resolve();
        });
    }

    /** Hands an existing PDF to the print framework as is: its pages are already laid out. */
    private static class PdfFileAdapter extends PrintDocumentAdapter {

        private final File file;

        PdfFileAdapter(File file) {
            this.file = file;
        }

        @Override
        public void onLayout(
            PrintAttributes oldAttributes,
            PrintAttributes newAttributes,
            CancellationSignal cancellationSignal,
            LayoutResultCallback callback,
            Bundle extras
        ) {
            if (cancellationSignal.isCanceled()) {
                callback.onLayoutCancelled();
                return;
            }
            PrintDocumentInfo info = new PrintDocumentInfo.Builder(file.getName())
                .setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT)
                .build();
            callback.onLayoutFinished(info, !newAttributes.equals(oldAttributes));
        }

        @Override
        public void onWrite(
            PageRange[] pages,
            ParcelFileDescriptor destination,
            CancellationSignal cancellationSignal,
            WriteResultCallback callback
        ) {
            try (
                InputStream in = new FileInputStream(file);
                OutputStream out = new FileOutputStream(destination.getFileDescriptor())
            ) {
                byte[] buffer = new byte[16 * 1024];
                int read;
                while ((read = in.read(buffer)) != -1) {
                    if (cancellationSignal.isCanceled()) {
                        callback.onWriteCancelled();
                        return;
                    }
                    out.write(buffer, 0, read);
                }
                callback.onWriteFinished(new PageRange[] { PageRange.ALL_PAGES });
            } catch (IOException e) {
                callback.onWriteFailed(e.getMessage());
            }
        }
    }
}
