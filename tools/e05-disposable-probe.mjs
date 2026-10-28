/** E05 contract probes for a disposable local SillyTavern + Similharity only.
 * NEVER imported into browser runtime. Does not modify plugin files.
 * Uses its own unique new collection and deletes ONLY its own test records.
 * No purge, global delete, credentials or prior user data.
 *
 * Usage:
 *  VECTHARE_PROBE_DISPOSABLE=1 VECTHARE_PROBE_ORIGIN=http://127.0.0.1:8000 \
 *    node tools/e05-disposable-probe.mjs standard
 * Repeat after a SERVER RESTART and review both JSON receipts manually.
 */
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {collectVerifiedInventory,validateWriteBatch,evaluateWriteReadback,verifyWriteIdentity,verifyInsertedPoint} from '../utils/e05-verified-write-contract.js';

export function validateProbeEnvironment({env=process.env,origin,backend}={}){
    if(env.VECTHARE_PROBE_DISPOSABLE!=='1')throw new Error('E05 probes require VECTHARE_PROBE_DISPOSABLE=1');
    if(!['standard','lancedb'].includes(backend))throw new Error('E05 probe only supports standard/lancedb');
    let url;
    try{url=new URL(origin);}catch{throw new Error('Explicit local probe origin is required');}
    if(url.username||url.password||url.search||url.hash||url.pathname!=='/' || url.protocol!=='http:' ||
        !['localhost','127.0.0.1','[::1]'].includes(url.hostname))
        throw new Error('E05 probes refuse non-local, credentialed or HTTPS origins');
    return url.origin;
}

export async function runDisposableProbe({backend,origin,env=process.env,fetchImpl=globalThis.fetch,now=()=>Date.now(),nonce=()=>crypto.randomBytes(7).toString('hex')}={}){
    const safeOrigin=validateProbeEnvironment({env,origin,backend});
    const collectionId=`e05_probe_${backend}_${nonce()}`;
    verifyWriteIdentity({backend,collectionId,source:'transformers'});
    const hash=Number(`${now()}`.slice(-9))*1000+Math.floor(Math.random()*1000);
    const item={hash,text:`E05 disposable ${collectionId}`,index:0,vector:[0.11,0.22,0.33,0.44],metadata:{e05Probe:true}};
    validateWriteBatch([item],{backend});
    const request=async(route,body=null)=>{
        const response=await fetchImpl(`${safeOrigin}/api/plugins/similharity${route}`,{
            method:body===null?'GET':'POST',
            headers:body===null?{}:{'Content-Type':'application/json'},
            ...(body===null?{}:{body:JSON.stringify(body)}),
        });
        const data=await response.json();
        if(!response.ok || data?.success===false || data?.error)throw new Error(`Probe ${route} failed (HTTP ${response.status})`);
        return data;
    };
    const base={backend:backend==='standard'?'vectra':backend,collectionId,source:'transformers',model:''};
    const report={schemaVersion:1,backend,collectionId,origin:safeOrigin,probeMode:'disposable-only',
        startedAt:new Date().toISOString(),pluginSourceAttested:false,requiresServerRestartRepeat:true,
        status:'INCOMPLETE',checks:{},errors:[],note:'Source fingerprint and server identity must be verified independently. This never unlocks E02.'};
    const page=async({offset,limit})=>request('/chunks/list',{...base,offset,limit,includeVectors:false});
    let inserted=false;
    try {
        const health=await request('/health');
        report.pluginHealth={plugin:health.plugin??null,version:health.version??null};
        report.checks.health=true;
        const before=await collectVerifiedInventory(page);
        report.checks.cleanCollection=before.count===0;
        if(!report.checks.cleanCollection)throw new Error('Probe collection unexpectedly nonempty; refusing mutation');
        await request('/chunks/insert',{...base,items:[item]});
        inserted=true;
        const after=await collectVerifiedInventory(page);
        const proof=evaluateWriteReadback(before,after,[item]);
        report.checks.insertReadback=proof.verified;
        if(!proof.verified)throw new Error('Inserted record not independently verified');
        const exact=await request(`/chunks/${encodeURIComponent(hash)}?`+new URLSearchParams(base));
        report.checks.pointRead=verifyInsertedPoint(item,exact.chunk);
        if(!report.checks.pointRead)throw new Error('Point readback mismatch');
        await request('/chunks/delete',{...base,hashes:[hash]});
        const afterDelete=await collectVerifiedInventory(page);
        report.checks.deleteReadback=afterDelete.count===0 && !afterDelete.rows.has(String(hash));
        if(!report.checks.deleteReadback)throw new Error('Deletion not independently verified');
        report.status='PASS_SINGLE_RUN';
    }catch(error){report.status='FAIL_OR_UNVERIFIED';report.errors.push(String(error.message||error));}
    if(inserted && report.status!=='PASS_SINGLE_RUN')
        report.cleanup='UNCERTAIN: a probe record may still exist; do not auto-retry or purge';
    report.completedAt=new Date().toISOString();
    return report;
}

async function main(){
    const backend=process.argv[2],origin=process.env.VECTHARE_PROBE_ORIGIN;
    const report=await runDisposableProbe({backend,origin});
    const outDir=path.resolve(process.cwd(),'e05-probe-results');
    await fs.mkdir(outDir,{recursive:true});
    const out=path.join(outDir,`e05-${backend}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.json`);
    await fs.writeFile(out,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
    console.log(JSON.stringify({file:out,...report},null,2));
    if(report.status!=='PASS_SINGLE_RUN')process.exitCode=1;
}
if(process.argv[1] && fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
    main().catch(error=>{console.error('E05 probe refused:',error.message);process.exitCode=2;});
}
