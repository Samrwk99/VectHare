/** E06 non-mutating diagnostic probe for a disposable, localhost-only host.
 * No credentials, cookies, mutation routes, collection payloads, or private
 * text are stored. Results are NOT a contract certification. Run manually.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sharedTenantFromCollection,markSharedDisplayPage} from '../utils/e06-shared-read-contract.js';
export function validateE06ReadProbeEnvironment({backend,origin,env=process.env,collectionId}={}) {
    if (env.VECTHARE_PROBE_DISPOSABLE !== '1') throw new Error('E06 probe is disposable-only');
    if (!['qdrant','milvus'].includes(backend)) throw new Error('E06 probe requires qdrant or milvus');
    let target;
    try {target=new URL(origin);}catch{throw new Error('E06 probe requires an explicit localhost origin');}
    if(target.protocol!=='http:' || target.username || target.password || target.pathname!=='/' ||
        target.search || target.hash || !['localhost','127.0.0.1','[::1]'].includes(target.hostname))
        throw new Error('E06 probe refuses remote or credentialed origins');
    return {origin:target.origin,tenant:sharedTenantFromCollection(collectionId,backend)};
}
export async function runE06ReadProbe({backend,collectionId,origin,env=process.env,fetchImpl=globalThis.fetch}={}) {
    const validated=validateE06ReadProbeEnvironment({backend,collectionId,origin,env});
    const report={checkpoint:'E06',backend,origin:validated.origin,tenant:validated.tenant,
        startedAt:new Date().toISOString(),writesAttempted:0,pluginSourceAttested:false,
        authoritativeInventory:false,readCertified:false,checks:{},errors:[]};
    const request=async(route,options={})=>{
        const res=await fetchImpl(validated.origin+'/api/plugins/similharity'+route,options);
        if(!res.ok)throw new Error(`HTTP ${res.status} for ${route}`);
        const data=await res.json();
        if(!data || data.success===false || data.error)throw new Error(`Plugin application-level failure on ${route}`);
        return data;
    };
    try {
        const health=await request('/health');
        report.health={plugin:health.plugin??null,version:health.version??null};
        report.checks.healthOk=health.status==='ok' || health.status==='healthy';
        const body={backend,collectionId:backend==='milvus'?'vecthare_main':collectionId,
            source:'transformers',model:'',filters:validated.tenant,offset:0,limit:25,includeVectors:false};
        const page=await request('/chunks/list',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        const display=markSharedDisplayPage(page,validated.tenant,backend);
        report.checks.pageEnvelopeValid=true;
        report.checks.pageOwnershipPresent=true;
        report.observedRowCount=display.items.length;
        report.observedHasMore=typeof display.hasMore==='boolean'?display.hasMore:null;
        report.status='UNVERIFIED_READ_ONLY';
    }catch(error){
        report.status='ERROR_OR_UNVERIFIED';
        report.errors.push(String(error?.message||error));
    }
    report.completedAt=new Date().toISOString();
    return report;
}
async function main() {
    const [backend,collectionId]=process.argv.slice(2);
    const report=await runE06ReadProbe({backend,collectionId,origin:process.env.VECTHARE_PROBE_ORIGIN});
    const output=path.resolve(process.cwd(),'e06-read-probe-results');
    await fs.mkdir(output,{recursive:true});
    const filename=path.join(output,`e06-read-${backend}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.json`);
    await fs.writeFile(filename,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
    console.log(JSON.stringify({resultFile:filename,status:report.status,checks:report.checks,errors:report.errors},null,2));
    if(report.status==='ERROR_OR_UNVERIFIED')process.exitCode=1;
}
if(process.argv[1] && fileURLToPath(import.meta.url)===path.resolve(process.argv[1]))
    main().catch(error=>{console.error('E06 probe refused:',error.message);process.exitCode=2;});
