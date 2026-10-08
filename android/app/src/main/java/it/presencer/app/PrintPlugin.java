package it.presencer.app;

import android.content.Context;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.webkit.WebView;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Nella WebView window.print() non fa nulla: qui apriamo la stampa di sistema
 * sulla pagina corrente (con il suo CSS @media print). Il dialogo Android
 * offre sia le stampanti sia "Salva come PDF".
 */
@CapacitorPlugin(name = "PresencerPrint")
public class PrintPlugin extends Plugin {

    @PluginMethod
    public void print(PluginCall call) {
        String name = call.getString("name", "Presencer");
        getActivity().runOnUiThread(() -> {
            try {
                WebView webView = getBridge().getWebView();
                PrintManager printManager = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
                PrintAttributes attributes = new PrintAttributes.Builder()
                    .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                    .build();
                printManager.print(name, webView.createPrintDocumentAdapter(name), attributes);
                call.resolve();
            } catch (Exception e) {
                call.reject("Stampa non disponibile", e);
            }
        });
    }
}
