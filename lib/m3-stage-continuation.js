/** M3 completion: independently reobserve a previously claimed Qdrant stage.
 * A prefix proof is NOT authority to unlock, replay, or dispatch. A separate
 * approved one-use continuation transaction must hold the original and target
 * writer exclusions before using this result.
 */
import {createHash} from 'node:crypto';
import {M3Store} from './m3-collections.js';
import {M3PhysicalProgress} from './m3-physical-progress.js';
import {inspectM3LifecycleRecovery} from './m3-execution-audit.js';
import {readM1Snapshot} from './m1-saved-records.js';
import {getStagedEmbeddingProfile} from './f09b5-embedding-profiles.js';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=code=>Object.assign(new Error(code),{code,status:409});
const targetName=(backupId,operationId)=>'vh2_'+digest(['m3-fresh-restore',backupId,operationId]).slice(0,48);
function equalPoint(a,b){return String(a?.id)===String(b?.id)&&JSON.stringify(a?.payload)===JSON.stringify(b?.payload)&&
 Array.isArray(a?.vector)&&Array.isArray(b?.vector)&&a.vector.length===b.vector.length&&
 a.vector.every((x,i)=>Number.isFinite(x)&&Math.abs(x-b.vector[i])<=0.00002);}
/** Report a safe frontier ONLY when every point in a complete physical scroll
 * is exactly the recorded prefix and there is no uncheckpointed point at all.
 * Absent points are NOT evidence that a dispatched mutation was NOT_APPLIED.
 */
