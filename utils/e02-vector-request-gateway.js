/** E02: one explicit transport policy for *both* Similharity and the native
 * SillyTavern vector plane.  E01 is source evidence, NOT permission to mutate.
 * This module intentionally leaves the supplied plugin untouched.
 *
 * Important: this guards VectHare calls, not other browser extensions, users,
 * server-side plugin internals, or third-party clients.  No runtime file-hash
 * attestation exists.  Never interpret a successful response as commit proof.
 */
import { E02_MATRIX_STATUS } from './e02-matrix-status.js';

const PLUGIN = '/api/plugins/similharity';
const NATIVE = '/api/vector/';
export const E02_STATUS = Object.freeze({ ALLOWED:'ALLOWED', GUARDED:'GUARDED', UNPROBED:'UNPROBED', DENIED:'DENIED' });
export class VectorOperationDenied extends Error {
    constructor({backend='unknown',operation='unknown',reason='unverified',transport='plugin'}={}) {
        super(`VectHare safety gate: ${transport}/${backend}/${operation} refused (${reason}).`);
        this.name = 'VectorOperationDenied';
        this.backend = backend;
        this.operation = operation;
        this.reason = reason;
        this.code = 'VECTHARE_E02_OPERATION_DENIED';
    }
}
const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const backendAliases = Object.freeze({ vectra:'standard', standard:'standard', qdrant:'qdrant', milvus:'milvus', lancedb:'lancedb' });
const nativeOperation = Object.freeze({list:'list',query:'query','query-multi':'query',insert:'insert',delete:'delete',purge:'purge'});
const pluginOperations = Object.freeze({
    '/health':'health', '/collections':'collections', '/sources':'sources', '/open-folder':'openFolder',
    '/get-embedding':'embed', '/batch-embeddings':'batchEmbed', '/rerank':'rerank',
    '/chunks/list':'list','/chunks/insert':'insert','/chunks/delete':'delete',
    '/chunks/query':'query','/chunks/hybrid-query':'hybrid','/chunks/purge':'purge',
    '/chunks/stats':'stats','/purge-all':'purgeAll',
});
// S11: only explicitly enumerated inspection GETs are allowed. All v2
// execution and unknown paths remain denied before network dispatch.
const s11InspectionPaths = new Set(['/capabilities','/v2/capabilities','/v2/contracts','/v2/build']);
const shared = backend => backend === 'qdrant' || backend === 'milvus';
function parseRequest(url, options={}) {
    const urlText = typeof url === 'string' ? url : (url?.url || '');
    const parsed = new URL(urlText, 'http://localhost');
    const path = parsed.pathname;
    if (path !== PLUGIN && !path.startsWith(PLUGIN + '/') && !path.startsWith(NATIVE)) return null;
    const isPlugin = path.startsWith(PLUGIN);
    const transport = isPlugin ? 'plugin' : 'native';
    const suffix = isPlugin ? path.slice(PLUGIN.length) : path.slice(NATIVE.length);
    const method = String(options.method || url?.method || 'GET').toUpperCase();
    let body = null;
    if (options.body !== undefined && options.body !== null) {
        if (typeof options.body === 'string') {
            try { body = JSON.parse(options.body); } catch { body = null; }
        } else if (typeof options.body === 'object' && !(options.body instanceof FormData)) body = options.body;
    }
    const operation = isPlugin
        ? (pluginOperations[suffix] || (/^\/backend\/health\/[^/]+$/.test(suffix) ? 'backendHealth' :
            /^\/backend\/init\/[^/]+$/.test(suffix) ? 'init' :
            /^\/chunks\/[^/]+\/text$/.test(suffix) ? 'patchText' :
            /^\/chunks\/[^/]+\/metadata$/.test(suffix) ? 'patchMetadata' :
            /^\/chunks\/[^/]+$/.test(suffix) ? 'get' :
            /^\/capabilities\/secrets(?:\/test)?$/.test(suffix) ? 'secretProbe' : null))
        : nativeOperation[suffix] || null;
    const pathBackend = suffix.match(/^\/backend\/(?:health|init)\/([^/]+)$/)?.[1];
    const backend = isPlugin ? (backendAliases[body?.backend || parsed.searchParams.get('backend') || pathBackend || 'vectra'] || 'unknown') : 'standard';
    return {transport, operation, backend, suffix, method, body, parsed};
}
function fail(request,reason){ throw new VectorOperationDenied({...request,reason}); }
function hasValidTenant(value){
    return value && typeof value === 'object' && !Array.isArray(value) &&
        typeof value.type === 'string' && value.type.trim() && value.type.trim().toLowerCase() !== 'unknown' &&
        typeof value.sourceId === 'string' && value.sourceId.trim() && value.sourceId.trim().toLowerCase() !== 'unknown';
}
/** Pure policy decision. It does not mutate request payloads or infer ownership. */
export function inspectVectorRequest(url, options={}) {
    const req = parseRequest(url, options);
    if (!req) return {intercepted:false,allowed:true};
    if (req.transport === 'plugin' && s11InspectionPaths.has(req.suffix)) {
        if (req.method !== 'GET') fail(req,'inspection-readonly');
        if (req.body != null) fail(req,'inspection-rejects-body');
        return {intercepted:true,allowed:true,transport:'plugin',operation:'s11Discovery',backend:'none',method:'GET'};
    }
    // S11.4: specifically reviewed authenticated database CONFIGURATION routes.
    // These never insert or delete vector records; server validates CSRF,
    // trusted user scope, endpoint restrictions and private file storage.
    if (req.transport === 'plugin' && /^\/v2\/connections\/(?:qdrant|milvus)$/.test(req.suffix)) {
        if (!['GET','PUT','DELETE'].includes(req.method)) fail(req,'config-method-unsupported');
        if (req.method === 'GET' && req.body != null) fail(req,'config-read-body');
        if (req.method === 'PUT') {
            if (!req.body || !['default','local'].includes(req.body.configId)) fail(req,'config-selector-required');
        }
        return {intercepted:true,allowed:true,operation:'guiConnectionConfiguration',backend:'none',transport:'plugin',method:req.method};
    }
    // F01: read/verify only a host-owned chat/group/lorebook file; route may
    // reserve a private source identity but can NEVER read/write vector records.
    if (req.transport === 'plugin' && req.suffix === '/v2/sources/attest') {
        const b=req.body;
        const expected=b?.kind==='chat'?['kind','avatar','chatFile']:
            b?.kind==='group-chat'?['kind','chatFile','groupId']:
            b?.kind==='lorebook'?['kind','name']:[];
        if(req.method!=='POST'||!b||!expected.length||Object.keys(b).some(k=>!expected.includes(k))||
           expected.some(k=>typeof b[k]!=='string'||!b[k]||b[k].length>220))
            fail(req,'f01-source-selector-invalid');
        return {intercepted:true,allowed:true,transport:'plugin',operation:'hostSourceAttestation',backend:'none',method:'POST'};
    }
    // F02: reviewed v2 read/binding API. The server re-attests the selected
    // saved file and validates an exact v2 registry + physical schema on EACH
    // read; this allowance is NOT a global query, export or write permission.
    if (req.transport === 'plugin' && /^\/v2\/reads\/(?:bind|get|list|query)$/.test(req.suffix)) {
        const b=req.body;
        const source=b?.source, embedding=b?.embedding;
        const kind=source?.kind;
        const sourceKeys=kind==='chat'?['kind','avatar','chatFile']:
            kind==='group-chat'?['kind','groupId','chatFile']:
            kind==='lorebook'?['kind','name']:[];
        const operation=req.suffix.slice('/v2/reads/'.length);
        const allowed=['backend','source','embedding','configId',
            ...(operation==='list'?['page']:operation==='get'?['recordId']:operation==='query'?['vector','topK']:[])];
        if(req.method!=='POST'||!b||!sourceKeys.length||typeof source!=='object'||Array.isArray(source)||
           Object.keys(source).some(k=>!sourceKeys.includes(k))||sourceKeys.some(k=>typeof source[k]!=='string'||!source[k]||source[k].length>220)||
           !embedding||typeof embedding!=='object'||Array.isArray(embedding)||
           Object.keys(embedding).some(k=>!['source','model','dimension','metric'].includes(k))||
           !['qdrant','milvus','lancedb','vectra'].includes(b.backend)||
           Object.keys(b).some(k=>!allowed.includes(k))||
           (b.configId!==undefined&&!['local','default'].includes(b.configId)))
            fail(req,'f02-host-scoped-read-shape-required');
        return {intercepted:true,allowed:true,transport:'plugin',operation:`f02-${operation}`,backend:b.backend,method:'POST'};
    }
    // F09: ordinary v2 candidate retrieval PREVIEW. Uses the same F01/F02
    // server-owned scope and physical schema checks; never a legacy hash route.
    if(req.transport==='plugin'&&req.suffix==='/v2/workflows/preview'){
        const b=req.body,source=b?.source,embedding=b?.embedding;
        const sourceKeys=source?.kind==='chat'?['kind','avatar','chatFile']:
            source?.kind==='group-chat'?['kind','groupId','chatFile']:
            source?.kind==='lorebook'?['kind','name']:[];
        if(req.method!=='POST'||!b||!sourceKeys.length||!source||
           Object.keys(source).some(k=>!sourceKeys.includes(k))||
           sourceKeys.some(k=>typeof source[k]!=='string'||!source[k]||source[k].length>220)||
           !embedding||typeof embedding!=='object'||Array.isArray(embedding)||
           Object.keys(embedding).some(k=>!['source','model','dimension','metric'].includes(k))||
           !['qdrant','milvus','lancedb','vectra'].includes(b.backend)||
           (b.configId!==undefined&&!['local','default'].includes(b.configId))||
           !Array.isArray(b.vector)||!Number.isInteger(b.topK)||b.topK<1||b.topK>30||
           Object.keys(b).some(k=>!['backend','source','embedding','configId','vector','topK'].includes(k)))
            fail(req,'f09-source-bound-preview-required');
        return {intercepted:true,allowed:true,transport:'plugin',operation:'f09CandidatePreview',backend:b.backend,method:'POST'};
    }
    // F10: authenticated bounded RECORD EVIDENCE, never an authoritative export,
    // restore, migration or production mutation permission. Strict body shape.
    if(req.transport==='plugin'&&/^\/v2\/recovery\/(?:capture|status|download)$/.test(req.suffix)){
        const b=req.body,source=b?.source,embedding=b?.embedding;
        const kind=source?.kind;
        const sourceKeys=kind==='chat'?['kind','avatar','chatFile']:
          kind==='group-chat'?['kind','groupId','chatFile']:
          kind==='lorebook'?['kind','name']:[];
        const op=req.suffix.split('/').pop();
        const allowed=['backend','source','embedding','configId',...(op==='capture'?['confirmCapture']:['captureId'])];
        if(req.method!=='POST'||!b||!['qdrant','lancedb','vectra','milvus'].includes(b.backend)||
           !sourceKeys.length||!source||Object.keys(source).some(k=>!sourceKeys.includes(k))||
           sourceKeys.some(k=>typeof source[k]!=='string'||!source[k]||source[k].length>220)||
           !embedding||typeof embedding!=='object'||Array.isArray(embedding)||
           Object.keys(embedding).some(k=>!['source','model','dimension','metric'].includes(k))||
           Object.keys(b).some(k=>!allowed.includes(k))||
           (b.configId!==undefined&&!['local','default'].includes(b.configId))||
           (b.backend!=='qdrant'&&b.configId==='local')||
           (op==='capture'&&b.confirmCapture!=='I UNDERSTAND THIS IS NOT A VERIFIED FULL BACKUP')||
           (op!=='capture'&&!UUID_RE.test(b.captureId||'')))
           fail(req,'f10-nonauthoritative-capture-shape-required');
        return {intercepted:true,allowed:true,transport:'plugin',operation:'f10Evidence'+op,backend:b.backend,method:'POST'};
    }
    // F03: opt-in schema provisioning only (NO record writes, overwrite or purge).
    // Requires F01 source selector, derived physical name, and exact confirmation.
    if(req.transport==='plugin' && /^\/v2\/collections\/(?:preview|provision|status)$/.test(req.suffix)){
        const body=req.body, source=body?.source, embedding=body?.embedding;
        const kind=source?.kind;
        const sourceKeys=kind==='chat'?['kind','avatar','chatFile']:
            kind==='group-chat'?['kind','groupId','chatFile']:
            kind==='lorebook'?['kind','name']:[];
        const provision=req.suffix.endsWith('/provision');
        const keys=['backend','source','embedding','configId',...(provision?['confirmProvision','expectedCollectionName']:[])];
        if(req.method!=='POST'||!body||!['qdrant','milvus','lancedb','vectra'].includes(body.backend)||
           !sourceKeys.length||!source||Object.keys(source).some(k=>!sourceKeys.includes(k))||
           sourceKeys.some(k=>typeof source[k]!=='string'||!source[k]||source[k].length>220)||
           !embedding||typeof embedding!=='object'||Array.isArray(embedding)||
           Object.keys(embedding).some(k=>!['source','model','dimension','metric'].includes(k))||
           Object.keys(body).some(k=>!keys.includes(k))||
           (body.configId!==undefined&&!['local','default'].includes(body.configId))||
           (body.backend==='milvus'&&body.configId==='local')||
           (provision&&(body.confirmProvision!==true||!/^vh2_[a-f0-9]{48}$/.test(body.expectedCollectionName))))
            fail(req,'f03-explicit-source-provision-contract-required');
        return {intercepted:true,allowed:true,transport:'plugin',operation:provision?'f03SchemaProvision':'f03SchemaPreview',
            backend:body.backend,method:'POST'};
    }
    // S04 F04 receipt inspection is read-only, bound to the authenticated
    // plugin user directory. A UUID never selects a vector collection.
    if(req.transport==='plugin'&&/^\/v2\/operations\/[0-9a-f-]+$/i.test(req.suffix)){
        if(req.method!=='GET'||req.body!=null||
           !/^\/v2\/operations\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.suffix))
            fail(req,'f04-operation-receipt-invalid');
        return {intercepted:true,allowed:true,transport:'plugin',operation:'s04OperationReceipt',backend:'none',method:'GET'};
    }
    // F04: manual, explicitly consented source-bound pilot for a NEW F03 Qdrant
    // collection. This is NEVER an E02 matrix unlock or ordinary memory route.
    if(req.transport==='plugin'&&req.suffix==='/v2/records/pilot-mutate'){
        const b=req.body,source=b?.source,embedding=b?.embedding;
        const kind=source?.kind;
        const sourceKeys=kind==='chat'?['kind','avatar','chatFile']:
            kind==='group-chat'?['kind','groupId','chatFile']:
            kind==='lorebook'?['kind','name']:[];
        const allowed=['backend','source','embedding','configId','action','recordId','expectedRevision',
            'operationId','experimentalConsent','text','vector','metadata'];
        const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        if(req.method!=='POST'||!b||b.backend!=='qdrant'||b.configId!=='local'||
           b.experimentalConsent!=='I ACCEPT DISPOSABLE V2 RECORD MUTATIONS'||
           !['insert','update','metadata','delete'].includes(b.action)||
           !uuid.test(b.recordId||'')||!uuid.test(b.operationId||'')||
           !sourceKeys.length||!source||Object.keys(source).some(k=>!sourceKeys.includes(k))||
           sourceKeys.some(k=>typeof source[k]!=='string'||!source[k]||source[k].length>220)||
           !embedding||typeof embedding!=='object'||Array.isArray(embedding)||
           Object.keys(embedding).some(k=>!['source','model','dimension','metric'].includes(k))||
           Object.keys(b).some(k=>!allowed.includes(k))||
           (b.action==='insert'&&b.expectedRevision!==0)||
           (b.action!=='insert'&&(!Number.isSafeInteger(b.expectedRevision)||b.expectedRevision<1))||
           (['delete','metadata'].includes(b.action)&&(b.text!==undefined||b.vector!==undefined))||
           (b.action==='delete'&&b.metadata!==undefined))fail(req,'f04-disposable-source-bound-pilot-required');
        return {intercepted:true,allowed:true,transport:'plugin',operation:'f04PilotMutation',backend:'qdrant',method:'POST'};
    }
    // F06: manual, explicitly consented source-bound pilot for a NEW F03 LanceDB
    // collection. This is NEVER an E02 matrix unlock or ordinary memory route.
    if(req.transport==='plugin'&&req.suffix==='/v2/records/lancedb-pilot-mutate'){
        const b=req.body,source=b?.source,embedding=b?.embedding;
        const kind=source?.kind;
        const sourceKeys=kind==='chat'?['kind','avatar','chatFile']:
            kind==='group-chat'?['kind','groupId','chatFile']:
            kind==='lorebook'?['kind','name']:[];
        const allowed=['backend','source','embedding','configId','action','recordId','expectedRevision',
            'operationId','experimentalConsent','text','vector','metadata'];
        const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        if(req.method!=='POST'||!b||b.backend!=='lancedb'||b.configId!=='default'||
           b.experimentalConsent!=='I ACCEPT F06 LOCAL LANCEDB PILOT'||
           !['insert','update','metadata','delete'].includes(b.action)||
           !uuid.test(b.recordId||'')||!uuid.test(b.operationId||'')||
           !sourceKeys.length||!source||Object.keys(source).some(k=>!sourceKeys.includes(k))||
           sourceKeys.some(k=>typeof source[k]!=='string'||!source[k]||source[k].length>220)||
           !embedding||typeof embedding!=='object'||Array.isArray(embedding)||
           Object.keys(embedding).some(k=>!['source','model','dimension','metric'].includes(k))||
           Object.keys(b).some(k=>!allowed.includes(k))||
           (b.action==='insert'&&b.expectedRevision!==0)||
           (b.action!=='insert'&&(!Number.isSafeInteger(b.expectedRevision)||b.expectedRevision<1))||
           (['delete','metadata'].includes(b.action)&&(b.text!==undefined||b.vector!==undefined))||
           (b.action==='delete'&&b.metadata!==undefined))fail(req,'f06-disposable-source-bound-pilot-required');
        return {intercepted:true,allowed:true,transport:'plugin',operation:'f06PilotMutation',backend:'lancedb',method:'POST'};
    }
    // F08: Milvus disposable acceptance creates a new server-selected collection.
    if(req.transport==='plugin'&&req.suffix==='/v2/diagnostics/milvus-f08'){
        const b=req.body;
        if(req.method!=='POST'||!b||b.configId!=='default'||
           b.consent!=='I ACCEPT F08 DISPOSABLE MILVUS TEST'||
           Object.keys(b).some(k=>!['configId','consent'].includes(k)))fail(req,'f08-disposable-consent-required');
        return {intercepted:true,allowed:true,transport:'plugin',operation:'f08DisposableAcceptance',backend:'milvus',method:'POST'};
    }
    // F08: explicit server-attested MILVUS local pilot only; no client owners/physical IDs.
    if(req.transport==='plugin'&&req.suffix==='/v2/records/milvus-pilot-mutate'){
        const b=req.body,src=b?.source,emb=b?.embedding;
        const k=src?.kind,sourceKeys=k==='chat'?['kind','avatar','chatFile']:
          k==='group-chat'?['kind','groupId','chatFile']:
          k==='lorebook'?['kind','name']:[];
        const accepted=['backend','source','embedding','configId','action','recordId','expectedRevision','operationId',
         'experimentalConsent','text','vector','metadata'];
        const fields=['insert','update'].includes(b?.action)?['text','vector','metadata']:
          b?.action==='metadata'?['metadata']:[];
        if(req.method!=='POST'||!b||b.backend!=='milvus'||b.configId!=='default'||
           b.experimentalConsent!=='I ACCEPT F08 DISPOSABLE MILVUS PILOT'||
           !['insert','update','metadata','delete'].includes(b.action)||
           !UUID_RE.test(b.recordId||'')||!UUID_RE.test(b.operationId||'')||
           !sourceKeys.length||!src||Object.keys(src).some(key=>!sourceKeys.includes(key))||
           sourceKeys.some(key=>typeof src[key]!=='string'||!src[key]||src[key].length>220)||
           !emb||typeof emb!=='object'||Array.isArray(emb)||
           Object.keys(emb).some(key=>!['source','model','dimension','metric'].includes(key))||
           Object.keys(b).some(key=>!accepted.includes(key))||
           (b.action==='insert'&&b.expectedRevision!==0)||
           (b.action!=='insert'&&(!Number.isSafeInteger(b.expectedRevision)||b.expectedRevision<1))||
           ['text','vector','metadata'].some(key=>Object.hasOwn(b,key)&&!fields.includes(key))||
           (['insert','update'].includes(b.action)&&(typeof b.text!=='string'||!Array.isArray(b.vector)))||
           (b.action==='metadata'&&(!b.metadata||typeof b.metadata!=='object'||Array.isArray(b.metadata))))
           fail(req,'f08-disposable-source-bound-pilot-required');
        return {intercepted:true,allowed:true,transport:'plugin',operation:'f08PilotMutation',backend:'milvus',method:'POST'};
    }
    // F07: source-bound Vectra LOCAL PILOT; NEVER native SillyTavern Standard.
    if(req.transport==='plugin'&&req.suffix==='/v2/records/vectra-pilot-mutate'){
        const b=req.body, src=b?.source, emb=b?.embedding;
        const k=src?.kind, sourceKeys=k==='chat'?['kind','avatar','chatFile']:
            k==='group-chat'?['kind','groupId','chatFile']:
            k==='lorebook'?['kind','name']:[];
        const accepted=['backend','source','embedding','configId','action','recordId','expectedRevision','operationId',
            'experimentalConsent','text','vector','metadata'];
        if(req.method!=='POST'||!b||b.backend!=='vectra'||b.configId!=='default'||
           b.experimentalConsent!=='I ACCEPT F07 LOCAL VECTRA PILOT'||
           !['insert','update','metadata','delete'].includes(b.action)||
           !UUID_RE.test(b.recordId||'')||!UUID_RE.test(b.operationId||'')||
           !sourceKeys.length||!src||Object.keys(src).some(key=>!sourceKeys.includes(key))||
           sourceKeys.some(key=>typeof src[key]!=='string'||!src[key]||src[key].length>220)||
           !emb||typeof emb!=='object'||Array.isArray(emb)||
           Object.keys(emb).some(key=>!['source','model','dimension','metric'].includes(key))||
           Object.keys(b).some(key=>!accepted.includes(key))||
           (b.action==='insert'&&b.expectedRevision!==0)||
           (b.action!=='insert'&&(!Number.isSafeInteger(b.expectedRevision)||b.expectedRevision<1))||
           (['delete','metadata'].includes(b.action)&&(b.text!==undefined||b.vector!==undefined))||
           (b.action==='delete'&&b.metadata!==undefined))fail(req,'f07-disposable-source-bound-pilot-required');
        return {intercepted:true,allowed:true,transport:'plugin',operation:'f07PilotMutation',backend:'vectra',method:'POST'};
    }
    // F07 diagnostic is a server-generated new index with synthetic data only.
    if(req.transport==='plugin'&&req.suffix==='/v2/diagnostics/vectra-f07'){
        const b=req.body;
        if(req.method!=='POST'||!b||b.consent!=='I ACCEPT F07 DISPOSABLE VECTRA TEST'||
           Object.keys(b).some(k=>k!=='consent'))fail(req,'f07-disposable-consent-required');
        return {intercepted:true,allowed:true,transport:'plugin',backend:'vectra',
            operation:'f07DisposableAcceptance',method:'POST'};
    }
    // F05: fixed-parameter, explicit-consent local Qdrant acceptance suite.
    // Server selects a new random namespace and synthetic record IDs. No user
    // chat, backend collection, physical IDs, or credentials are transported.
    if(req.transport==='plugin'&&req.suffix==='/v2/diagnostics/qdrant-f05'){
        const b=req.body;
        if(req.method!=='POST'||!b||b.configId!=='local'||
           b.consent!=='I ACCEPT F05 DISPOSABLE QDRANT TEST'||
           Object.keys(b).some(k=>!['configId','consent'].includes(k)))
            fail(req,'f05-disposable-consent-required');
        return {intercepted:true,allowed:true,transport:'plugin',backend:'qdrant',
            operation:'f05DisposableAcceptance',method:'POST'};
    }
    // F06: one explicitly confirmed isolated LanceDB diagnostic. A browser
    // cannot select paths, physical tables, owners, record IDs or credentials.
    if(req.transport==='plugin'&&req.suffix==='/v2/diagnostics/lancedb-f06'){
        const b=req.body;
        if(req.method!=='POST'||!b||b.consent!=='I ACCEPT F06 DISPOSABLE LANCEDB TEST'||
           Object.keys(b).some(k=>k!=='consent'))fail(req,'f06-disposable-consent-required');
        return {intercepted:true,allowed:true,transport:'plugin',backend:'lancedb',
            operation:'f06DisposableAcceptance',method:'POST'};
    }
    // H01 is a narrowly bounded, explicitly confirmed disposable acceptance
    // diagnostic. It cannot select a collection, write real memories, or lift
    // any production capability matrix cell.
    if (req.transport === 'plugin' && req.suffix === '/v2/diagnostics/qdrant-contract') {
        if (req.method !== 'POST' || !req.body || req.body.confirmDisposable !== true ||
            !['local','default'].includes(req.body.configId) ||
            Object.keys(req.body).some(key => !['confirmDisposable','configId'].includes(key))) {
            fail(req,'h01-disposable-confirmation-required');
        }
        return {intercepted:true,allowed:true,transport:'plugin',operation:'disposableAcceptance',backend:'qdrant',method:'POST'};
    }
    // S10 v2 execution routes are implemented only as refusal contracts.
    // Do not allow aliases or a newer plugin response to override this rule.
    if (req.transport === 'plugin' && (req.suffix==='/v2' || req.suffix.startsWith('/v2/'))) fail(req,'s11-v2-execution-not-certified');
    if (!req.operation || req.backend === 'unknown') fail(req, 'unsupported-route-or-backend');
    if (req.operation === 'secretProbe') return {intercepted:true,allowed:true,operation:'secretProbe',backend:req.backend,transport:req.transport};
    if (req.transport === 'native') {
        // Native host is a different implementation, not attested by plugin source.
        if (['insert','delete','purge'].includes(req.operation)) fail(req,'native-mutation-contract-unprobed');
        if (req.method !== 'POST') fail(req,'unexpected-native-method');
        return {intercepted:true,allowed:true,...req};
    }
    const status = E02_MATRIX_STATUS[req.backend]?.[req.operation];
    if (!status) fail(req,'matrix-cell-absent');
    if (status === 'DENIED' || status === 'UNPROBED') fail(req,`matrix-${status.toLowerCase()}`);
    const verb = req.operation === 'get' || ['health','backendHealth','collections','sources'].includes(req.operation) ? 'GET' :
        ['patchText','patchMetadata'].includes(req.operation) ? 'PATCH' : 'POST';
    if (req.method !== verb) fail(req,'unexpected-method');
    if (req.operation === 'init') {
        const serialized = JSON.stringify(req.body || {});
        if (/"(?:apiKey|api_key|password|token|secret|authorization)"\s*:/i.test(serialized)) {
            const secretFields = Object.entries(req.body || {}).filter(([key,value])=>/^(?:apiKey|api_key|password|token|secret|authorization)$/i.test(key) && value != null && value !== '');
            if (secretFields.length) fail(req,'browser-credential-forwarding');
        }
    }
    // Milvus getItem ignores tenant filters and omits owner fields in its response.
    // Client-side validation therefore cannot prove ownership of a point.
    if (req.backend === 'milvus' && req.operation === 'get') fail(req, 'milvus-point-owner-unverifiable');
    if (shared(req.backend) && ['list','query','hybrid','get','stats'].includes(req.operation)) {
        const filters = req.operation === 'get'
            ? (()=>{try{return JSON.parse(req.parsed.searchParams.get('filters')||'null');}catch{return null;}})()
            : req.body?.filters;
        // Qdrant and Milvus share physical collections. A legacy Qdrant
        // `filter:{must:[{key:'content_type' ...}]}` is NEVER a tenant filter.
        if (!hasValidTenant(filters)) fail(req,'tenant-filters-required');
    }
    return {intercepted:true,allowed:true,...req,cellStatus:status};
}
/** Pass in an injected request function only when it is explicitly supplied. */
export function guardedVectorFetch(url, options, fetchImpl=globalThis.fetch) {
    inspectVectorRequest(url, options);
    if (typeof fetchImpl !== 'function') throw new Error('VectHare request transport unavailable');
    return fetchImpl(url, options);
}
export const e02Matrix = E02_MATRIX_STATUS;
