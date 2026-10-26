/**
 * Clear BananaBread's active custom secret AND its VectHare settings copy.
 * Do not mutate local settings if the server rejects the request; otherwise a
 * still-active server secret could be used even though the UI says "cleared".
 * @param {object} settings VectHare settings snapshot
 * @param {Function} fetchImpl fetch-compatible transport
 * @param {object} headers SillyTavern request headers
 * @param {Function} commit Save/update settings callback
 */
export async function clearBananaBreadKey(settings, fetchImpl, headers, commit) {
    const response = await fetchImpl('/api/secrets/write', {
        method: 'POST',
        headers,
        body: JSON.stringify({ key: 'bananabread_api_key', value: '' }),
    });
    if (!response.ok) {
        throw new Error('BananaBread secret revocation was rejected');
    }
    const message = (await response.text()).trim();
    if (message && message !== 'ok') {
        // Do not treat an application-level failure as a successful revocation.
        let result;
        try { result = JSON.parse(message); } catch { /* plain success response */ }
        if (result?.success === false || /^error|^fail/i.test(message)) {
            throw new Error('BananaBread secret revocation was not confirmed');
        }
    }
    settings.bananabread_api_key = '';
    commit();
}
