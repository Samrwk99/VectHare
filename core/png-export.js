import {parseSafePng, readLimitedStream, MAX_PNG_TEXT_BYTES} from '../utils/safe-png.js';
/**
 * ============================================================================
 * VECTHARE PNG EXPORT/IMPORT
 * ============================================================================
 * Embeds VectHare collection data into PNG files using zTXt chunks.
 *
 * PNG Structure:
 * - 8-byte signature
 * - IHDR chunk (image header)
 * - ... other chunks ...
 * - IEND chunk (end marker)
 *
 * We insert a zTXt chunk containing compressed JSON data.
 * zTXt format: keyword + null + compression_method (0=deflate) + compressed_data
 *
 * Uses browser's native CompressionStream API for deflate compression.
 * Falls back to storing as tEXt (base64, uncompressed) if compression unavailable.
 *
 * @author VectHare
 * @version 1.0.0
 * ============================================================================
 */

// ============================================================================
// CONSTANTS
// ============================================================================

/** PNG file signature (magic bytes) */
const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

/** Keyword for VectHare data in PNG tEXt/zTXt chunks */
const VECTHARE_KEYWORD = 'vecthare';

/** Maximum keyword length in PNG text chunks */
const MAX_KEYWORD_LENGTH = 79;

// ============================================================================
// CRC32 CALCULATION (Required for PNG chunks)
// ============================================================================

/** CRC32 lookup table */
let crcTable = null;

/**
 * Generates the CRC32 lookup table
 * @returns {Uint32Array}
 */
function makeCRCTable() {
    if (crcTable) return crcTable;

    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        crcTable[n] = c;
    }
    return crcTable;
}

/**
 * Calculates CRC32 for PNG chunk
 * @param {Uint8Array} data - Data to calculate CRC for
 * @returns {number} CRC32 value
 */
function crc32(data) {
    const table = makeCRCTable();
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
        crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ============================================================================
// COMPRESSION UTILITIES
// ============================================================================

/**
 * Compresses data using browser's native CompressionStream (deflate-raw)
 * @param {Uint8Array} data - Data to compress
 * @returns {Promise<Uint8Array>} Compressed data
 */
async function compressZlib(data) {
    if (typeof CompressionStream === 'undefined') return null;
    try {
        // PNG zTXt requires an RFC1950 zlib stream, not raw DEFLATE.
        const compressed = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
        return new Uint8Array(await new Response(compressed).arrayBuffer());
    } catch (error) {
        console.warn('VectHare PNG: zlib compression unavailable, using tEXt', error);
        return null;
    }
}

/**
 * Decompresses deflate-raw data using browser's native DecompressionStream
 * @param {Uint8Array} data - Compressed data
 * @returns {Promise<Uint8Array>} Decompressed data
 */
async function decompressZlib(data) {
    if (typeof DecompressionStream === 'undefined') {
        throw new Error('DecompressionStream not available in this browser');
    }
    // New backups use zlib, old VectHare versions wrote raw DEFLATE.
    for (const format of ['deflate', 'deflate-raw']) {
        try {
            const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream(format));
            return await readLimitedStream(stream, MAX_PNG_TEXT_BYTES);
        } catch (error) {
            if (/safe limit/.test(String(error?.message))) throw error;
            /* Try the legacy raw format. */
        }
    }
    throw new Error('Unsupported or corrupt VectHare zTXt compression');
}

// ============================================================================
// PNG CHUNK MANIPULATION
// ============================================================================

/**
 * Creates a PNG chunk
 * @param {string} type - 4-character chunk type (e.g., 'tEXt', 'zTXt')
 * @param {Uint8Array} data - Chunk data
 * @returns {Uint8Array} Complete chunk with length, type, data, and CRC
 */
function createChunk(type, data) {
    const typeBytes = new TextEncoder().encode(type);
    const chunk = new Uint8Array(4 + 4 + data.length + 4);
    const view = new DataView(chunk.buffer);

    // Length (4 bytes, big-endian)
    view.setUint32(0, data.length, false);

    // Type (4 bytes)
    chunk.set(typeBytes, 4);

    // Data
    chunk.set(data, 8);

    // CRC (4 bytes, big-endian) - calculated over type + data
    const crcData = new Uint8Array(4 + data.length);
    crcData.set(typeBytes, 0);
    crcData.set(data, 4);
    view.setUint32(8 + data.length, crc32(crcData), false);

    return chunk;
}

