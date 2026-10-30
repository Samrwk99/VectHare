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
    // M0 diagnostics with synthetic mutations are not production gateway writes.
    if(req.transport==='plugin'&&/^\/v2\/diagnostics\/(?:qdrant-contract|qdrant-f05|lancedb-f06|vectra-f07|milvus-f08)$/.test(req.suffix)&&
       req.method==='POST')fail(req,'m0-disposable-diagnostic-write-requires-gateway');
    // M0: old pilot mutation endpoints are not the trusted new write gateway.
    if(req.transport==='plugin'&&(
       /^\/v2\/records\/(?:pilot-mutate|lancedb-pilot-mutate|vectra-pilot-mutate|milvus-pilot-mutate)$/.test(req.suffix)||
       /^\/v2\/workflows\/(?:chat-sync-pilot-apply|chat-orphan-pilot|chat-lifecycle-pilot|saved-content-pilot)$/.test(req.suffix)||
       req.suffix==='/v2/collections/provision'))fail(req,'m0-legacy-write-requires-gateway');
    // M0/D6: remote endpoints and credentials are administrator configured.
    if(req.transport==='plugin'&&/^\/v2\/connections\/(?:qdrant|milvus)$/.test(req.suffix)&&
       ['PUT','DELETE'].includes(req.method))fail(req,'m0-admin-server-config-only');
    // P03: authenticated owner-scoped embedding setup is narrowly allowed below.
    // It never grants permission to mutate saved vectors.
    if(req.transport==='plugin'&&req.suffix==='/v2/embeddings/staged-profile'&&req.method==='PUT'){
        const b=req.body;
        if(!b||typeof b!=='object'||Array.isArray(b)||
           Object.keys(b).some(k=>!['source','model','dimension','metric'].includes(k))||
           b.source!=='transformers'||typeof b.model!=='string'||
           !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/.test(b.model)||
           !Number.isSafeInteger(b.dimension)||b.dimension<1||b.dimension>65536||
           !['cosine','dot','euclid'].includes(b.metric)||req.parsed.search)
            fail(req,'m3-staged-identity-only');
        return {intercepted:true,allowed:true,transport:'plugin',backend:'none',
            operation:'m3StagedLocalEmbeddingIdentity',method:'PUT'};
    }
    // M2: exact saved-source batch jobs, never client-supplied text/vectors,
    // credential endpoints, owner IDs, physical names or generic mutations.
    if(req.transport==='plugin'&&req.suffix.startsWith('/v2/m2/jobs')){
        if(req.parsed.search)fail(req,'m2-query-forbidden');
        const prefix='/v2/m2/jobs';
        const item=req.suffix.slice(prefix.length);
        const operation=item.match(/^\/([0-9a-f-]{36})(?:\/(resume|pause|cancel|step|evidence|review))?$/i);
        if(operation){
            if(!UUID_RE.test(operation[1]))fail(req,'m2-job-id-invalid');
            const read=operation[2]===undefined||operation[2]==='evidence';
            if(read?(req.method!=='GET'||req.body!=null):
                (req.method!=='POST'||!req.body||typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(req.body).length))
                fail(req,'m2-job-method-or-body-forbidden');
            return {intercepted:true,allowed:true,transport:'plugin',backend:'qdrant',
                operation:read?'m2JobStatus':`m2${operation[2]}`,method:req.method};
        }
        if(!['/preview','/create'].includes(item)||req.method!=='POST'||!req.body||
            typeof req.body!=='object'||Array.isArray(req.body))fail(req,'m2-job-shape-forbidden');
        const body=item==='/create'?req.body.intent:req.body;
        if(item==='/create'&&(Object.keys(req.body).some(k=>!['intent','confirmation'].includes(k))||
           req.body.confirmation!=='CREATE BOUNDED SAVED-SOURCE JOB'))fail(req,'m2-job-confirmation-required');
        const source=body?.source;
        const fields=source?.kind==='chat'?['kind','avatar','chatFile']:
            source?.kind==='group-chat'?['kind','groupId','chatFile']:
            source?.kind==='lorebook'?['kind','name']:[];
        if(!body||typeof body!=='object'||Array.isArray(body)||
           Object.keys(body).some(k=>!['backend','source','configId','mode','selectedIds','maxItems','maxEmbeddings','ratePerMinute'].includes(k))||
           body.backend!=='qdrant'||!fields.length||!source||Array.isArray(source)||
           Object.keys(source).some(k=>!fields.includes(k))||
           fields.some(k=>typeof source[k]!=='string'||!source[k]||source[k].length>220)||
           !['vectorize-current','vectorize-selected','vectorize-lorebook','revectorize-changed'].includes(body.mode)||
           (body.configId!==undefined&&!['local','default'].includes(body.configId))||
           (body.maxItems!==undefined&&(!Number.isInteger(body.maxItems)||body.maxItems<1||body.maxItems>80))||
           (body.maxEmbeddings!==undefined&&(!Number.isInteger(body.maxEmbeddings)||body.maxEmbeddings<1||body.maxEmbeddings>80))||
           (body.ratePerMinute!==undefined&&(!Number.isInteger(body.ratePerMinute)||body.ratePerMinute<1||body.ratePerMinute>120))||
           (body.selectedIds!==undefined&&(!Array.isArray(body.selectedIds)||body.selectedIds.length>80||
            body.selectedIds.some(id=>!UUID_RE.test(id)))))fail(req,'m2-job-intent-untrusted');
        return {intercepted:true,allowed:true,transport:'plugin',backend:'qdrant',operation:'m2SavedJob'+item,method:'POST'};
    }
    // M4b: LanceDB source-bound preview and verified logical backup only.
    // No client-specified physical names, vectors, paths, owners, or restore
    // grants. Other LanceDB lifecycle routes remain denied by default.
    // M4c Milvus: server-attested source selection, verified backup and one-use deletion only.
    if(req.transport==='plugin'&&req.suffix.startsWith('/v2/m4c/milvus/')){
        if(req.parsed.search)fail(req,'m4c-query-forbidden');
        const verify=req.suffix.match(/^\/v2\/m4c\/milvus\/backups\/([a-f0-9-]{36})\/verify$/i);
        if(verify){
            if(!UUID_RE.test(verify[1])||req.method!=='GET'||req.body!==null)
                fail(req,'m4c-verify-id-or-method-invalid');
            return {intercepted:true,allowed:true,transport:'plugin',backend:'milvus',operation:'m4cVerifyBackup',method:'GET'};
        }
        if(req.suffix==='/v2/m4c/milvus/collections/transition/execute'){
            const b=req.body;
            if(req.method!=='POST'||!b||typeof b!=='object'||Array.isArray(b)||
               Object.keys(b).sort().join(',')!=='confirmation,operationId'||
               !UUID_RE.test(b.operationId)||
               !['EMPTY OWNED MILVUS COLLECTION','RESTORE OWNED MILVUS COLLECTION'].includes(b.confirmation))
                fail(req,'m4c-transition-execute-untrusted');
            return {intercepted:true,allowed:true,transport:'plugin',backend:'milvus',operation:'m4cExecuteTransition',method:'POST'};
        }
        if(req.suffix==='/v2/m4c/milvus/collections/transition/plan'){
            const b=req.body;
            const fields=b?.source?.kind==='chat'?['kind','avatar','chatFile']:
                b?.source?.kind==='group-chat'?['kind','groupId','chatFile']:
                b?.source?.kind==='lorebook'?['kind','name']:[];
            if(req.method!=='POST'||!b||typeof b!=='object'||Array.isArray(b)||
               Object.keys(b).some(k=>!['backend','source','configId','backupId','action'].includes(k))||
               b.backend!=='milvus'||(b.configId!==undefined&&b.configId!=='default')||
               !['empty','restore'].includes(b.action)||!UUID_RE.test(b.backupId)||
               !fields.length||!b.source||typeof b.source!=='object'||Array.isArray(b.source)||
               Object.keys(b.source).some(k=>!fields.includes(k))||
               fields.some(k=>typeof b.source[k]!=='string'||!b.source[k]||b.source[k].length>220))
                fail(req,'m4c-transition-plan-untrusted');
            return {intercepted:true,allowed:true,transport:'plugin',backend:'milvus',operation:'m4cPlanTransition',method:'POST'};
        }
        if(req.suffix==='/v2/m4c/milvus/collections/delete/execute'){
            const b=req.body;
            if(req.method!=='POST'||!b||typeof b!=='object'||Array.isArray(b)||
               Object.keys(b).sort().join(',')!=='confirmation,operationId'||
               !UUID_RE.test(b.operationId)||b.confirmation!=='DELETE OWNED MILVUS COLLECTION')
                fail(req,'m4c-delete-execute-untrusted');
            return {intercepted:true,allowed:true,transport:'plugin',backend:'milvus',operation:'m4cExecuteDelete',method:'POST'};
        }
        if(req.suffix==='/v2/m4c/milvus/collections/delete/plan'){
            const b=req.body;
            const fields=b?.source?.kind==='chat'?['kind','avatar','chatFile']:
                b?.source?.kind==='group-chat'?['kind','groupId','chatFile']:
                b?.source?.kind==='lorebook'?['kind','name']:[];
            if(req.method!=='POST'||!b||typeof b!=='object'||Array.isArray(b)||
                Object.keys(b).some(k=>!['backend','source','configId','backupId'].includes(k))||
                b.backend!=='milvus'||(b.configId!==undefined&&b.configId!=='default')||
                !UUID_RE.test(b.backupId)||!fields.length||!b.source||
                typeof b.source!=='object'||Array.isArray(b.source)||
                Object.keys(b.source).some(k=>!fields.includes(k))||
                fields.some(k=>typeof b.source[k]!=='string'||!b.source[k]||b.source[k].length>220))
                fail(req,'m4c-delete-plan-untrusted');
            return {intercepted:true,allowed:true,transport:'plugin',backend:'milvus',operation:'m4cPlanDelete',method:'POST'};
        }
        if(!['/v2/m4c/milvus/collections/preview','/v2/m4c/milvus/backups/create'].includes(req.suffix)||
            req.method!=='POST')fail(req,'m4c-route-forbidden');
        const b=req.body;
        const fields=b?.source?.kind==='chat'?['kind','avatar','chatFile']:
            b?.source?.kind==='group-chat'?['kind','groupId','chatFile']:
            b?.source?.kind==='lorebook'?['kind','name']:[];
        const creating=req.suffix.endsWith('/create');
        if(!b||typeof b!=='object'||Array.isArray(b)||
            Object.keys(b).some(k=>!['backend','source','configId',...(creating?['confirmation']:[])].includes(k))||
            b.backend!=='milvus'||(b.configId!==undefined&&b.configId!=='default')||
            !fields.length||!b.source||typeof b.source!=='object'||Array.isArray(b.source)||
            Object.keys(b.source).some(k=>!fields.includes(k))||
            fields.some(k=>typeof b.source[k]!=='string'||!b.source[k]||b.source[k].length>220)||
            (creating&&b.confirmation!=='CAPTURE OWNED LOGICAL BACKUP'))fail(req,'m4c-saved-selector-only');
        return {intercepted:true,allowed:true,transport:'plugin',backend:'milvus',
            operation:creating?'m4cCaptureBackup':'m4cPreview',method:'POST'};
    }
    if(req.transport==='plugin'&&req.suffix.startsWith('/v2/m4b/vectra/')){
        if(req.parsed.search)fail(req,'m4b-query-forbidden');
        const verify=req.suffix.match(/^\/v2\/m4b\/vectra\/backups\/([a-f0-9-]{36})\/verify$/i);
        if(verify){
            if(!UUID_RE.test(verify[1])||req.method!=='GET'||req.body!==null)
                fail(req,'m4b-verify-id-or-method-invalid');
            return {intercepted:true,allowed:true,transport:'plugin',backend:'vectra',operation:'m4bVerifyBackup',method:'GET'};
        }
        if(req.suffix==='/v2/m4b/vectra/collections/transition/execute'){
            const b=req.body;
            if(req.method!=='POST'||!b||typeof b!=='object'||Array.isArray(b)||
               Object.keys(b).sort().join(',')!=='confirmation,operationId'||
               !UUID_RE.test(b.operationId)||
               !['EMPTY OWNED VECTRA COLLECTION','RESTORE OWNED VECTRA COLLECTION'].includes(b.confirmation))
                fail(req,'m4b-transition-execute-untrusted');
            return {intercepted:true,allowed:true,transport:'plugin',backend:'vectra',operation:'m4bExecuteTransition',method:'POST'};
        }
        if(req.suffix==='/v2/m4b/vectra/collections/transition/plan'){
            const b=req.body;
            const fields=b?.source?.kind==='chat'?['kind','avatar','chatFile']:
                b?.source?.kind==='group-chat'?['kind','groupId','chatFile']:
                b?.source?.kind==='lorebook'?['kind','name']:[];
            if(req.method!=='POST'||!b||typeof b!=='object'||Array.isArray(b)||
               Object.keys(b).some(k=>!['backend','source','configId','backupId','action'].includes(k))||
               b.backend!=='vectra'||(b.configId!==undefined&&b.configId!=='default')||
               !['empty','restore'].includes(b.action)||!UUID_RE.test(b.backupId)||
               !fields.length||!b.source||typeof b.source!=='object'||Array.isArray(b.source)||
               Object.keys(b.source).some(k=>!fields.includes(k))||
               fields.some(k=>typeof b.source[k]!=='string'||!b.source[k]||b.source[k].length>220))
                fail(req,'m4b-transition-plan-untrusted');
            return {intercepted:true,allowed:true,transport:'plugin',backend:'vectra',operation:'m4bPlanTransition',method:'POST'};
        }
        if(req.suffix==='/v2/m4b/vectra/collections/delete/execute'){
            const b=req.body;
            if(req.method!=='POST'||!b||typeof b!=='object'||Array.isArray(b)||
               Object.keys(b).sort().join(',')!=='confirmation,operationId'||
               !UUID_RE.test(b.operationId)||b.confirmation!=='DELETE OWNED VECTRA COLLECTION')
                fail(req,'m4b-delete-execute-untrusted');
            return {intercepted:true,allowed:true,transport:'plugin',backend:'vectra',operation:'m4bExecuteDelete',method:'POST'};
        }
        if(req.suffix==='/v2/m4b/vectra/collections/delete/plan'){
            const b=req.body;
            const fields=b?.source?.kind==='chat'?['kind','avatar','chatFile']:
                b?.source?.kind==='group-chat'?['kind','groupId','chatFile']:
                b?.source?.kind==='lorebook'?['kind','name']:[];
            if(req.method!=='POST'||!b||typeof b!=='object'||Array.isArray(b)||
                Object.keys(b).some(k=>!['backend','source','configId','backupId'].includes(k))||
                b.backend!=='vectra'||(b.configId!==undefined&&b.configId!=='default')||
                !UUID_RE.test(b.backupId)||!fields.length||!b.source||
                typeof b.source!=='object'||Array.isArray(b.source)||
                Object.keys(b.source).some(k=>!fields.includes(k))||
                fields.some(k=>typeof b.source[k]!=='string'||!b.source[k]||b.source[k].length>220))
                fail(req,'m4b-delete-plan-untrusted');
            return {intercepted:true,allowed:true,transport:'plugin',backend:'vectra',operation:'m4bPlanDelete',method:'POST'};
        }
        if(!['/v2/m4b/vectra/collections/preview','/v2/m4b/vectra/backups/create'].includes(req.suffix)||
            req.method!=='POST')fail(req,'m4b-route-forbidden');
        const b=req.body;
        const fields=b?.source?.kind==='chat'?['kind','avatar','chatFile']:
            b?.source?.kind==='group-chat'?['kind','groupId','chatFile']:
            b?.source?.kind==='lorebook'?['kind','name']:[];
        const creating=req.suffix.endsWith('/create');
        if(!b||typeof b!=='object'||Array.isArray(b)||
            Object.keys(b).some(k=>!['backend','source','configId',...(creating?['confirmation']:[])].includes(k))||
            b.backend!=='vectra'||(b.configId!==undefined&&b.configId!=='default')||
            !fields.length||!b.source||typeof b.source!=='object'||Array.isArray(b.source)||
            Object.keys(b.source).some(k=>!fields.includes(k))||
            fields.some(k=>typeof b.source[k]!=='string'||!b.source[k]||b.source[k].length>220)||
            (creating&&b.confirmation!=='CAPTURE OWNED LOGICAL BACKUP'))fail(req,'m4b-saved-selector-only');
        return {intercepted:true,allowed:true,transport:'plugin',backend:'vectra',
            operation:creating?'m4bCaptureBackup':'m4bPreview',method:'POST'};
    }
    // M4a: LanceDB source-bound preview and verified logical backup only.
    // No client-specified physical names, vectors, paths, owners, or restore
    // grants. Other LanceDB lifecycle routes remain denied by default.
    if(req.transport==='plugin'&&req.suffix.startsWith('/v2/m4a/lancedb/')){
        if(req.parsed.search)fail(req,'m4a-query-forbidden');
        const verify=req.suffix.match(/^\/v2\/m4a\/lancedb\/backups\/([a-f0-9-]{36})\/verify$/i);
        if(verify){
            if(!UUID_RE.test(verify[1])||req.method!=='GET'||req.body!==null)
                fail(req,'m4a-verify-id-or-method-invalid');
            return {intercepted:true,allowed:true,transport:'plugin',backend:'lancedb',operation:'m4aVerifyBackup',method:'GET'};
        }
        if(req.suffix==='/v2/m4a/lancedb/collections/transition/execute'){
            const b=req.body;
            if(req.method!=='POST'||!b||typeof b!=='object'||Array.isArray(b)||
               Object.keys(b).sort().join(',')!=='confirmation,operationId'||
               !UUID_RE.test(b.operationId)||
               !['EMPTY OWNED LANCEDB COLLECTION','RESTORE OWNED LANCEDB COLLECTION'].includes(b.confirmation))
                fail(req,'m4a-transition-execute-untrusted');
            return {intercepted:true,allowed:true,transport:'plugin',backend:'lancedb',operation:'m4aExecuteTransition',method:'POST'};
        }
        if(req.suffix==='/v2/m4a/lancedb/collections/transition/plan'){
            const b=req.body;
            const fields=b?.source?.kind==='chat'?['kind','avatar','chatFile']:
                b?.source?.kind==='group-chat'?['kind','groupId','chatFile']:
                b?.source?.kind==='lorebook'?['kind','name']:[];
            if(req.method!=='POST'||!b||typeof b!=='object'||Array.isArray(b)||
               Object.keys(b).some(k=>!['backend','source','configId','backupId','action'].includes(k))||
               b.backend!=='lancedb'||(b.configId!==undefined&&b.configId!=='default')||
               !['empty','restore'].includes(b.action)||!UUID_RE.test(b.backupId)||
               !fields.length||!b.source||typeof b.source!=='object'||Array.isArray(b.source)||
               Object.keys(b.source).some(k=>!fields.includes(k))||
               fields.some(k=>typeof b.source[k]!=='string'||!b.source[k]||b.source[k].length>220))
                fail(req,'m4a-transition-plan-untrusted');
            return {intercepted:true,allowed:true,transport:'plugin',backend:'lancedb',operation:'m4aPlanTransition',method:'POST'};
        }
        if(req.suffix==='/v2/m4a/lancedb/collections/delete/execute'){
            const b=req.body;
            if(req.method!=='POST'||!b||typeof b!=='object'||Array.isArray(b)||
               Object.keys(b).sort().join(',')!=='confirmation,operationId'||
               !UUID_RE.test(b.operationId)||b.confirmation!=='DELETE OWNED LANCEDB COLLECTION')
                fail(req,'m4a-delete-execute-untrusted');
            return {intercepted:true,allowed:true,transport:'plugin',backend:'lancedb',operation:'m4aExecuteDelete',method:'POST'};
        }
        if(req.suffix==='/v2/m4a/lancedb/collections/delete/plan'){
            const b=req.body;
            const fields=b?.source?.kind==='chat'?['kind','avatar','chatFile']:
                b?.source?.kind==='group-chat'?['kind','groupId','chatFile']:
                b?.source?.kind==='lorebook'?['kind','name']:[];
            if(req.method!=='POST'||!b||typeof b!=='object'||Array.isArray(b)||
                Object.keys(b).some(k=>!['backend','source','configId','backupId'].includes(k))||
                b.backend!=='lancedb'||(b.configId!==undefined&&b.configId!=='default')||
                !UUID_RE.test(b.backupId)||!fields.length||!b.source||
                typeof b.source!=='object'||Array.isArray(b.source)||
                Object.keys(b.source).some(k=>!fields.includes(k))||
                fields.some(k=>typeof b.source[k]!=='string'||!b.source[k]||b.source[k].length>220))
                fail(req,'m4a-delete-plan-untrusted');
            return {intercepted:true,allowed:true,transport:'plugin',backend:'lancedb',operation:'m4aPlanDelete',method:'POST'};
        }
        if(!['/v2/m4a/lancedb/collections/preview','/v2/m4a/lancedb/backups/create'].includes(req.suffix)||
            req.method!=='POST')fail(req,'m4a-route-forbidden');
        const b=req.body;
        const fields=b?.source?.kind==='chat'?['kind','avatar','chatFile']:
            b?.source?.kind==='group-chat'?['kind','groupId','chatFile']:
            b?.source?.kind==='lorebook'?['kind','name']:[];
        const creating=req.suffix.endsWith('/create');
        if(!b||typeof b!=='object'||Array.isArray(b)||
            Object.keys(b).some(k=>!['backend','source','configId',...(creating?['confirmation']:[])].includes(k))||
            b.backend!=='lancedb'||(b.configId!==undefined&&b.configId!=='default')||
            !fields.length||!b.source||typeof b.source!=='object'||Array.isArray(b.source)||
            Object.keys(b.source).some(k=>!fields.includes(k))||
            fields.some(k=>typeof b.source[k]!=='string'||!b.source[k]||b.source[k].length>220)||
            (creating&&b.confirmation!=='CAPTURE OWNED LOGICAL BACKUP'))fail(req,'m4a-saved-selector-only');
        return {intercepted:true,allowed:true,transport:'plugin',backend:'lancedb',
            operation:creating?'m4aCaptureBackup':'m4aPreview',method:'POST'};
    }
    // M3: immutable, source-attested collection lifecycle. Backups are scoped
    // physical reads; destructive execution is intentionally server-blocked.
    if(req.transport==='plugin'&&req.suffix.startsWith('/v2/m3/')){
        if(req.parsed.search)fail(req,'m3-query-forbidden');
        const b=req.body,backup=req.suffix.match(/^\/v2\/m3\/backups\/([a-f0-9-]{36})\/verify$/i);
        const evidence=req.suffix.match(/^\/v2\/m3\/operations\/([a-f0-9-]{36})\/evidence$/i);
        if(evidence){
            if(!UUID_RE.test(evidence[1])||req.method!=='GET'||b!==null)fail(req,'m3-operation-evidence-readonly');
            return {intercepted:true,allowed:true,transport:'plugin',operation:'m3OperationEvidence',backend:'qdrant',method:'GET'};
        }
        const generalReview=req.suffix.match(/^\/v2\/m3\/operations\/([a-f0-9-]{36})\/reconciliation$/i);
        if(generalReview){
            if(!UUID_RE.test(generalReview[1])||req.method!=='GET'||b!==null)
                fail(req,'m3-general-reconciliation-readonly');
            return {intercepted:true,allowed:true,transport:'plugin',operation:'m3GeneralReconciliation',backend:'qdrant',method:'GET'};
        }
        const stageResume=req.suffix.match(/^\/v2\/m3\/collections\/rebuild\/continue\/([a-f0-9-]{36})$/i);
        if(stageResume){
            if(!UUID_RE.test(stageResume[1])||req.method!=='POST'||!b||typeof b!=='object'||
                Array.isArray(b)||Object.keys(b).length!==0)fail(req,'m3-stage-continuation-untrusted');
            return {intercepted:true,allowed:true,transport:'plugin',backend:'qdrant',
                operation:'m3StageContinuation',method:'POST'};
        }
        const stageContinuation=req.suffix.match(/^\/v2\/m3\/collections\/rebuild\/continuation-proof\/([a-f0-9-]{36})$/i);
        if(stageContinuation){
            if(!UUID_RE.test(stageContinuation[1])||req.method!=='GET'||b!==null)
                fail(req,'m3-continuation-proof-readonly');
            return {intercepted:true,allowed:true,transport:'plugin',backend:'qdrant',operation:'m3ContinuationProof',method:'GET'};
        }
        const abandonment=req.suffix.match(/^\/v2\/m3\/operations\/([a-f0-9-]{36})\/(abandon|abandonment)$/i);
        if(abandonment){
            if(!UUID_RE.test(abandonment[1])||
             (abandonment[2]==='abandonment'?(req.method!=='GET'||b!==null):
              (req.method!=='POST'||!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).length!==0)))
                fail(req,'m3-abandonment-exact-id-only');
            return {intercepted:true,allowed:true,transport:'plugin',backend:'qdrant',method:req.method,
                operation:abandonment[2]==='abandonment'?'m3AbandonmentInspection':'m3AbandonUncertain'};
        }
        const proven=req.suffix.match(/^\/v2\/m3\/operations\/([a-f0-9-]{36})\/(adjudication-proof|quarantine-proven)$/i);
        if(proven){
            if(!UUID_RE.test(proven[1])||
              (proven[2]==='adjudication-proof'?(req.method!=='GET'||b!==null):
               (req.method!=='POST'||!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).length!==0)))
                fail(req,'m3-proven-adjudication-untrusted');
            return {intercepted:true,allowed:true,transport:'plugin',backend:'qdrant',method:req.method,
                operation:proven[2]==='adjudication-proof'?'m3ProvenAdjudicationProof':'m3QuarantineProven'};
        }
        const terminal=req.suffix.match(/^\/v2\/m3\/operations\/([a-f0-9-]{36})\/(terminal-proof|quarantine-terminal)$/i);
        if(terminal){
            if(!UUID_RE.test(terminal[1])||
                (terminal[2]==='terminal-proof'?(req.method!=='GET'||b!==null):
                  (req.method!=='POST'||!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).length!==0)))
                fail(req,'m3-admin-terminal-shape-forbidden');
            return {intercepted:true,allowed:true,transport:'plugin',backend:'qdrant',
                operation:terminal[2]==='terminal-proof'?'m3TerminalProof':'m3TerminalQuarantine',method:req.method};
        }
        if(backup){
            if(!UUID_RE.test(backup[1])||req.method!=='GET'||b!==null)fail(req,'m3-backup-verify-readonly');
            return {intercepted:true,allowed:true,transport:'plugin',operation:'m3BackupVerify',backend:'qdrant',method:'GET'};
        }
        const stageStatus=req.suffix.match(/^\/v2\/m3\/collections\/rebuild\/stages\/([a-f0-9-]{36})$/i);
        if(stageStatus){
            if(!UUID_RE.test(stageStatus[1])||req.method!=='GET'||b!==null)
                fail(req,'m3-rebuild-stage-inspection-readonly');
            return {intercepted:true,allowed:true,transport:'plugin',operation:'m3RebuildStageInspection',backend:'qdrant',method:'GET'};
        }
        const physicalProgress=req.suffix.match(/^\/v2\/m3\/collections\/rebuild\/physical-progress\/([a-f0-9-]{36})$/i);
        if(physicalProgress){
            if(!UUID_RE.test(physicalProgress[1])||req.method!=='GET'||b!==null)
                fail(req,'m3-physical-progress-readonly');
            return {intercepted:true,allowed:true,transport:'plugin',operation:'m3PhysicalProgress',backend:'qdrant',method:'GET'};
        }
        const preparation=req.suffix.match(/^\/v2\/m3\/collections\/rebuild\/preparation\/([a-f0-9-]{36})(?:\/(step))?$/i);
        if(preparation){
            if(!UUID_RE.test(preparation[1])||req.parsed.search||
               (preparation[2]?(req.method!=='POST'||!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).length!==0):
                (req.method!=='GET'||b!==null)))fail(req,'m3-preparation-exact-operation-only');
            return {intercepted:true,allowed:true,transport:'plugin',operation:preparation[2]?'m3RebuildPreparationStep':'m3RebuildPreparationProgress',backend:'qdrant',method:req.method};
        }
        if(req.suffix==='/v2/m3/collections/readiness'){
            if(req.method!=='GET'||b!==null)fail(req,'m3-readiness-readonly');
            return {intercepted:true,allowed:true,transport:'plugin',operation:'m3Readiness',backend:'qdrant',method:'GET'};
        }
        if(req.method!=='POST'||!b||typeof b!=='object'||Array.isArray(b))fail(req,'m3-request-invalid');
        if(req.suffix==='/v2/m3/collections/rollback/plan'){
            if(Object.keys(b).length!==1||!UUID_RE.test(b.restoreOperationId||''))fail(req,'m3-rollback-untrusted');
            return {intercepted:true,allowed:true,transport:'plugin',operation:'m3RollbackPlan',backend:'qdrant',method:'POST'};
        }
        if(req.suffix==='/v2/m3/collections/execute'){
            if(Object.keys(b).some(k=>!['operationId','confirmation'].includes(k))||!UUID_RE.test(b.operationId||'')||
                !['RESTORE TO FRESH COLLECTION','DELETE OWNED COLLECTION','ROLL BACK UNCHANGED COLLECTION','EMPTY OWNED COLLECTION'].includes(b.confirmation))
                fail(req,'m3-exact-confirmation-required');
            return {intercepted:true,allowed:true,transport:'plugin',operation:'m3LifecycleExecute',backend:'qdrant',method:'POST'};
        }
        if(req.suffix==='/v2/m3/collections/rebuild/activation-execute'){
            if(Object.keys(b).some(k=>!['operationId','confirmation'].includes(k))||
                !UUID_RE.test(b.operationId||'')||b.confirmation!=='ACTIVATE VERIFIED MODEL FOR THIS SOURCE')
                fail(req,'m3-activation-confirmation-required');
            return {intercepted:true,allowed:true,transport:'plugin',operation:'m3RebuildActivation',backend:'qdrant',method:'POST'};
        }
        if(req.suffix==='/v2/m3/collections/rebuild/activation-plan'){
            if(Object.keys(b).length!==1||!UUID_RE.test(b.stageOperationId||''))
                fail(req,'m3-activation-stage-id-required');
            return {intercepted:true,allowed:true,transport:'plugin',operation:'m3RebuildActivationPlan',backend:'qdrant',method:'POST'};
        }
        if(req.suffix==='/v2/m3/collections/rebuild/source-profile'){
            const source=b.source;
            const fields=source?.kind==='chat'?['kind','avatar','chatFile']:
                source?.kind==='group-chat'?['kind','groupId','chatFile']:
                source?.kind==='lorebook'?['kind','name']:[];
            if(Object.keys(b).length!==1||!fields.length||!source||typeof source!=='object'||Array.isArray(source)||
                Object.keys(source).some(k=>!fields.includes(k))||
                fields.some(k=>typeof source[k]!=='string'||!source[k]||source[k].length>220))
                fail(req,'m3-source-profile-selector-invalid');
            return {intercepted:true,allowed:true,transport:'plugin',operation:'m3SelectedSourceProfile',backend:'qdrant',method:'POST'};
        }
        if(req.suffix==='/v2/m3/collections/rebuild/stage-execute'){
            if(Object.keys(b).some(k=>!['operationId','confirmation'].includes(k))||
                !UUID_RE.test(b.operationId||'')||b.confirmation!=='STAGE NEW MODEL WITHOUT ACTIVATION')
                fail(req,'m3-rebuild-stage-confirmation-required');
            return {intercepted:true,allowed:true,transport:'plugin',operation:'m3RebuildStage',backend:'qdrant',method:'POST'};
        }
        const commands={'/v2/m3/collections/preview':['backend','source','configId'],
            '/v2/m3/collections/managed-inventory':['backend','source','configId'],
            '/v2/m3/backups/create':['backend','source','configId','confirmation'],
            '/v2/m3/collections/plan':['backend','source','configId','action','backupId'],
            '/v2/m3/collections/rebuild/preview':['backend','source','configId','backupId'],
            '/v2/m3/collections/rebuild/stage-plan':['backend','source','configId','backupId']};
        const allowed=commands[req.suffix],source=b.source;
        const fields=source?.kind==='chat'?['kind','avatar','chatFile']:
            source?.kind==='group-chat'?['kind','groupId','chatFile']:
            source?.kind==='lorebook'?['kind','name']:[];
        if(!allowed||Object.keys(b).some(k=>!allowed.includes(k))||b.backend!=='qdrant'||
            (b.configId!==undefined&&!['default','local'].includes(b.configId))||
            !fields.length||!source||typeof source!=='object'||Array.isArray(source)||
            Object.keys(source).some(k=>!fields.includes(k))||
            fields.some(k=>typeof source[k]!=='string'||!source[k]||source[k].length>220))
            fail(req,'m3-saved-source-only');
        if(req.suffix.endsWith('/create')&&b.confirmation!=='CAPTURE OWNED LOGICAL BACKUP')fail(req,'m3-backup-confirmation-required');
        if(req.suffix.endsWith('/plan')&&(!['restore','delete','empty','rebuild'].includes(b.action)||!UUID_RE.test(b.backupId||'')))fail(req,'m3-plan-invalid');
        if((req.suffix.endsWith('/rebuild/preview')||req.suffix.endsWith('/rebuild/stage-plan'))&&!UUID_RE.test(b.backupId||''))fail(req,'m3-rebuild-preview-invalid');
        return {intercepted:true,allowed:true,transport:'plugin',operation:'m3'+req.suffix.split('/').slice(-2).join('-'),backend:'qdrant',method:'POST'};
    }
    // M0: read-only capability contract and source-attested plan (never execution).
    if(req.transport==='plugin'&&req.suffix==='/v2/m0/capabilities'){
        if(req.method!=='GET'||req.body!=null||req.parsed.search)fail(req,'m0-capability-inspection-only');
        return {intercepted:true,allowed:true,transport:'plugin',operation:'m0Capabilities',backend:'none',method:'GET'};
    }
    // P-B.6: owner-attested READ of scene annotations from an actual saved
    // chat file. No browser-submitted scene/title edits or vector writes.
    if(req.transport==='plugin'&&req.suffix==='/v2/pb6/scenes/read'){
        const body=req.body,source=body?.source;
        const fields=source?.kind==='chat'?['kind','avatar','chatFile']:
            source?.kind==='group-chat'?['kind','groupId','chatFile']:[];
        if(req.method!=='POST'||req.parsed.search||!body||typeof body!=='object'||Array.isArray(body)||
           Object.keys(body).length!==1||!fields.length||!source||typeof source!=='object'||Array.isArray(source)||
           Object.keys(source).some(k=>!fields.includes(k))||
           fields.some(k=>typeof source[k]!=='string'||!source[k]||source[k].length>220))
            fail(req,'pb6-saved-scene-read-selector-invalid');
        return {intercepted:true,allowed:true,transport:'plugin',operation:'pb6SavedSceneRead',backend:'none',method:'POST'};
    }
    // PB10: strictly read-only, source-bound whole-physical browsing. No IDs,
    // physical targets, offsets, vectors or client-supplied proof fields.
    if(req.transport==='plugin'&&req.suffix==='/v2/pb10/physical/browse'){
        const b=req.body,source=b?.source;
        const fields=source?.kind==='chat'?['kind','avatar','chatFile']:
            source?.kind==='group-chat'?['kind','groupId','chatFile']:
            source?.kind==='lorebook'?['kind','name']:[];
        if(req.method!=='POST'||req.parsed.search||!b||typeof b!=='object'||Array.isArray(b)||
           Object.keys(b).some(k=>!['backend','source','configId','cursor'].includes(k))||
           !['qdrant','lancedb','vectra','milvus'].includes(b.backend)||
           !['default',undefined,...(b.backend==='qdrant'?['local']:[])].includes(b.configId)||
           !fields.length||!source||typeof source!=='object'||Array.isArray(source)||
           Object.keys(source).length!==fields.length||
           Object.keys(source).some(k=>!fields.includes(k))||
           fields.some(k=>typeof source[k]!=='string'||!source[k]||source[k].length>220)||
           (b.cursor!==undefined&&(typeof b.cursor!=='string'||b.cursor.length>2048||
             !/^[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+$/.test(b.cursor))))
            fail(req,'pb10-physical-saved-source-only');
        return {intercepted:true,allowed:true,transport:'plugin',backend:b.backend,
            operation:'pb10ReadOnlyPhysicalBrowse',method:'POST'};
    }
    // P-B.14: Qdrant native page-only physical read. Scope-checked records,
    // NOT a collection-wide completeness/ownership proof. Never a mutation path.
    if(req.transport==='plugin'&&req.suffix==='/v2/pb14/qdrant/physical-page'){
        const b=req.body,source=b?.source;
        const fields=source?.kind==='chat'?['kind','avatar','chatFile']:
            source?.kind==='group-chat'?['kind','groupId','chatFile']:
            source?.kind==='lorebook'?['kind','name']:[];
        if(req.method!=='POST'||req.parsed.search||!b||typeof b!=='object'||Array.isArray(b)||
           Object.keys(b).some(k=>!['backend','source','configId','cursor'].includes(k))||
           b.backend!=='qdrant'||!['default','local',undefined].includes(b.configId)||
           !fields.length||!source||typeof source!=='object'||Array.isArray(source)||
           Object.keys(source).length!==fields.length||
           Object.keys(source).some(k=>!fields.includes(k))||
           fields.some(k=>typeof source[k]!=='string'||!source[k]||source[k].length>220)||
           (b.cursor!==undefined&&(typeof b.cursor!=='string'||b.cursor.length>2048||
             !/^[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+$/.test(b.cursor))))
            fail(req,'pb14-native-qdrant-page-selector-invalid');
        return {intercepted:true,allowed:true,transport:'plugin',backend:'qdrant',
            operation:'pb14ReadOnlyNativeQdrantPage',method:'POST'};
    }
    // P-B.12: server-owned, UUID-based managed group metadata. The only
    // mutation here is revision-checked group metadata, NEVER vector writes.
    if(req.transport==='plugin'&&['/v2/pb12/groups/read','/v2/pb12/groups/update'].includes(req.suffix)){
        const b=req.body,source=b?.source,isWrite=req.suffix.endsWith('/update');
        const fields=source?.kind==='chat'?['kind','avatar','chatFile']:
            source?.kind==='group-chat'?['kind','groupId','chatFile']:
            source?.kind==='lorebook'?['kind','name']:[];
        if(req.method!=='POST'||req.parsed.search||!b||typeof b!=='object'||Array.isArray(b)||
            !['qdrant','lancedb','vectra','milvus'].includes(b.backend)||
            !['default',undefined,...(b.backend==='qdrant'?['local']:[])].includes(b.configId)||
            !fields.length||!source||typeof source!=='object'||Array.isArray(source)||
            Object.keys(source).length!==fields.length||
            Object.keys(source).some(k=>!fields.includes(k))||
            fields.some(k=>typeof source[k]!=='string'||!source[k]||source[k].length>220)||
            Object.keys(b).some(k=>!['backend','source','configId',...(isWrite?['action','operationId','expectedRevision','expectedProof','expectedStoredGeneration','groups']:[])].includes(k))||
            (isWrite&&(!['save','prune-orphans','review-generation'].includes(b.action)||
                typeof b.operationId!=='string'||!/^[0-9a-f-]{36}$/i.test(b.operationId)||
                !Number.isSafeInteger(b.expectedRevision)||b.expectedRevision<0||
                typeof b.expectedProof!=='string'||!/^[0-9a-f]{64}$/.test(b.expectedProof)||
                (b.action==='save'&&!Array.isArray(b.groups))||
                (b.action!=='save'&&b.groups!==undefined)||
                (b.action==='review-generation'&&(!Number.isSafeInteger(b.expectedStoredGeneration)||b.expectedStoredGeneration<0))||
                (b.action!=='review-generation'&&b.expectedStoredGeneration!==undefined))))
            fail(req,'pb12-managed-group-intent-invalid');
        return {intercepted:true,allowed:true,transport:'plugin',backend:b.backend,
            operation:isWrite?'pb12ManagedGroupMetadataUpdate':'pb12ManagedGroupsRead',method:'POST'};
    }
    // M1: narrowly scoped saved-record operations, never generic or pilot writes.
    if(req.transport==='plugin' && ['/v2/m1/capabilities','/v2/m1/preflight','/v2/m1/records/preview','/v2/m1/records/browse','/v2/m1/collections/prepare','/v2/m1/collections/provision','/v2/mutations/execute'].includes(req.suffix)){
        if(req.parsed.search)fail(req,'m1-no-query');
        if(req.suffix==='/v2/m1/capabilities'){
            if(req.method!=='GET'||req.body!=null)fail(req,'m1-capabilities-readonly');
            return {intercepted:true,allowed:true,transport:'plugin',operation:'m1Capabilities',backend:'qdrant',method:'GET'};
        }
        if(req.method!=='POST'||!req.body||typeof req.body!=='object'||Array.isArray(req.body))
            fail(req,'m1-method-and-body-required');
        if(req.suffix==='/v2/m1/collections/provision'){
            if(Object.keys(req.body).some(k=>!['operationId','confirmation'].includes(k))||
               !UUID_RE.test(req.body.operationId||'')||req.body.confirmation!=='CREATE OWNED V2 COLLECTION')
                fail(req,'m1-provision-confirmed-ticket-required');
            return {intercepted:true,allowed:true,transport:'plugin',operation:'m1OwnedProvision',backend:'qdrant',method:'POST'};
        }
        if(req.suffix==='/v2/mutations/execute'){
            if(Object.keys(req.body).some(k=>!['operationId','confirmation'].includes(k))||
               !UUID_RE.test(req.body.operationId||'')||req.body.confirmation!=='APPLY SAVED RECORD MUTATION')
                fail(req,'m1-confirmed-ticket-required');
            return {intercepted:true,allowed:true,transport:'plugin',operation:'m1ExactApply',backend:'qdrant',method:'POST'};
        }
        const body=req.body,source=body.source;
        const fields=source?.kind==='chat'?['kind','avatar','chatFile']:
            source?.kind==='group-chat'?['kind','groupId','chatFile']:
            source?.kind==='lorebook'?['kind','name']:[];
        if(!['qdrant','lancedb','vectra','milvus'].includes(body.backend)||!fields.length||!source||typeof source!=='object'||Array.isArray(source)||
           Object.keys(source).some(k=>!fields.includes(k))||
           fields.some(k=>typeof source[k]!=='string'||!source[k]||source[k].length>220)||
           (body.configId!==undefined&&!['local','default'].includes(body.configId))||
           (['lancedb','vectra','milvus'].includes(body.backend)&&body.configId==='local')||
           (body.verifyPhysical!==undefined&&(!['/v2/m1/records/preview','/v2/m1/records/browse'].includes(req.suffix)||body.verifyPhysical!==true))||
           (body.cursor!==undefined&&(!['/v2/m1/records/preview','/v2/m1/records/browse'].includes(req.suffix)||typeof body.cursor!=='string'||body.cursor.length>2048||!/^[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+$/.test(body.cursor)))||
           Object.keys(body).some(k=>!['backend','source','configId',...(['/v2/m1/records/preview','/v2/m1/records/browse'].includes(req.suffix)?['cursor','verifyPhysical']:[])].includes(k)))
            fail(req,'m1-saved-source-selector-required');
        if(req.suffix==='/v2/m1/records/browse'&&body.verifyPhysical!==true)fail(req,'pb1-browser-physical-verification-required');
        return {intercepted:true,allowed:true,transport:'plugin',operation:req.suffix.endsWith('/prepare')?'m1ProvisionPlan':req.suffix.endsWith('/preflight')?'m1SavedProfilePreflight':'m1SavedPreview',backend:body.backend,method:'POST'};
    }
    if(req.transport==='plugin'&&/^\/v2\/collections\/[a-f0-9]{64}\/records\/plan$/.test(req.suffix)){
        const b=req.body,source=b?.source;
        const fields=source?.kind==='chat'?['kind','avatar','chatFile']:
            source?.kind==='group-chat'?['kind','groupId','chatFile']:
            source?.kind==='lorebook'?['kind','name']:[];
        if(req.method!=='POST'||req.parsed.search||!b||!['qdrant','milvus','lancedb','vectra'].includes(b.backend)||
           !['insert','update','revectorize','delete','restore','repair-missing','repair-registry'].includes(b.action)||
           !fields.length||!source||typeof source!=='object'||Array.isArray(source)||
           Object.keys(source).some(k=>!fields.includes(k))||
           fields.some(k=>typeof source[k]!=='string'||!source[k]||source[k].length>220)||
           (b.configId!==undefined&&!['default','local'].includes(b.configId))||
           (['lancedb','vectra','milvus'].includes(b.backend)&&b.configId==='local')||
           !UUID_RE.test(b.recordId||'')||
           (b.expectedFileFingerprint!==undefined&&!/^[a-f0-9]{64}$/.test(b.expectedFileFingerprint))||
           Object.keys(b).some(k=>!['backend','configId','source','action','recordId','expectedFileFingerprint'].includes(k)))
           fail(req,'m0-server-derived-plan-shape-required');
        return {intercepted:true,allowed:true,transport:'plugin',operation:'m0PlanOnly',backend:b.backend,method:'POST'};
    }
    // F11: server-authenticated, redacted readiness snapshot. GET only;
    // no backend health probe or ability to enable memory operations.
    if (req.transport === 'plugin' && req.suffix === '/v2/setup/readiness') {
        if (req.method !== 'GET' || req.body != null || req.parsed.search)
            fail(req,'f11-readiness-inspection-only');
        return {intercepted:true,allowed:true,operation:'f11Readiness',backend:'none',transport:'plugin',method:'GET'};
    }
    // F12: release-gate inspection only; never accepts claimed host evidence,
    // mutations, query overrides, or a certification switch.
    if (req.transport === 'plugin' && req.suffix === '/v2/release/assessment') {
        if (req.method !== 'GET' || req.body != null || req.parsed.search)
            fail(req,'f12-release-inspection-only');
        return {intercepted:true,allowed:true,operation:'f12Assessment',backend:'none',transport:'plugin',method:'GET'};
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
    // F09b.5: server-owned embedding configuration, write-only credential and
    // bounded test. No embedding vectors or arbitrary URLs are sent to browser.
    if(req.transport==='plugin'&&['/v2/embeddings/profile','/v2/embeddings/test','/v2/embeddings/preflight'].includes(req.suffix)){
        const isProfile=req.suffix.endsWith('/profile');
        const isPreflight=req.suffix.endsWith('/preflight');
        if((isProfile&&!['GET','PUT','DELETE'].includes(req.method))||
           (isPreflight&&req.method!=='GET')||(!isProfile&&!isPreflight&&req.method!=='POST'))
            fail(req,'f09b5-method-forbidden');
        if((req.method==='GET'||req.method==='DELETE')&&req.body!=null)fail(req,'f09b5-body-forbidden');
        if(req.method==='PUT'&&(!req.body||typeof req.body!=='object'||Array.isArray(req.body)||
            Object.keys(req.body).some(k=>!['source','model','dimension','metric','endpoint','credential','clearCredential'].includes(k))||
            !['transformers','llama_cpp','ollama','vllm','koboldcpp','openai','togetherai','mistral','openrouter'].includes(req.body.source)||
            typeof req.body.model!=='string'||!Number.isSafeInteger(req.body.dimension)||
            req.body.dimension<1||req.body.dimension>65536||!['cosine','dot','euclid'].includes(req.body.metric)||
            (['llama_cpp','vllm','koboldcpp'].includes(req.body.source)&&!/^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/v1\/embeddings$/.test(req.body.endpoint||''))||
            (req.body.source==='ollama'&&!/^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/api\/embed$/.test(req.body.endpoint||''))||
            (!['llama_cpp','ollama','vllm','koboldcpp'].includes(req.body.source)&&req.body.endpoint!==undefined)))
            fail(req,'f09b5-profile-shape-forbidden');
        if(req.method==='POST'&&(!req.body||typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(req.body).length))
            fail(req,'f09b5-test-body-forbidden');
        if(req.parsed.search)fail(req,'f09b5-query-forbidden');
        return {intercepted:true,allowed:true,transport:'plugin',operation:'f09b5EmbeddingConfiguration',backend:'none',method:req.method};
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
    // F09b continuation: server-read saved-chat synchronization PLAN, never
    // a mutation, legacy inventory, or a browser-provided message body.
    if(req.transport==='plugin'&&req.suffix==='/v2/workflows/chat-sync-plan'){
        const b=req.body,source=b?.source,embedding=b?.embedding;
        const keys=source?.kind==='chat'?['kind','avatar','chatFile']:
            source?.kind==='group-chat'?['kind','groupId','chatFile']:[];
        if(req.method!=='POST'||!b||!keys.length||!source||
           Object.keys(source).some(k=>!keys.includes(k))||
           keys.some(k=>typeof source[k]!=='string'||!source[k]||source[k].length>220)||
           !embedding||typeof embedding!=='object'||Array.isArray(embedding)||
           Object.keys(embedding).some(k=>!['source','model','dimension','metric'].includes(k))||
           !['qdrant','milvus','lancedb','vectra'].includes(b.backend)||
           (b.configId!==undefined&&!['local','default'].includes(b.configId))||
           Object.keys(b).some(k=>!['backend','source','embedding','configId'].includes(k)))
            fail(req,'f09b-host-chat-sync-plan-shape-required');
        return {intercepted:true,allowed:true,transport:'plugin',operation:'f09bChatSyncPlan',backend:b.backend,method:'POST'};
    }
    // F09b.7: source-owned read-only lorebook link/condition/lifecycle inspection.
    // No record IDs, vectors, link rules, conditions or text are accepted from browser.
    if(req.transport==='plugin'&&req.suffix==='/v2/workflows/link-condition-preview'){
        const b=req.body,source=b?.source,embedding=b?.embedding;
        if(req.method!=='POST'||!b||Object.keys(b).some(k=>!['backend','configId','source','embedding'].includes(k))||
           !['qdrant','lancedb','vectra','milvus'].includes(b.backend)||b.configId!==(b.backend==='qdrant'?'local':'default')||
           !source||source.kind!=='lorebook'||Object.keys(source).sort().join(',')!=='kind,name'||
           typeof source.name!=='string'||!source.name||source.name.length>220||
           /[\\/\x00-\x1f]/.test(source.name)||source.name==='.'||source.name==='..'||
           !embedding||typeof embedding!=='object'||Array.isArray(embedding)||
           Object.keys(embedding).some(k=>!['source','model','dimension','metric'].includes(k))||
           !['transformers','openai','togetherai','mistral','openrouter'].includes(embedding.source)||
           typeof embedding.model!=='string'||!embedding.model||!Number.isSafeInteger(embedding.dimension)||
           embedding.dimension<1||embedding.dimension>65536||!['cosine','dot','euclid'].includes(embedding.metric))
            fail(req,'f09b7-lorebook-preview-only');
        return {intercepted:true,allowed:true,transport:'plugin',operation:'f09b7LinkConditionPreview',backend:b.backend,method:'POST'};
    }
    // F09b.6: exact saved-source summary/lorebook preview and one-record
    // consented pilot. Browser cannot submit text, record IDs or vectors.
    if(req.transport==='plugin'&&req.suffix==='/v2/workflows/saved-content-pilot'){
        const b=req.body,source=b?.source,embedding=b?.embedding;
        const keys=source?.kind==='chat'?['kind','avatar','chatFile']:
            source?.kind==='group-chat'?['kind','groupId','chatFile']:
            source?.kind==='lorebook'?['kind','name']:[];
        if(req.method!=='POST'||!b||!['preview','apply'].includes(b.mode)||!keys.length||
            Object.keys(source).some(k=>!keys.includes(k))||
            keys.some(k=>typeof source[k]!=='string'||!source[k]||source[k].length>220||
              /[\\/\x00-\x1f]/.test(source[k])||source[k]==='.'||source[k]==='..')||
            !['qdrant','milvus','lancedb','vectra'].includes(b.backend)||
            b.configId!==(b.backend==='qdrant'?'local':'default')||
            !embedding||typeof embedding!=='object'||Array.isArray(embedding)||
            Object.keys(embedding).some(k=>!['source','model','dimension','metric'].includes(k))||
            !['transformers','openai','togetherai','mistral','openrouter'].includes(embedding.source)||
            !Number.isSafeInteger(embedding.dimension)||embedding.dimension<1||embedding.dimension>65536||
            typeof embedding.model!=='string'||!embedding.model||
            !['cosine','dot','euclid'].includes(embedding.metric)||
            Object.keys(b).some(k=>!['mode','backend','configId','source','embedding','sourceRevisionFingerprint','itemIndex','experimentalConsent'].includes(k))||
            (b.mode==='preview'&&(b.sourceRevisionFingerprint!==undefined||b.itemIndex!==undefined||b.experimentalConsent!==undefined))||
            (b.mode==='apply'&&(!Number.isSafeInteger(b.itemIndex)||b.itemIndex<0||b.itemIndex>=80||
              !/^[a-f0-9]{64}$/.test(b.sourceRevisionFingerprint||'')||
              b.experimentalConsent!=='I ACCEPT SAVED CONTENT VECTOR PILOT')))
            fail(req,'f09b6-saved-content-source-pilot-required');
        return {intercepted:true,allowed:true,transport:'plugin',operation:'f09b6SavedContentPilot',backend:b.backend,method:'POST'};
    }
    // F09b.3: explicitly confirmed, one-record saved-chat sync PILOT.
    // Server owns text, vector, record and operation IDs. This is not normal
    // automatic vectorization and does not enable general E02 mutations.
    if(req.transport==='plugin'&&req.suffix==='/v2/workflows/chat-sync-pilot-apply'){
        const b=req.body,source=b?.source,embedding=b?.embedding;
        const keys=source?.kind==='chat'?['kind','avatar','chatFile']:
          source?.kind==='group-chat'?['kind','groupId','chatFile']:[];
        if(req.method!=='POST'||!['qdrant','lancedb','vectra','milvus'].includes(b?.backend)||
           b.configId!==(b.backend==='qdrant'?'local':'default')||!keys.length||
           Object.keys(source).some(k=>!keys.includes(k))||
           keys.some(k=>typeof source[k]!=='string'||!source[k]||source[k].length>220)||
           !embedding||typeof embedding!=='object'||Array.isArray(embedding)||
           Object.keys(embedding).some(k=>!['source','model','dimension','metric'].includes(k))||
           !['transformers','openai','togetherai','mistral','electronhub','openrouter','nomicai','cohere'].includes(embedding.source)||
           !Number.isSafeInteger(embedding.dimension)||embedding.dimension<1||embedding.dimension>65536||
           typeof embedding.model!=='string'||!embedding.model||
           !['cosine','dot','euclid'].includes(embedding.metric)||
           b.experimentalConsent!=='I ACCEPT LOCAL CHAT SYNC PILOT'||
           !/^[a-f0-9]{64}$/.test(b.sourceRevisionFingerprint||'')||
           Object.keys(b).some(k=>!['backend','source','embedding','configId','experimentalConsent','sourceRevisionFingerprint'].includes(k)))
            fail(req,'f09b3-source-owned-sync-pilot-required');
        return {intercepted:true,allowed:true,transport:'plugin',operation:'f09b3OneRecordSyncPilot',backend:b.backend,method:'POST'};
    }
    // F09b.4: exact host-saved message lifecycle pilot. Browser may specify a
    // bounded ordinal only; it cannot nominate a record, vector or owner.
    // F09b.4 completion: a source-attested, exact MANAGED orphan pilot.
    // Browser sends only a bounded ordinal and a snapshot fingerprint;
    // records and ownership are selected exclusively by the server.
    if(req.transport==='plugin'&&req.suffix==='/v2/workflows/chat-orphan-pilot'){
        const b=req.body,source=b?.source,embedding=b?.embedding;
        const keys=source?.kind==='chat'?['kind','avatar','chatFile']:
          source?.kind==='group-chat'?['kind','groupId','chatFile']:[];
        if(req.method!=='POST'||!['qdrant','lancedb','vectra','milvus'].includes(b?.backend)||
           b.configId!==(b.backend==='qdrant'?'local':'default')||!keys.length||
           Object.keys(source).some(k=>!keys.includes(k))||
           keys.some(k=>typeof source[k]!=='string'||!source[k]||source[k].length>220)||
           !embedding||typeof embedding!=='object'||Array.isArray(embedding)||
           Object.keys(embedding).some(k=>!['source','model','dimension','metric'].includes(k))||
           !['transformers','openai','togetherai','mistral','electronhub','openrouter','nomicai','cohere'].includes(embedding.source)||
           !Number.isSafeInteger(embedding.dimension)||embedding.dimension<1||embedding.dimension>65536||
           typeof embedding.model!=='string'||!embedding.model||
           !['cosine','dot','euclid'].includes(embedding.metric)||
           !['preview','delete','inspect'].includes(b.mode)||
           (b.mode==='delete'&&!/^[a-f0-9]{64}$/.test(b.sourceRevisionFingerprint||''))||
           (b.mode==='preview'&&(b.orphanIndex!==undefined||b.registryFingerprint!==undefined||b.operationId!==undefined||b.experimentalConsent!==undefined||b.sourceRevisionFingerprint!==undefined))||
           (b.mode==='inspect'&&(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(b.operationId||'')||b.orphanIndex!==undefined||b.registryFingerprint!==undefined||b.experimentalConsent!==undefined||b.sourceRevisionFingerprint!==undefined))||
           (b.mode==='delete'&&(!Number.isSafeInteger(b.orphanIndex)||b.orphanIndex<0||b.orphanIndex>=2000||
             !/^[a-f0-9]{64}$/.test(b.registryFingerprint||'')||
             b.experimentalConsent!=='I ACCEPT VERIFIED MANAGED ORPHAN DELETE PILOT'))||
           Object.keys(b).some(k=>!['backend','source','embedding','configId','mode','sourceRevisionFingerprint',
             'registryFingerprint','orphanIndex','operationId','experimentalConsent'].includes(k)))
            fail(req,'f09b4-managed-orphan-pilot-required');
        return {intercepted:true,allowed:true,transport:'plugin',operation:'f09b4ManagedOrphanPilot',backend:b.backend,method:'POST'};
    }
    if(req.transport==='plugin'&&req.suffix==='/v2/workflows/chat-lifecycle-pilot'){
        const b=req.body,source=b?.source,embedding=b?.embedding;
        const keys=source?.kind==='chat'?['kind','avatar','chatFile']:
          source?.kind==='group-chat'?['kind','groupId','chatFile']:[];
        if(req.method!=='POST'||!['qdrant','lancedb','vectra','milvus'].includes(b?.backend)||
           b.configId!==(b.backend==='qdrant'?'local':'default')||!keys.length||
           Object.keys(source).some(k=>!keys.includes(k))||
           keys.some(k=>typeof source[k]!=='string'||!source[k]||source[k].length>220)||
           !embedding||typeof embedding!=='object'||Array.isArray(embedding)||
           Object.keys(embedding).some(k=>!['source','model','dimension','metric'].includes(k))||
           !['transformers','openai','togetherai','mistral','electronhub','openrouter','nomicai','cohere'].includes(embedding.source)||
           !Number.isSafeInteger(embedding.dimension)||embedding.dimension<1||embedding.dimension>65536||
           typeof embedding.model!=='string'||!embedding.model||
           !['cosine','dot','euclid'].includes(embedding.metric)||
           !Number.isSafeInteger(b.messageIndex)||b.messageIndex<0||b.messageIndex>=80||
           !/^[a-f0-9]{64}$/.test(b.sourceRevisionFingerprint||'')||
           !['delete','revector','inspect'].includes(b.action)||
           (b.action==='delete'&&(b.experimentalConsent!=='I ACCEPT EXACT MESSAGE VECTOR DELETE PILOT'||b.operationId!==undefined))||
           (b.action==='revector'&&(b.experimentalConsent!=='I ACCEPT EXACT MESSAGE REVECTOR PILOT'||b.operationId!==undefined))||
           (b.action==='inspect'&&(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(b.operationId||'')||b.experimentalConsent!==undefined))||
           Object.keys(b).some(k=>!['backend','source','embedding','configId','sourceRevisionFingerprint','messageIndex','action','experimentalConsent','operationId'].includes(k)))
            fail(req,'f09b4-exact-message-lifecycle-shape-required');
        return {intercepted:true,allowed:true,transport:'plugin',operation:'f09b4ExactMessagePilot',backend:b.backend,method:'POST'};
    }
    // F09b: source-attested read-only retrieval for an opt-in, token-budgeted
    // prompt path. This does NOT permit memory mutation or arbitrary scope.
    if(req.transport==='plugin'&&req.suffix==='/v2/workflows/retrieve'){
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
            fail(req,'f09b-source-bound-retrieval-required');
        return {intercepted:true,allowed:true,transport:'plugin',operation:'f09bVerifiedRetrieval',backend:b.backend,method:'POST'};
    }
    // P-A.2: server-owned text embedding, authenticated F02 read. Never accept
    // browser vectors, provider IDs, owner/physical collection or credentials.
    if(req.transport==='plugin'&&req.suffix==='/v2/workflows/retrieve-text'){
        const b=req.body,source=b?.source;
        const sourceKeys=source?.kind==='chat'?['kind','avatar','chatFile']:
            source?.kind==='group-chat'?['kind','groupId','chatFile']:
            source?.kind==='lorebook'?['kind','name']:[];
        if(req.method!=='POST'||!b||!sourceKeys.length||
           Object.keys(source).some(k=>!sourceKeys.includes(k))||
           sourceKeys.some(k=>typeof source[k]!=='string'||!source[k]||source[k].length>220)||
           !['qdrant','milvus','lancedb','vectra'].includes(b.backend)||
           (b.configId!==undefined&&!['local','default'].includes(b.configId))||
           (b.configId==='local'&&b.backend!=='qdrant')||
           typeof b.queryText!=='string'||!b.queryText.trim()||b.queryText.length>10000||
           !Number.isInteger(b.topK)||b.topK<1||b.topK>30||
           Object.keys(b).some(k=>!['backend','source','configId','queryText','topK'].includes(k)))
            fail(req,'p-a2-managed-text-query-required');
        return {intercepted:true,allowed:true,transport:'plugin',operation:'pA2ManagedTextRetrieval',backend:b.backend,method:'POST'};
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