export async function inspectM3StageContinuation(req,id,deps={}){
 if(!req?.s03?.userScopeId||!req.user?.directories||!UUID.test(id??''))throw fail('M3_CONTINUATION_AUTH_REQUIRED');
 const ctx=req.s03,store=deps.store?.(ctx)??new M3Store(ctx),ticket=await store.read('operation',id);
 if(ticket.owner!==ctx.userScopeId||ticket.action!=='rebuild'||ticket.backend!=='qdrant'||
  !UUID.test(ticket.backupId??''))throw fail('M3_CONTINUATION_OPERATION_INVALID');
 const audit=await (deps.audit??inspectM3LifecycleRecovery)(ctx,id,{store});
 const entries=await new M3PhysicalProgress(ctx,id).list();
 if(!audit.claimed||!['DISPATCH_PENDING','PHYSICAL_VERIFIED','COMMITTED'].includes(audit.lastStage))
  throw fail('M3_CONTINUATION_CLAIM_UNVERIFIED');
 if(!entries.length)throw fail('M3_CONTINUATION_NO_CHECKPOINTED_PREFIX');
 const backup=await store.read('backup',ticket.backupId),target=await store.read('backup',entries[0].targetBackupId);
 if(backup.owner!==ctx.userScopeId||target.owner!==ctx.userScopeId||target.derivedFromBackupId!==backup.backupId||
  target.logicalKey!==ticket.targetLogicalKey||target.purpose!=='M3_NEW_MODEL_STAGED_NO_CUTOVER'||
  target.embedding?.dimension!==target.inventory?.rows?.[0]?.vector?.length&&target.inventory.count>0||
  target.inventory.digest!==digest(target.inventory.rows)||target.inventory.count!==ticket.expectedCount||
  targetName(target.backupId,id)!==entries[0].physicalName||target.physicalName===backup.physicalName||
  entries[0].manifestDigest!==target.inventory.digest)throw fail('M3_CONTINUATION_MANIFEST_UNVERIFIED');
 const snapshot=await (deps.readSnapshot??readM1Snapshot)(req,ticket.source);
 if(snapshot.fileHash!==ticket.sourceFingerprint||snapshot.sourceId!==target.sourceId)
  throw fail('M3_CONTINUATION_SOURCE_CHANGED');
 const staged=await (deps.getStagedProfile??getStagedEmbeddingProfile)(ctx);
 if(!staged?.profile||digest(staged.profile)!==ticket.targetProfileHash||
  JSON.stringify(staged.profile)!==JSON.stringify(target.embedding))throw fail('M3_CONTINUATION_MODEL_CHANGED');
 const expected=[...target.inventory.rows].sort((a,b)=>String(a.id).localeCompare(String(b.id)));
 let prefix=0;
 for(const entry of entries){const chunk=expected.slice(prefix,prefix+entry.recordCount);
  if(entry.recordCount!==Math.min(32,expected.length-prefix)||entry.chunkDigest!==digest(chunk))
   throw fail('M3_CONTINUATION_CHUNK_EVIDENCE_CHANGED');
  prefix+=chunk.length;
 }
 if(prefix>expected.length)throw fail('M3_CONTINUATION_COUNT_INVALID');
 const transport=deps.transport?await deps.transport(req,ticket):
  (typeof deps.backendPool?.getTrusted==='function'?await deps.backendPool.getTrusted(ctx,'qdrant',ticket.configId):null);
 if(typeof transport?._request!=='function')throw fail('M3_CONTINUATION_TRANSPORT_UNAVAILABLE');
 const name=entries[0].physicalName,url=`/collections/${name}`;
 const physical=await transport._request('GET',url);
 const params=physical?.result?.config?.params?.vectors;
 const metric={cosine:'Cosine',dot:'Dot',euclid:'Euclid'}[target.embedding.metric];
 if(params?.size!==target.embedding.dimension||params.distance!==metric)
  throw fail('M3_CONTINUATION_SCHEMA_CHANGED');
 const rows=[],ids=new Set(),cursors=new Set();let offset=null,complete=false;
 for(let page=0;page<Math.ceil(ticket.expectedCount/128)+2;page++){
  const body={limit:128,with_payload:true,with_vector:true};if(offset!==null)body.offset=offset;
  const result=await transport._request('POST',`${url}/points/scroll`,body);
  if(!Array.isArray(result?.result?.points))throw fail('M3_CONTINUATION_READBACK_FAILED');
  for(const point of result.result.points){if(ids.has(String(point.id)))throw fail('M3_CONTINUATION_DUPLICATE_POINT');
   ids.add(String(point.id));rows.push(point);if(rows.length>ticket.expectedCount)throw fail('M3_CONTINUATION_FOREIGN_POINTS');}
  if(result.result.next_page_offset==null){complete=true;break;}
  const key=JSON.stringify(result.result.next_page_offset);
  if(cursors.has(key)||key.length>1024)throw fail('M3_CONTINUATION_CURSOR_INVALID');
  cursors.add(key);offset=result.result.next_page_offset;
 }
 if(!complete||rows.length!==prefix)throw fail('M3_CONTINUATION_UNACCOUNTED_POINTS');
 const wanted=new Map(expected.slice(0,prefix).map(p=>[String(p.id),p]));
 for(const observed of rows){const planned=wanted.get(String(observed.id));
  if(!planned||!equalPoint(observed,planned))throw fail('M3_CONTINUATION_POINT_CHANGED');
  wanted.delete(String(observed.id));}
 if(wanted.size)throw fail('M3_CONTINUATION_PREFIX_MISSING');
 const proof={schemaVersion:1,originalOperationId:id,logicalKey:ticket.logicalKey,
  targetLogicalKey:ticket.targetLogicalKey,physicalName:name,targetBackupId:target.backupId,
  manifestDigest:target.inventory.digest,prefixCount:prefix,nextChunkIndex:entries.length,
  totalCount:expected.length,auditStage:audit.lastStage,complete:prefix===expected.length,
  sourceFingerprint:ticket.sourceFingerprint,targetProfileHash:ticket.targetProfileHash,
  physicallyObserved:true,foreignPoints:false,automaticResumeAuthorized:false,
  lockReleaseAuthorized:false};
 return {...proof,proofHash:digest(proof),classification:'EXACT_PREFIX_VERIFIED',
  validationStatus:'AWAITING_MANUAL_TEST',
  instructions:'This readback is evidence only. An administrator must separately resolve retained locks; never reuse the original operation UUID.'};
}