/**
 * Parses PNG chunks from binary data
 * @param {Uint8Array} pngData - PNG file data
 * @returns {Array<{type: string, data: Uint8Array, offset: number}>} Array of chunks
 */
function parseChunks(pngData) {
    return parseSafePng(pngData);
}

/**
 * Reconstructs PNG from chunks, inserting a new chunk before IEND
 * @param {Uint8Array} originalPng - Original PNG data
 * @param {Uint8Array} newChunk - New chunk to insert
 * @returns {Uint8Array} New PNG with inserted chunk
 */
function insertChunkBeforeIEND(originalPng, newChunk) {
    const chunks = parseChunks(originalPng);
    if (!chunks.some(c => c.type === 'IEND')) throw new Error('PNG missing IEND chunk');
    const parts = [originalPng.slice(0, 8)];
    let inserted = false;
    for (const chunk of chunks) {
        // Remove VectHare payloads from earlier exports, preserving other metadata.
        if ((chunk.type === 'tEXt' || chunk.type === 'zTXt') &&
            chunk.data.length > VECTHARE_KEYWORD.length &&
            new TextDecoder().decode(chunk.data.slice(0, VECTHARE_KEYWORD.length + 1)) === VECTHARE_KEYWORD + '\0') {
            continue;
        }
        if (chunk.type === 'IEND' && !inserted) {
            parts.push(newChunk);
            inserted = true;
        }
        parts.push(originalPng.slice(chunk.offset, chunk.offset + 12 + chunk.data.length));
        if (chunk.type === 'IEND') break;
    }
    const size = parts.reduce((sum, part) => sum + part.length, 0);
    const result = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.length; }
    return result;
}

// ============================================================================
// EXPORT FUNCTIONS
// ============================================================================

/**
 * Creates a zTXt chunk with compressed data
 * @param {string} keyword - Chunk keyword
 * @param {string} text - Text to compress
 * @returns {Promise<Uint8Array>} zTXt chunk
 */
async function createZTXtChunk(keyword, text) {
    const keywordBytes = new TextEncoder().encode(keyword);
    const textBytes = new TextEncoder().encode(text);

    // Try to compress
    const compressed = await compressZlib(textBytes);

    if (compressed) {
        // zTXt format: keyword + null + compression_method (0) + compressed_data
        const data = new Uint8Array(keywordBytes.length + 1 + 1 + compressed.length);
        data.set(keywordBytes, 0);
        data[keywordBytes.length] = 0; // Null separator
        data[keywordBytes.length + 1] = 0; // Compression method 0 = deflate
        data.set(compressed, keywordBytes.length + 2);

        console.log(`VectHare PNG: Compressed ${textBytes.length} bytes to ${compressed.length} bytes (${Math.round(compressed.length / textBytes.length * 100)}%)`);

        return createChunk('zTXt', data);
    } else {
        // Fall back to tEXt with base64 encoding
        console.warn('VectHare PNG: Using uncompressed tEXt chunk (compression unavailable)');
        let binary = '';
        for (let i = 0; i < textBytes.length; i += 8192) {
            binary += String.fromCharCode(...textBytes.subarray(i, i + 8192));
        }
        const base64 = btoa(binary);
        const base64Bytes = new TextEncoder().encode(base64);

        // tEXt format: keyword + null + text
        const data = new Uint8Array(keywordBytes.length + 1 + base64Bytes.length);
        data.set(keywordBytes, 0);
        data[keywordBytes.length] = 0;
        data.set(base64Bytes, keywordBytes.length + 1);

        return createChunk('tEXt', data);
    }
}

/**
 * Reads a tEXt or zTXt chunk
 * @param {object} chunk - Parsed chunk {type, data}
 * @returns {Promise<{keyword: string, text: string} | null>}
 */
