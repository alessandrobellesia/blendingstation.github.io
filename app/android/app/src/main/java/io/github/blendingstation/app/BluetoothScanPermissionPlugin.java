package io.github.blendingstation.app;

import android.Manifest;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * @devlas/capacitor-thermal-printer calls BluetoothAdapter.cancelDiscovery() before every Bluetooth
 * print, which on Android 12+ throws a SecurityException without BLUETOOTH_SCAN, while the plugin
 * only requests BLUETOOTH_CONNECT. Both belong to the "Nearby devices" group, so once
 * BLUETOOTH_CONNECT is granted this request is granted without showing a second dialog.
 */
@CapacitorPlugin(
    name = "BluetoothScanPermission",
    permissions = { @Permission(alias = "scan", strings = { Manifest.permission.BLUETOOTH_SCAN }) }
)
public class BluetoothScanPermissionPlugin extends Plugin {

    @PluginMethod
    public void request(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || getPermissionState("scan") == PermissionState.GRANTED) {
            resolveGranted(call);
            return;
        }
        requestPermissionForAlias("scan", call, "scanPermissionCallback");
    }

    @PermissionCallback
    private void scanPermissionCallback(PluginCall call) {
        resolveGranted(call);
    }

    private void resolveGranted(PluginCall call) {
        boolean granted = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || getPermissionState("scan") == PermissionState.GRANTED;
        JSObject result = new JSObject();
        result.put("granted", granted);
        call.resolve(result);
    }
}
