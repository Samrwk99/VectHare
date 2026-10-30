#!/usr/bin/env node
/** ADMIN-ONLY probe: synthetic, uniquely named disposable Qdrant collection.
 * Not a SillyTavern integration test and NEVER promotes capability evidence.
 * CLI config is server-side only. Run on the host, not through browser routes.
 */
import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs/promises';
const consent=process.env.SIMILHARITY_DISPOSABLE_QDRANT_PROBE;
const address=process.env.SIMILHARITY_QDRANT_PROBE_URL;
const token=process.env.SIMILHARITY_QDRANT_PROBE_API_KEY;
if(consent!=='I_AUTHORIZE_SYNTHETIC_TEST_COLLECTION'||!address){
 console.error('Refused. Requires SIMILHARITY_DISPOSABLE_QDRANT_PROBE=I_AUTHORIZE_SYNTHETIC_TEST_COLLECTION and SIMILHARITY_QDRANT_PROBE_URL.');process.exit(2);
}
let base;
try{const url=new URL(address);
 if(url.username||url.password||url.search||url.hash||url.pathname!=='/'&&url.pathname!=='')throw Error('invalid URL shape');
 const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
 if(url.protocol!=='https:'&&!(loopback&&url.protocol==='http:'))throw Error('HTTPS required for remote Qdrant');
 base=url.origin;
}catch(e){console.error('Invalid server-side Qdrant endpoint:',e.message);process.exit(2);}
const col='vh_m2_probe_'+randomUUID().replace(/-/g,'').slice(0,24);
const recordId=randomUUID();
const request=async(method,url,body)=>{
 const res=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(token?{'api-key':token}:{})},
  ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
 let doc;try{doc=await res.json();}catch{throw Error('Non-JSON Qdrant response '+res.status);}
 if(!res.ok||doc.status?.error)throw Error('Qdrant '+res.status+' '+JSON.stringify(doc.status).slice(0,400));return doc;
};
const trace=[];let created=false,cleaned=false;
const log=(gate,passed,detail={})=>trace.push({gate,passed,...detail});
const fetchPoint=async()=>{
 const doc=await request('POST',`/collections/${col}/points`,{ids:[recordId],with_payload:true,with_vector:true});
 return doc.result?.[0]??null;
};
try{
 const meta=await request('GET','/');log('QDRANT_SERVICE_CONNECTS',true,{version:meta.version??null});
 await request('PUT',`/collections/${col}`,{vectors:{size:3,distance:'Cosine'}});created=true;
 const revision=(rev,txt)=>({id:recordId,vector:[0.4,0.5,0.6],payload:{revision:rev,text:txt,
  recordId,ownerScope:'synthetic-probe',contentHash:createHash('sha256').update(txt).digest('hex')}});
 const first=revision(1,'synthetic-probe-v1');
 await request('PUT',`/collections/${col}/points?wait=true`,{points:[first]});
 const got=await fetchPoint();
 if(got?.id!==recordId||got.payload?.revision!==1||got.payload?.contentHash!==first.payload.contentHash||got.vector?.length!==3)throw Error('Initial exact point readback mismatch');
 log('DETERMINISTIC_ID_EXPLICIT_REVISION_READBACK',true);
 // Simulate an ACK lost after the first write: repeat the identical idempotent upsert.
 await request('PUT',`/collections/${col}/points?wait=true`,{points:[first]});
 const repeated=await fetchPoint();
 if(repeated?.payload?.revision!==1||repeated.payload.contentHash!==first.payload.contentHash)throw Error('Duplicate upsert changed goal state');
 log('LOST_ACK_GOAL_STATE_READBACK_AND_UPSERT',true);
 const second=revision(2,'synthetic-probe-v2');
 await request('PUT',`/collections/${col}/points?wait=true`,{points:[second]});
 const got2=await fetchPoint();if(got2?.payload?.revision!==2||got2?.payload?.contentHash!==second.payload.contentHash)throw Error('Explicit revision update mismatch');
 log('EXPLICIT_REVISION_PAYLOAD_CHANGE',true,{note:'Not a backend-enforced CAS; cooperative lock and M1 revision checks still require SillyTavern acceptance'});
 await request('POST',`/collections/${col}/points/delete?wait=true`,{points:[recordId]});
 if(await fetchPoint()!==null)throw Error('Deleted point still readable');
 log('EXACT_POINT_DELETE_READBACK',true);
}catch(e){log('PROBE_EXECUTION',false,{error:e.message});process.exitCode=1;}
finally{
 if(created){try{await request('DELETE',`/collections/${col}`);cleaned=true;}catch(e){log('CLEANUP',false,{error:e.message});process.exitCode=1;}}
 log('CLEANUP',cleaned||!created,{syntheticCollection:col});
 const result={schemaVersion:1,kind:'M2_REAL_QDRANT_DISPOSABLE_SPIKE_ONLY',backend:'qdrant',
  collection:col,recordId,runId:randomUUID(),timestamp:new Date().toISOString(),
  hostAccepted:false,productionEnablementAllowed:false,cleanupVerified:cleaned||!created,
  passed:trace.every(x=>x.passed)&&!process.exitCode,checks:trace,
  remaining:['latest-stable real SillyTavern host','M1 saved-source authorization and scope','two-process physical lock','crash/receipt registry coordination','embedding and F03 index compatibility','real UI and end-to-end record actions']};
 const out=process.env.SIMILHARITY_QDRANT_PROBE_REPORT;
 if(out){try{await fs.writeFile(out,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});}catch(e){console.error('Could not write report:',e.message);process.exitCode=1;}}
 process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