async function readTextChunk(chunk) {
    if (chunk.type !== 'tEXt' && chunk.type !== 'zTXt') {
        return null;
    }

    // Find null separator
    let nullIndex = -1;
    for (let i = 0; i < chunk.data.length; i++) {
        if (chunk.data[i] === 0) {
            nullIndex = i;
            break;
        }
    }

    if (nullIndex === -1) return null;

    const keyword = new TextDecoder().decode(chunk.data.slice(0, nullIndex));

    if (chunk.type === 'tEXt') {
        // tEXt: keyword + null + text
        const textData = chunk.data.slice(nullIndex + 1);
        const text = new TextDecoder().decode(textData);

        // Check if it's base64 encoded (our fallback format)
        try {
            if (text.length > MAX_PNG_TEXT_BYTES * 2) throw new Error('PNG text exceeds safe limit');
            const decoded = atob(text);
            const bytes = Uint8Array.from(decoded, c => c.charCodeAt(0));
            return { keyword, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
        } catch {
            return { keyword, text };
        }
    } else {
        // zTXt: keyword + null + compression_method + compressed_data
        const compressionMethod = chunk.data[nullIndex + 1];
        if (compressionMethod !== 0) {
            throw new Error(`Unsupported compression method: ${compressionMethod}`);
        }

        const compressedData = chunk.data.slice(nullIndex + 2);
        const decompressed = await decompressZlib(compressedData);
        const text = new TextDecoder().decode(decompressed);

        return { keyword, text };
    }
}

/**
 * Converts any image to PNG using canvas
 * @param {File|Blob} imageFile - Image file
 * @returns {Promise<Uint8Array>} PNG data
 */
export async function convertToPNG(imageFile) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(imageFile);

        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;

            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);

            canvas.toBlob((blob) => {
                URL.revokeObjectURL(url);

                if (!blob) {
                    reject(new Error('Failed to convert image to PNG'));
                    return;
                }

                blob.arrayBuffer().then(buffer => {
                    resolve(new Uint8Array(buffer));
                }).catch(reject);
            }, 'image/png');
        };

        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('Failed to load image'));
        };

        img.src = url;
    });
}

/**
 * Creates a default placeholder PNG for exports
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {string} text - Text to display
 * @returns {Promise<Uint8Array>} PNG data
 */
export async function createDefaultPNG(width = 512, height = 512, text = 'VectHare Collection') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');

    // Background gradient
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#2d1b4e');
    gradient.addColorStop(1, '#1a1a2e');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    // Draw hare silhouette (simple)
    ctx.fillStyle = '#8b5cf6';
    ctx.beginPath();
    // Body
    ctx.ellipse(width/2, height/2 + 50, 80, 60, 0, 0, Math.PI * 2);
    ctx.fill();
    // Head
    ctx.beginPath();
    ctx.ellipse(width/2, height/2 - 30, 50, 45, 0, 0, Math.PI * 2);
    ctx.fill();
    // Ears
    ctx.beginPath();
    ctx.ellipse(width/2 - 25, height/2 - 120, 15, 50, -0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(width/2 + 25, height/2 - 120, 15, 50, 0.2, 0, Math.PI * 2);
    ctx.fill();

    // Text
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 24px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(text, width/2, height - 60);

    ctx.font = '16px sans-serif';
    ctx.fillStyle = '#a78bfa';
    ctx.fillText('VectHare Export', width/2, height - 30);

    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (!blob) {
                reject(new Error('Failed to create PNG'));
                return;
            }
            blob.arrayBuffer().then(buffer => {
                resolve(new Uint8Array(buffer));
            }).catch(reject);
        }, 'image/png');
    });
}

/**
 * Embeds VectHare export data into a PNG image
 * @param {object} exportData - VectHare export data object
 * @param {Uint8Array|null} pngData - Base PNG image (null = use default)
 * @returns {Promise<Uint8Array>} PNG with embedded data
 */
export const MAX_PNG_EXPORT_CHUNKS = 2500;
export const MAX_PNG_EXPORT_PAYLOAD_BYTES = 6 * 1024 * 1024;

