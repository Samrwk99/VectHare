/** F09c.6 — explicit, offline-testable real-Qdrant acceptance probe.
 * NOT a production mutation adapter, exclusive-writer authorization, or
 * authoritative applied-vs-skipped acknowledgement. Not mounted on any route.
 * The only writable target is a newly generated disposable collection.
 */
import {randomUUID} from 'node:crypto';

const CONSENT='I_ACCEPT_F09C6_DISPOSABLE_QDRANT_WRITES';
const CLEANUP='DELETE_MY_F09C6_DISPOSABLE_COLLECTION';
const VALID_UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const failure=(code)=>Object.assign(new Error(code),{code});
function endpointURL(endpoint){
 if(typeof endpoint!=='string')throw failure('F09C6_ENDPOINT_INVALID');
 let url;try{url=new URL(endpoint);}catch{throw failure('F09C6_ENDPOINT_INVALID');}
 // Strict, literal local interface: no cloud endpoint, redirect, userinfo,
 // query path, credentials in URL, DNS aliases or implicit remote request.
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||
    url.username||url.password||url.pathname!=='/'||url.search||url.hash||
    !(Number(url.port)>=1&&Number(url.port)<=65535))throw failure('F09C6_ENDPOINT_NOT_DISPOSABLE_LOCAL');
 return url.origin;
}
function redactError(error){
 return typeof error?.code==='string'&&/^F09C6_[A-Z_]+$/.test(error.code)?error.code:'F09C6_TRANSPORT_OR_RESPONSE_ERROR';
}
function qdrantVersion(value){
 const match=typeof value==='string'&&/^(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?$/.exec(value);
 if(!match)return false;
 const [major,minor]=[Number(match[1]),Number(match[2])];
 return major>1||(major===1&&minor>=17);
}
const condition=(key,value)=>({key,match:{value}});
const matchRevision=(revision,tag)=>({must:[condition('revision',revision),condition('tag',tag)]});

export function validateQdrantF09c6Options({endpoint,mode='read-only',consent=null,cleanupConsent=null}={}){
 const origin=endpointURL(endpoint);
 if(!['read-only','disposable'].includes(mode))throw failure('F09C6_MODE_INVALID');
 if(mode==='disposable'&&consent!==CONSENT)throw failure('F09C6_CONSENT_REQUIRED');
 if(cleanupConsent!==null&&cleanupConsent!==CLEANUP)throw failure('F09C6_CLEANUP_CONSENT_INVALID');
 if(mode!=='disposable'&&cleanupConsent!==null)throw failure('F09C6_CLEANUP_WITHOUT_DISPOSABLE');
 return Object.freeze({origin,mode,cleanup:cleanupConsent===CLEANUP});
}

/** Result is host diagnostics; cannot attest external writer isolation. 
 * Transport must conform to fetch, injected to run isolated offline tests.
 */
export async function runQdrantF09c6HostProbe(options={},fetchFn=globalThis.fetch){
 const valid=validateQdrantF09c6Options(options); // NO network before validation
 if(typeof fetchFn!=='function')throw failure('F09C6_FETCH_UNAVAILABLE');
 if(options.apiKey!==undefined&&typeof options.apiKey!=='string')throw failure('F09C6_KEY_INVALID');
 const diagnostic={checkpoint:'F09c.6',mode:valid.mode,serverVersion:null,
  createdDisposableCollection:null,steps:[],
  independentExternalWriterIsolation:'NOT_TESTED',
  crashRestartRecovery:'NOT_TESTED',authoritativeConditionMatchReceipt:'UNPROVEN',
  atomicBackendCertified:false,productionPermission:false,
  status:'INCOMPLETE'};
 const apiKey=options.apiKey;
 // fetch does not follow redirects and each request has a bounded deadline;
 // never retry unknown mutations, timeouts or network failures.
 async function request(method,path,body,expect404=false){
  const headers={'accept':'application/json'};
  if(body!==undefined)headers['content-type']='application/json';
  if(apiKey)headers['api-key']=apiKey;
  let res;
  try{res=await fetchFn(valid.origin+path,{method,headers,
    ...(body!==undefined?{body:JSON.stringify(body)}:{}),
    redirect:'manual',signal:AbortSignal.timeout(4000)});
  }catch{throw failure('F09C6_REQUEST_OUTCOME_UNKNOWN');}
  if(res.status===404&&expect404)return {notFound:true};
  if(!res.ok||res.status>=300||res.status<200)throw failure('F09C6_HTTP_ERROR');
  let json;try{json=await res.json();}catch{throw failure('F09C6_RESPONSE_INVALID');}
  if(!json||typeof json!=='object'||json.status==='error')throw failure('F09C6_RESPONSE_INVALID');
  return json;
 }
 const step=(name,passed,detail)=>diagnostic.steps.push({name,passed,detail});
 try{
  const info=await request('GET','/');
  const version=info.version;diagnostic.serverVersion=typeof version==='string'?version:null;
  if(!qdrantVersion(version))throw failure('F09C6_SERVER_VERSION_UNSUPPORTED');
  step('version_1_17_or_newer',true,'SERVER_REPORTED');
  if(valid.mode==='read-only'){
   diagnostic.status='PREFLIGHT_ONLY';return diagnostic;
  }
  // Collision-resistant collection name, never supplied by caller. UUID
  // identifies the exact collection that can be considered for cleanup.
  const id=randomUUID();if(!VALID_UUID.test(id))throw failure('F09C6_IDENTIFIER_INVALID');
  const collection='vh_f09c6_disposable_'+id.replaceAll('-','');
  const collectionPath='/collections/'+collection;
  const exists=await request('GET',collectionPath,undefined,true);
  if(!exists.notFound)throw failure('F09C6_COLLECTION_COLLISION');
  // Once PUT is dispatched any error could leave the collection present.
  // We never try to recreate it, overwrite it, or silently remove it.
  diagnostic.createdDisposableCollection=collection;
  const create=await request('PUT',collectionPath,{vectors:{size:3,distance:'Cosine'}});
  if(create.result!==true)throw failure('F09C6_COLLECTION_CREATION_UNCERTAIN');
  step('fresh_disposable_collection',true,'CREATION_RESPONSE_TRUE');
  const pointId=randomUUID(),tag=randomUUID();
  const pointBase=collectionPath+'/points';
  const point=(revision,vector)=>({id:pointId,vector,payload:{tag,revision}});
  const retrieve=async()=>{
   const res=await request('POST',pointBase,{ids:[pointId],with_payload:true,with_vector:false});
   if(!Array.isArray(res.result))throw failure('F09C6_POINT_READBACK_INVALID');
   return res.result.find(p=>p?.id===pointId)??null;
  };
  const mutation=async(row,mode,filter)=>{
   const body={points:[row],update_mode:mode};
   if(filter)body.update_filter=filter;
   const ack=await request('PUT',pointBase+'?wait=true&ordering=strong',body);
   const result=ack.result;
   if(!result||!['completed','acknowledged'].includes(result.status))throw failure('F09C6_MUTATION_ACK_UNCERTAIN');
   return result.status;
  };
  const insertStatus=await mutation(point(1,[1,0,0]),'insert_only');
  const first=await retrieve();
  if(first?.payload?.revision!==1||first?.payload?.tag!==tag)throw failure('F09C6_INSERT_READBACK_UNVERIFIED');
  step('insert_only',true,'POSTSTATE_OBSERVED_NOT_CAUSALLY_ATTRIBUTED_'+insertStatus);
  const updateStatus=await mutation(point(2,[0,1,0]),'update_only',matchRevision(1,tag));
  const second=await retrieve();
  if(second?.payload?.revision!==2)throw failure('F09C6_UPDATE_READBACK_UNVERIFIED');
  step('revision_matched_update_only',true,'POSTSTATE_OBSERVED_NOT_CAUSALLY_ATTRIBUTED_'+updateStatus);
  // Stale overwrite must be rejected. Note this only probes local behavior:
  // another independent writer with raw upsert credentials can still bypass.
  const staleStatus=await mutation(point(99,[0,0,1]),'update_only',matchRevision(1,tag));
  const afterStale=await retrieve();
  if(afterStale?.payload?.revision!==2)throw failure('F09C6_STALE_CONDITION_BYPASS');
  step('stale_revision_rejected',true,'POSTSTATE_UNCHANGED_COMPLETION_'+staleStatus);
  const insertAgain=await mutation(point(98,[0,0,1]),'insert_only');
  const afterInsertAgain=await retrieve();
  if(afterInsertAgain?.payload?.revision!==2)throw failure('F09C6_INSERT_ONLY_BYPASS');
  step('existing_insert_only_rejected',true,'POSTSTATE_UNCHANGED_COMPLETION_'+insertAgain);
  // Even a clean series of trials cannot prove per-write applied causality.
  diagnostic.status='CANDIDATE_HOST_OBSERVED_NO_PRODUCTION_CERTIFICATION';
  if(valid.cleanup){
   // Only this invocation's randomly created disposable collection is removed.
   // Never attempt cleanup after any ambiguous operation or failed step.
   const gone=await request('DELETE',collectionPath);
   if(gone.result!==true)throw failure('F09C6_CLEANUP_OUTCOME_UNCERTAIN');
   const absent=await request('GET',collectionPath,undefined,true);
   if(!absent.notFound)throw failure('F09C6_CLEANUP_NOT_CONFIRMED');
   step('disposable_cleanup',true,'DELETE_RESPONSE_TRUE_AND_404_READBACK');
  }
  return diagnostic;
 }catch(e){
  diagnostic.status='FAILED_OR_UNCERTAIN';
  diagnostic.steps.push({name:'failure',passed:false,detail:redactError(e)});
  // Keep the name in the returned report for manual inspection. No mutation
  // retry or blind cleanup on any uncertain outcome.
  return diagnostic;
 }
}

export const F09C6_CONSENT=CONSENT;
export const F09C6_CLEANUP_CONSENT=CLEANUP;
