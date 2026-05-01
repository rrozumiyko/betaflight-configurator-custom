/**
 * Polyfill of the small subset of the WebUSB API used by src/js/protocols/webusbdfu.js
 * Backed by the native BetaflightDfu Capacitor plugin (Android only).
 *
 * Activated automatically when running inside Capacitor on a platform that doesn't
 * provide a working navigator.usb (Android System WebView).
 */
import { Capacitor, registerPlugin } from "@capacitor/core";

const NativeDfu = registerPlugin("BetaflightDfu");

function b64ToBytes(b64) {
    if (!b64) return new Uint8Array(0);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function bytesToB64(buf) {
    const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer || buf);
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
}

class CapUSBDevice {
    constructor(info) {
        this._key = info.key;
        this.vendorId = info.vendorId;
        this.productId = info.productId;
        this.productName = info.productName || "";
        this.serialNumber = info.serialNumber || "";
        this.manufacturerName = "";
        this.deviceClass = 0;
        this.opened = false;
        this.configuration = null;
    }
    async open() {
        const res = await NativeDfu.open({ key: this._key });
        this.configuration = res.configuration || { interfaces: [] };
        this.opened = true;
    }
    async close() {
        await NativeDfu.close({ key: this._key });
        this.opened = false;
    }
    async selectConfiguration(_n) {
        // Android picks default configuration automatically
    }
    async claimInterface(n) {
        await NativeDfu.claimInterface({ key: this._key, interfaceNumber: n });
    }
    async releaseInterface(n) {
        await NativeDfu.releaseInterface({ key: this._key, interfaceNumber: n });
    }
    async selectAlternateInterface(n, alt) {
        await NativeDfu.selectAlternate({ key: this._key, interfaceNumber: n, alternateSetting: alt });
    }
    async reset() {
        await NativeDfu.reset({ key: this._key });
    }
    async controlTransferIn(setup, length) {
        const res = await NativeDfu.controlTransferIn({
            key: this._key,
            requestType: setup.requestType,
            recipient: setup.recipient,
            request: setup.request,
            value: setup.value,
            index: setup.index,
            length,
        });
        const bytes = b64ToBytes(res.data);
        // Build a DataView whose buffer is the ArrayBuffer of the bytes
        return {
            status: res.status,
            data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        };
    }
    async controlTransferOut(setup, data) {
        let bytes;
        if (!data) bytes = new Uint8Array(0);
        else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
        else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        else if (Array.isArray(data)) bytes = new Uint8Array(data);
        else bytes = new Uint8Array(data);
        const res = await NativeDfu.controlTransferOut({
            key: this._key,
            requestType: setup.requestType,
            recipient: setup.recipient,
            request: setup.request,
            value: setup.value,
            index: setup.index,
            data: bytesToB64(bytes),
        });
        return { status: res.status, bytesWritten: res.bytesWritten };
    }
}

class CapacitorUsb extends EventTarget {
    constructor() {
        super();
        this._cache = new Map(); // key -> CapUSBDevice
        NativeDfu.addListener("deviceAttached", (info) => {
            const dev = this._wrap(info);
            this.dispatchEvent(new CustomEvent("connect", { detail: { device: dev } }));
            // Mirror DOM event interface
            const ev = new Event("connect");
            ev.device = dev;
            this.dispatchEvent(ev);
        });
        NativeDfu.addListener("deviceDetached", (info) => {
            const dev = this._wrap(info);
            this._cache.delete(info.key);
            const ev = new Event("disconnect");
            ev.device = dev;
            this.dispatchEvent(ev);
        });
    }
    _wrap(info) {
        let d = this._cache.get(info.key);
        if (!d) {
            d = new CapUSBDevice(info);
            this._cache.set(info.key, d);
        }
        return d;
    }
    async getDevices(_filters) {
        const res = await NativeDfu.getDevices();
        return (res.devices || []).filter((info) => info.hasPermission).map((info) => this._wrap(info));
    }
    async requestDevice(_filters) {
        const res = await NativeDfu.getDevices();
        const list = res.devices || [];
        if (list.length === 0) {
            const err = new Error("NotFoundError: no DFU device connected");
            err.name = "NotFoundError";
            throw err;
        }
        // Pick first matching DFU device and request permission via the system dialog.
        const target = list[0];
        const grant = await NativeDfu.requestPermission({ key: target.key });
        if (!grant.granted) {
            const err = new Error("NotAllowedError: USB permission denied");
            err.name = "NotAllowedError";
            throw err;
        }
        return this._wrap(target);
    }
}

export function installCapacitorUsbPolyfill() {
    if (!Capacitor.isNativePlatform || !Capacitor.isNativePlatform()) return false;
    if (Capacitor.getPlatform() !== "android") return false;
    try {
        Object.defineProperty(navigator, "usb", {
            value: new CapacitorUsb(),
            configurable: true,
            writable: true,
        });
         
        console.log("[DFU] Capacitor WebUSB polyfill installed");
        return true;
    } catch (e) {
         
        console.warn("[DFU] failed to install polyfill", e);
        return false;
    }
}
