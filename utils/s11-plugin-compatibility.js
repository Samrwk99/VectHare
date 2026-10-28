/** S11 integration with the S10 inspection-only API.
 * A source fingerprint matches a supplied release, NOT a trusted deployment
 * attestation. Neither capability statements nor inspection responses unlock
 * E02 mutations, native SillyTavern routes, or plugin v2 execution.
 */
import { guardedVectorFetch } from './e02-vector-request-gateway.js';
export const S11_EXPECTED_PLUGIN = Object.freeze({
    pluginVersion: '3.2.10-s10.3',
    contractVersion: 2,
    sourceFingerprint: '18c2b0b5f78ac3a430aa6acb66315dad814d23b030bc62298c0d197f52110acd',
});
export const S11_BACKENDS = Object.freeze(['standard','lancedb','qdrant','milvus']);
const ROOT = '/api/plugins/similharity';
const BLOCKED = Object.freeze({compatible:false,readiness:'BLOCKED',reason:'not-checked',writeEnabled:false,publicV2ReadsEnabled:false});
let latest=BLOCKED;
const isObj = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeString = x => typeof x === 'string' && x.length < 256 ? x : '';
export function validateS11Discovery(build,caps,contracts,expected=S11_EXPECTED_PLUGIN) {
    const refused = reason => Object.freeze({compatible:false,readiness:'BLOCKED',reason,writeEnabled:false,publicV2ReadsEnabled:false});
    if(!isObj(build) || !isObj(caps) || !isObj(contracts))return refused('invalid-discovery-shape');
    if(build.pluginVersion!==expected.pluginVersion || caps.pluginVersion!==expected.pluginVersion)return refused('plugin-version-mismatch');
    if(build.contractVersion!==expected.contractVersion || caps.contractVersion!==expected.contractVersion || contracts.contractVersion!==expected.contractVersion)
        return refused('contract-version-mismatch');
    if(build.sourceFingerprint!==expected.sourceFingerprint || caps.sourceFingerprint!==expected.sourceFingerprint)
        return refused('source-fingerprint-mismatch');
    if(build.verification!=='MATCHED_LOCAL_SOURCE_MANIFEST' || caps.buildVerification!=='MATCHED_LOCAL_SOURCE_MANIFEST')
        return refused('unverified-local-manifest');
    if(!isObj(caps.backends) || S11_BACKENDS.some(b=>!isObj(caps.backends[b]?.operations)))return refused('backend-contract-missing');
    if(caps.capabilityClaimsArePermissions!==false || caps.productionCertified!==false || caps.publicV2MutationsEnabled!==false || caps.publicV2ReadsEnabled!==false)
        return refused('unsupported-capability-claims');
    if(contracts.executionCertified!==false || !isObj(contracts.routes) || contracts.routes['POST /v2/operations/submit']!=='DENIED' || contracts.routes['POST /v2/reads/get']!=='DENIED')
        return refused('unexpected-execution-contract');
    if(S11_BACKENDS.some(b=>['insert','delete','updateText','updateMetadata','operationSubmit'].some(op=>
        caps.backends[b].operations[op]!=='DENIED_NOT_LIVE_CERTIFIED')))return refused('unaccepted-mutation-claim');
    return Object.freeze({compatible:true,readiness:'INSPECTION_ONLY',reason:'s10-matched-not-live-attested',
        pluginVersion:safeString(build.pluginVersion),sourceFingerprint:safeString(build.sourceFingerprint),
        writeEnabled:false,publicV2ReadsEnabled:false,
        hostAttested:false,sourceOwnershipAttested:false,backendsCertified:false});
}
/** GET only; never sends settings, secrets, chat content, or mutation requests. */
export async function discoverS11Plugin({fetchImpl=globalThis.fetch,expected=S11_EXPECTED_PLUGIN,timeoutMs=8000}={}) {
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),timeoutMs);
    try {
        const read=async suffix=>{
            const response=await guardedVectorFetch(`${ROOT}${suffix}`,{method:'GET',signal:controller.signal,credentials:'same-origin',cache:'no-store'},fetchImpl);
            if(!response?.ok)throw new Error(`http-${response?.status ?? 'unknown'}`);
            const result=await response.json();
            if(!isObj(result))throw new Error('invalid-json-shape');
            return result;
        };
        // Independent endpoints: the three reports must agree on contract and build.
        const build=await read('/v2/build');
        const caps=await read('/v2/capabilities');
        const contracts=await read('/v2/contracts');
        latest=validateS11Discovery(build,caps,contracts,expected);
        return latest;
    }catch(error){
        const reason=error?.name==='AbortError'?'discovery-timeout':'discovery-unavailable-or-invalid';
        latest=Object.freeze({...BLOCKED,reason});
        return latest;
    }finally{clearTimeout(timeout);}
}
export function s11PluginStatus(){return latest;}
export function resetS11DiscoveryForTests(){latest=BLOCKED;}

/** Text-only status for VectHare settings; never inserts server-provided HTML. */
export function renderS11CompatibilityStatus(root,status,doc=globalThis.document) {
    if(!root || !doc?.createElement)return false;
    let node=root.querySelector?.('#vecthare_s11_compatibility');
    if(!node){node=doc.createElement('div');node.id='vecthare_s11_compatibility';
        node.setAttribute('role','status');node.style.padding='0.5em';
        node.style.marginBottom='0.5em';root.prepend(node);}
    node.textContent=status?.compatible
        ? 'Similharity S10 detected (inspection only). Vector writes and unverified v2 reads remain disabled; live host acceptance required.'
        : 'Similharity S10 compatibility not verified. Unsafe operations remain disabled.';
    return true;
}
