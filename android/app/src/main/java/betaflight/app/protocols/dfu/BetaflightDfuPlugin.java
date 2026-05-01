package betaflight.app.protocols.dfu;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbConfiguration;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.os.Build;
import android.util.Base64;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * Capacitor plugin that exposes minimum WebUSB-like API needed for DFU flashing.
 * Used by src/js/capacitor/dfu-polyfill.js to polyfill navigator.usb on Android.
 */
@CapacitorPlugin(name = "BetaflightDfu")
public class BetaflightDfuPlugin extends Plugin {
    private static final String TAG = "BetaflightDfu";
    private static final String ACTION_USB_PERMISSION = "com.betaflight.DFU_USB_PERMISSION";
    private static final int CTRL_TIMEOUT_MS = 5000;

    // Known DFU vendor/product pairs (mirrors src/js/protocols/devices.js usbDevices.filters)
    private static final int[][] DFU_FILTERS = {
        { 1155, 57105 },   // STM32 DFU
        { 10473, 393 },    // GD32 DFU
        { 11836, 57105 },  // AT32F435 DFU
        { 12619, 262 },    // APM32 DFU
        { 11914, 15 }      // RP2040 boot
    };

    private UsbManager usbManager;
    private final Map<String, UsbDevice> devices = new HashMap<>();
    private final Map<String, UsbDeviceConnection> connections = new HashMap<>();
    private final Map<String, Set<Integer>> claimedIfaces = new HashMap<>();
    private PluginCall pendingPermissionCall;
    private String pendingPermissionKey;

    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context ctx, Intent intent) {
            String action = intent.getAction();
            if (ACTION_USB_PERMISSION.equals(action)) {
                handlePermissionResult(intent);
            } else if (UsbManager.ACTION_USB_DEVICE_ATTACHED.equals(action)) {
                UsbDevice d = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
                if (d != null && isDfu(d)) emitEvent("deviceAttached", deviceInfo(d));
            } else if (UsbManager.ACTION_USB_DEVICE_DETACHED.equals(action)) {
                UsbDevice d = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
                if (d != null && isDfu(d)) {
                    String key = key(d);
                    closeConnection(key);
                    devices.remove(key);
                    emitEvent("deviceDetached", deviceInfo(d));
                }
            }
        }
    };

    @Override
    public void load() {
        super.load();
        usbManager = (UsbManager) getContext().getSystemService(Context.USB_SERVICE);
        IntentFilter f = new IntentFilter();
        f.addAction(ACTION_USB_PERMISSION);
        f.addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED);
        f.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getContext().registerReceiver(receiver, f, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(receiver, f);
        }
    }

    @Override
    protected void handleOnDestroy() {
        for (String k : new HashSet<>(connections.keySet())) closeConnection(k);
        try { getContext().unregisterReceiver(receiver); } catch (Exception ignored) {}
        super.handleOnDestroy();
    }

    private boolean isDfu(UsbDevice d) {
        for (int[] f : DFU_FILTERS) {
            if (d.getVendorId() == f[0] && d.getProductId() == f[1]) return true;
        }
        return false;
    }

    private String key(UsbDevice d) { return d.getDeviceName(); }

    private JSObject deviceInfo(UsbDevice d) {
        JSObject o = new JSObject();
        o.put("key", key(d));
        o.put("vendorId", d.getVendorId());
        o.put("productId", d.getProductId());
        o.put("productName", d.getProductName());
        String serial;
        try {
            serial = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP_MR1) ? d.getSerialNumber() : null;
        } catch (SecurityException e) { serial = null; }
        o.put("serialNumber", serial == null ? "" : serial);
        o.put("hasPermission", usbManager.hasPermission(d));
        return o;
    }

    private void emitEvent(String name, JSObject data) {
        notifyListeners(name, data);
    }

    @PluginMethod
    public void getDevices(PluginCall call) {
        JSArray arr = new JSArray();
        for (UsbDevice d : usbManager.getDeviceList().values()) {
            if (isDfu(d)) {
                devices.put(key(d), d);
                arr.put(deviceInfo(d));
            }
        }
        JSObject res = new JSObject();
        res.put("devices", arr);
        call.resolve(res);
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        String key = call.getString("key");
        if (key == null) { call.reject("missing key"); return; }
        UsbDevice d = devices.get(key);
        if (d == null) {
            for (UsbDevice dev : usbManager.getDeviceList().values()) {
                if (key(dev).equals(key)) { d = dev; devices.put(key, d); break; }
            }
        }
        if (d == null) { call.reject("device not found"); return; }
        if (usbManager.hasPermission(d)) {
            JSObject res = new JSObject();
            res.put("granted", true);
            call.resolve(res);
            return;
        }
        if (pendingPermissionCall != null) { call.reject("permission request already in progress"); return; }
        pendingPermissionCall = call;
        pendingPermissionKey = key;
        Intent it = new Intent(ACTION_USB_PERMISSION);
        it.setPackage(getContext().getPackageName());
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags |= PendingIntent.FLAG_MUTABLE;
        PendingIntent pi = PendingIntent.getBroadcast(getContext(), 0, it, flags);
        usbManager.requestPermission(d, pi);
    }

    private void handlePermissionResult(Intent intent) {
        if (pendingPermissionCall == null) return;
        boolean granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false);
        JSObject res = new JSObject();
        res.put("granted", granted);
        res.put("key", pendingPermissionKey);
        pendingPermissionCall.resolve(res);
        pendingPermissionCall = null;
        pendingPermissionKey = null;
    }

    @PluginMethod
    public void open(PluginCall call) {
        String key = call.getString("key");
        UsbDevice d = devices.get(key);
        if (d == null) { call.reject("device not found"); return; }
        if (!usbManager.hasPermission(d)) { call.reject("no permission"); return; }
        UsbDeviceConnection conn = usbManager.openDevice(d);
        if (conn == null) { call.reject("openDevice failed"); return; }
        connections.put(key, conn);
        claimedIfaces.put(key, new HashSet<>());

        // Build a JS-friendly configuration tree summary
        JSObject configuration = new JSObject();
        JSArray interfaces = new JSArray();
        try {
            UsbConfiguration cfg = (d.getConfigurationCount() > 0) ? d.getConfiguration(0) : null;
            // Group alternates by bInterfaceNumber
            Map<Integer, Integer> altCount = new HashMap<>();
            if (cfg != null) {
                for (int i = 0; i < cfg.getInterfaceCount(); i++) {
                    UsbInterface ui = cfg.getInterface(i);
                    int n = ui.getId();
                    altCount.merge(n, 1, Integer::sum);
                }
                for (Map.Entry<Integer, Integer> e : altCount.entrySet()) {
                    JSObject iface = new JSObject();
                    iface.put("interfaceNumber", e.getKey());
                    JSArray alts = new JSArray();
                    for (int a = 0; a < e.getValue(); a++) alts.put(new JSObject());
                    iface.put("alternates", alts);
                    interfaces.put(iface);
                }
            }
        } catch (Exception ex) {
            Log.w(TAG, "config parse error", ex);
        }
        configuration.put("interfaces", interfaces);
        JSObject res = new JSObject();
        res.put("configuration", configuration);
        call.resolve(res);
    }

    @PluginMethod
    public void close(PluginCall call) {
        String key = call.getString("key");
        closeConnection(key);
        call.resolve();
    }

    private void closeConnection(String key) {
        UsbDeviceConnection conn = connections.remove(key);
        Set<Integer> ifs = claimedIfaces.remove(key);
        UsbDevice d = devices.get(key);
        if (conn != null && d != null && ifs != null) {
            UsbConfiguration cfg = (d.getConfigurationCount() > 0) ? d.getConfiguration(0) : null;
            if (cfg != null) {
                for (int i = 0; i < cfg.getInterfaceCount(); i++) {
                    UsbInterface ui = cfg.getInterface(i);
                    if (ifs.contains(ui.getId())) {
                        try { conn.releaseInterface(ui); } catch (Exception ignored) {}
                    }
                }
            }
        }
        if (conn != null) {
            try { conn.close(); } catch (Exception ignored) {}
        }
    }

    @PluginMethod
    public void claimInterface(PluginCall call) {
        String key = call.getString("key");
        Integer num = call.getInt("interfaceNumber");
        UsbDevice d = devices.get(key);
        UsbDeviceConnection conn = connections.get(key);
        if (d == null || conn == null || num == null) { call.reject("invalid args"); return; }
        UsbInterface iface = findInterface(d, num, 0);
        if (iface == null) { call.reject("interface not found"); return; }
        boolean ok = conn.claimInterface(iface, true);
        if (!ok) { call.reject("claimInterface failed"); return; }
        claimedIfaces.get(key).add(num);
        call.resolve();
    }

    @PluginMethod
    public void releaseInterface(PluginCall call) {
        String key = call.getString("key");
        Integer num = call.getInt("interfaceNumber");
        UsbDevice d = devices.get(key);
        UsbDeviceConnection conn = connections.get(key);
        if (d == null || conn == null || num == null) { call.reject("invalid args"); return; }
        UsbInterface iface = findInterface(d, num, 0);
        if (iface != null) {
            try { conn.releaseInterface(iface); } catch (Exception ignored) {}
            claimedIfaces.get(key).remove(num);
        }
        call.resolve();
    }

    @PluginMethod
    public void selectAlternate(PluginCall call) {
        String key = call.getString("key");
        Integer num = call.getInt("interfaceNumber");
        Integer alt = call.getInt("alternateSetting");
        UsbDevice d = devices.get(key);
        UsbDeviceConnection conn = connections.get(key);
        if (d == null || conn == null || num == null || alt == null) { call.reject("invalid args"); return; }
        UsbInterface iface = findInterface(d, num, alt);
        if (iface == null) { call.reject("alt not found"); return; }
        boolean ok = conn.setInterface(iface);
        if (!ok) { call.reject("setInterface failed"); return; }
        call.resolve();
    }

    private UsbInterface findInterface(UsbDevice d, int number, int alt) {
        UsbConfiguration cfg = (d.getConfigurationCount() > 0) ? d.getConfiguration(0) : null;
        if (cfg == null) return null;
        for (int i = 0; i < cfg.getInterfaceCount(); i++) {
            UsbInterface ui = cfg.getInterface(i);
            if (ui.getId() == number && ui.getAlternateSetting() == alt) return ui;
        }
        // fallback — first matching number
        for (int i = 0; i < cfg.getInterfaceCount(); i++) {
            UsbInterface ui = cfg.getInterface(i);
            if (ui.getId() == number) return ui;
        }
        return null;
    }

    private int buildRequestType(String type, String recipient, boolean in) {
        int rt = 0;
        if ("class".equalsIgnoreCase(type)) rt |= UsbConstants.USB_TYPE_CLASS;
        else if ("vendor".equalsIgnoreCase(type)) rt |= UsbConstants.USB_TYPE_VENDOR;
        else rt |= UsbConstants.USB_TYPE_STANDARD;
        if ("interface".equalsIgnoreCase(recipient)) rt |= 0x01;
        else if ("endpoint".equalsIgnoreCase(recipient)) rt |= 0x02;
        if (in) rt |= UsbConstants.USB_DIR_IN;
        return rt;
    }

    @PluginMethod
    public void controlTransferIn(PluginCall call) {
        String key = call.getString("key");
        UsbDeviceConnection conn = connections.get(key);
        if (conn == null) { call.reject("not open"); return; }
        try {
            String type = call.getString("requestType", "standard");
            String recipient = call.getString("recipient", "device");
            int request = call.getInt("request", 0);
            int value = call.getInt("value", 0);
            int index = call.getInt("index", 0);
            int length = call.getInt("length", 0);
            byte[] buf = new byte[length];
            int rt = buildRequestType(type, recipient, true);
            int n = conn.controlTransfer(rt, request, value, index, buf, length, CTRL_TIMEOUT_MS);
            JSObject res = new JSObject();
            if (n < 0) {
                res.put("status", "stall");
                res.put("data", "");
                res.put("bytesRead", 0);
            } else {
                byte[] sliced = new byte[n];
                System.arraycopy(buf, 0, sliced, 0, n);
                res.put("status", "ok");
                res.put("data", Base64.encodeToString(sliced, Base64.NO_WRAP));
                res.put("bytesRead", n);
            }
            call.resolve(res);
        } catch (Exception e) {
            call.reject("controlTransferIn: " + e.getMessage());
        }
    }

    @PluginMethod
    public void controlTransferOut(PluginCall call) {
        String key = call.getString("key");
        UsbDeviceConnection conn = connections.get(key);
        if (conn == null) { call.reject("not open"); return; }
        try {
            String type = call.getString("requestType", "standard");
            String recipient = call.getString("recipient", "device");
            int request = call.getInt("request", 0);
            int value = call.getInt("value", 0);
            int index = call.getInt("index", 0);
            String b64 = call.getString("data", "");
            byte[] data = (b64 == null || b64.isEmpty()) ? new byte[0] : Base64.decode(b64, Base64.NO_WRAP);
            int rt = buildRequestType(type, recipient, false);
            int n = conn.controlTransfer(rt, request, value, index, data, data.length, CTRL_TIMEOUT_MS);
            JSObject res = new JSObject();
            if (n < 0) {
                res.put("status", "stall");
                res.put("bytesWritten", 0);
            } else {
                res.put("status", "ok");
                res.put("bytesWritten", n);
            }
            call.resolve(res);
        } catch (Exception e) {
            call.reject("controlTransferOut: " + e.getMessage());
        }
    }

    @PluginMethod
    public void reset(PluginCall call) {
        String key = call.getString("key");
        UsbDeviceConnection conn = connections.get(key);
        if (conn == null) { call.reject("not open"); return; }
        // Android UsbDeviceConnection has no reset() — closing/reopening is the closest equivalent.
        call.resolve();
    }
}