/** PNG is only a small, shareable envelope, not a large-data backup format. */
export function validatePngExportSize(exportData) {
    const chunks = exportData?.type === 'multi'
        ? (Array.isArray(exportData.collections) ? exportData.collections.reduce((n, c) => n + (c?.chunks?.length || 0), 0) : Infinity)
        : (Array.isArray(exportData?.chunks) ? exportData.chunks.length : 0);
    if (chunks > MAX_PNG_EXPORT_CHUNKS)
        throw new Error('PNG export limited to 2,500 chunks; choose JSON or verified NDJSON instead');
    // Prevent costly stringify/compression for obviously huge text payloads.
    const collections = exportData?.type === 'multi' ? exportData.collections : [exportData];
    let approximateBytes = 0;
    for (const collection of collections || []) for (const chunk of collection?.chunks || []) {
        approximateBytes += (chunk?.text?.length || 0);
        if (approximateBytes > MAX_PNG_EXPORT_PAYLOAD_BYTES)
            throw new Error('PNG export exceeds safe payload limit; choose JSON or verified NDJSON');
    }
    return true;
}

export async function embedDataInPNG(exportData, pngData = null) {
    validatePngExportSize(exportData);
    // Enforce payload ceiling before canvas creation or compression.
    const jsonString = JSON.stringify(exportData);
    if (new TextEncoder().encode(jsonString).byteLength > MAX_PNG_EXPORT_PAYLOAD_BYTES)
        throw new Error('PNG export exceeds 6 MiB payload limit; choose JSON or verified NDJSON');
    // Use default image if none provided
    if (!pngData) {
        const collectionName = exportData.collection?.name ||
            (exportData.type === 'multi' ? `${exportData.stats?.totalCollections || 0} Collections` : 'Collection');
        pngData = await createDefaultPNG(512, 512, collectionName);
    }

    // Create zTXt chunk with compressed data
    const textChunk = await createZTXtChunk(VECTHARE_KEYWORD, jsonString);

    // Insert chunk into PNG
    const result = insertChunkBeforeIEND(pngData, textChunk);

    console.log(`VectHare PNG: Created PNG export (${result.length} bytes, original JSON: ${jsonString.length} bytes)`);

    return result;
}

/**
 * Extracts VectHare data from a PNG image
 * @param {Uint8Array} pngData - PNG file data
 * @returns {Promise<object|null>} Extracted export data or null if not found
 */
export async function extractDataFromPNG(pngData) {
    const chunks = parseChunks(pngData);

    // Latest valid payload wins for old PNGs containing multiple VectHare chunks.
    for (const chunk of [...chunks].reverse()) {
        if (chunk.type === 'tEXt' || chunk.type === 'zTXt') {
            try {
                const textData = await readTextChunk(chunk);
                if (textData && textData.keyword === VECTHARE_KEYWORD) {
                    const exportData = JSON.parse(textData.text);
                    console.log('VectHare PNG: Successfully extracted data from PNG');
                    return exportData;
                }
            } catch (e) {
                console.warn('VectHare PNG: Failed to read text chunk:', e);
            }
        }
    }

    return null;
}

/**
 * Downloads PNG data as a file
 * @param {Uint8Array} pngData - PNG data
 * @param {string} filename - Filename (without extension)
 */
export function downloadPNG(pngData, filename) {
    const blob = new Blob([pngData], { type: 'image/png' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = filename.endsWith('.png') ? filename : `${filename}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    console.log(`VectHare PNG: Downloaded ${a.download}`);
}

/**
 * Reads a PNG file from a File object
 * @param {File} file - File object
 * @returns {Promise<Uint8Array>} PNG data
 */
export async function readPNGFile(file) {
    const buffer = await file.arrayBuffer();
    return new Uint8Array(buffer);
}

/**
 * Checks if a file is a PNG with VectHare data
 * @param {File} file - File to check
 * @returns {Promise<boolean>}
 */
export async function isVectHarePNG(file) {
    if (!file.type.includes('png') && !file.name.toLowerCase().endsWith('.png')) {
        return false;
    }

    try {
        const data = await readPNGFile(file);
        const exportData = await extractDataFromPNG(data);
        return exportData !== null && (exportData.generator === 'VectHare' || exportData.version);
    } catch {
        return false;
    }
}
