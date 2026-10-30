/** M0 Record Schema v2. Canonical immutable shape for future saved-source writes.
 * This is a validator, NOT a migration, write authorization or backend payload.
 * All optional future feature fields are reserved now to prevent schema drift.
 */
import {createHash} from 'node:crypto';

export const RECORD_SCHEMA_VERSION=2;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH=/^[a-f0-9]{64}$/;
const safe=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const fail=(code)=>{throw Object.assign(new Error(code),{code,status:400});};
const own=(o,keys)=>safe(o)&&Object.keys(o).every(k=>keys.includes(k));
const bounded=(x,max=256)=>typeof x==='string'&&x.length>0&&x.length<=max;
const optionalArray=(items,max=128)=>Array.isArray(items)&&items.length<=max;
const hex=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
/** RFC4122-like deterministic UUID v8: stable logical identity, not content hash.
 * A source revision stays a separate field. Revectorization targets same UUID.
 */
export function deterministicRecordUUID({userScopeId,sourceId,branchId='',sourceEntryId}){
 if(![userScopeId,sourceId,sourceEntryId].every(v=>bounded(v,512))||!bounded(branchId||'_',512))fail('M0_IDENTITY_INVALID');
 const d=Buffer.from(hex(['VH_RECORD_V2',userScopeId,sourceId,branchId,sourceEntryId]).slice(0,32),'hex');
 d[6]=(d[6]&15)|0x80;d[8]=(d[8]&63)|0x80;
 const s=d.toString('hex');return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
}
export function validateRecordV2(row){
 const fields=['schemaVersion','recordId','identity','source','revision','contentHash','embedding','tombstone','links','conditions','parent','summary','lorebook','metadata'];
 if(!own(row,fields)||row.schemaVersion!==2||!UUID.test(row.recordId))fail('M0_RECORD_SHAPE_INVALID');
 const i=row.identity;
 if(!own(i,['userScopeId','sourceId','branchId','sourceEntryId'])||
 ![i.userScopeId,i.sourceId,i.sourceEntryId].every(v=>bounded(v,512))||
 (i.branchId!==undefined&&typeof i.branchId!=='string')||
 deterministicRecordUUID(i)!==row.recordId)fail('M0_RECORD_IDENTITY_INVALID');
 if(!own(row.source,['kind','fileFingerprint','saved','location'])||
 !['chat','group-chat','lorebook','summary','file','document'].includes(row.source.kind)||
 row.source.saved!==true||!HASH.test(row.source.fileFingerprint)||
 (row.source.location!==undefined&&!bounded(row.source.location,256)))fail('M0_SOURCE_ATTESTATION_INVALID');
 if(!Number.isSafeInteger(row.revision)||row.revision<1||!HASH.test(row.contentHash))fail('M0_REVISION_INVALID');
 const e=row.embedding;
 if(!own(e,['source','model','dimension','metric','profileFingerprint'])||
 !bounded(e.source,64)||!bounded(e.model,128)||!Number.isSafeInteger(e.dimension)||
 e.dimension<1||e.dimension>65536||!['cosine','dot','euclid'].includes(e.metric)||
 !HASH.test(e.profileFingerprint))fail('M0_EMBEDDING_INVALID');
 if(!own(row.tombstone,['state','deletedAt','operationId'])||
 !['ACTIVE','WRITE_PENDING','DELETE_PENDING','DELETED'].includes(row.tombstone.state)||
 (row.tombstone.deletedAt!==null&&(!Number.isSafeInteger(row.tombstone.deletedAt)||row.tombstone.deletedAt<0))||
 (row.tombstone.operationId!==null&&!UUID.test(row.tombstone.operationId)))fail('M0_TOMBSTONE_INVALID');
 if(!optionalArray(row.links)||row.links.some(l=>!own(l,['sourceRecordUUID','targetRecordUUID','relationship','scope','sourceRevision'])||
 l.sourceRecordUUID!==row.recordId||!UUID.test(l.targetRecordUUID)||!bounded(l.relationship,64)||
 !['owned-collection','owned-source'].includes(l.scope)||l.sourceRevision!==row.revision))fail('M0_LINKS_INVALID');
 if(!optionalArray(row.conditions,64)||row.conditions.some(c=>!own(c,['id','type','operator','value','enabled'])||
 !bounded(c.id,64)||!bounded(c.type,64)||!bounded(c.operator,32)||
 c.enabled!==true&&c.enabled!==false||JSON.stringify(c.value)?.length>4096))fail('M0_CONDITIONS_INVALID');
 if(row.parent!==null&&(!own(row.parent,['recordId','sourceRevision'])||!UUID.test(row.parent.recordId)||
 !Number.isSafeInteger(row.parent.sourceRevision)||row.parent.sourceRevision<1))fail('M0_PARENT_INVALID');
 if(row.summary!==null&&(!own(row.summary,['templateVersion','sourceSpanHash','approved','generationModel','parentRecordUUIDs'])||
 !bounded(row.summary.templateVersion,64)||!HASH.test(row.summary.sourceSpanHash)||
 typeof row.summary.approved!=='boolean'||!bounded(row.summary.generationModel,128)||
 !optionalArray(row.summary.parentRecordUUIDs)||row.summary.parentRecordUUIDs.some(id=>!UUID.test(id))))fail('M0_SUMMARY_INVALID');
 if(row.lorebook!==null&&(!own(row.lorebook,['uid','triggers','conditions','enabled'])||
 !bounded(row.lorebook.uid,128)||!optionalArray(row.lorebook.triggers)||
 row.lorebook.triggers.some(t=>!bounded(t,256))||!optionalArray(row.lorebook.conditions)||
 typeof row.lorebook.enabled!=='boolean'))fail('M0_LOREBOOK_INVALID');
 if(!safe(row.metadata)||Buffer.byteLength(JSON.stringify(row.metadata))>32768)fail('M0_METADATA_INVALID');
 return Object.freeze({...row});
}
