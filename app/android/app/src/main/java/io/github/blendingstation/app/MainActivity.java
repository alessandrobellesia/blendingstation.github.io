package io.github.blendingstation.app;

import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(PdfPrinterPlugin.class);
        super.onCreate(savedInstanceState);

        // The app is two pages: the system back gesture walks the WebView history from TankLabel,
        // while Blending Station is the home page and leaves the app even when TankLabel's
        // "Blending Station" link put TankLabel in the history behind it.
        getOnBackPressedDispatcher().addCallback(
            this,
            new OnBackPressedCallback(true) {
                @Override
                public void handleOnBackPressed() {
                    WebView webView = getBridge().getWebView();
                    if (webView.canGoBack() && !isHomePage(webView.getUrl())) {
                        webView.goBack();
                        return;
                    }
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                    setEnabled(true);
                }
            }
        );
    }

    private static boolean isHomePage(String url) {
        String path = url == null ? null : Uri.parse(url).getPath();
        return path == null || path.isEmpty() || path.equals("/") || path.equals("/index.html");
    }
}
