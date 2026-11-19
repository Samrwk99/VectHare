/**
 * U3: VectHare's informational console output. Off by default; turn it on with
 * "Debug logging" in VectHare's settings (settings.debug_logging). Warnings and
 * errors still use console.warn / console.error and are always shown.
 */
import { extension_settings } from '../../../../extensions.js';

export function isDebugLogging() {
    try {
        return extension_settings?.vecthare?.debug_logging === true;
    } catch {
        return false;
    }
}

export function vhLog(...args) {
    if (isDebugLogging()) console.log(...args);
}
