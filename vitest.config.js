import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

const extensionsStub = fileURLToPath(new URL('./tests/stubs/extensions.js', import.meta.url));
const scriptStub = fileURLToPath(new URL('./tests/stubs/script.js', import.meta.url));
const textgen_settingsStub = fileURLToPath(new URL('./tests/stubs/textgen-settings.js', import.meta.url));
const openaiStub = fileURLToPath(new URL('./tests/stubs/openai.js', import.meta.url));
const secretsStub = fileURLToPath(new URL('./tests/stubs/secrets.js', import.meta.url));
const utilsStub = fileURLToPath(new URL('./tests/stubs/utils.js', import.meta.url));
const world_infoStub = fileURLToPath(new URL('./tests/stubs/world-info.js', import.meta.url));

export default defineConfig({
    resolve: {
        alias: [
            { find: /\/extensions\.js$/, replacement: extensionsStub },
            { find: /\/script\.js$/, replacement: scriptStub },
            { find: /\/textgen-settings\.js$/, replacement: textgen_settingsStub },
            { find: /\/openai\.js$/, replacement: openaiStub },
            { find: /\/secrets\.js$/, replacement: secretsStub },
            { find: /\/utils\.js$/, replacement: utilsStub },
            { find: /\/world-info\.js$/, replacement: world_infoStub },
        ],
    },
    test: {
        include: ['tests/**/*.test.js'],
        environment: 'node',
        globals: true,
        coverage: { provider: 'v8', reporter: ['text', 'html', 'lcov'], include: ['core/**/*.js', 'utils/**/*.js'], exclude: ['**/node_modules/**', 'tests/**'] },
        reporters: ['verbose'],
        testTimeout: 10000,
        hookTimeout: 10000
    }
});
