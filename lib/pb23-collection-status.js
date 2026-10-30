/** P-B.23: source-authenticated S02 state, not an advisory filesystem scan.
 * Registry and journal report durable routing state; an F03 receipt is NEVER
 * substituted for live physical proof. No new binding or collection is created.
 */
import path from 'node:path';
import {attestHostSource} from './f01-host-sources.js';
import {canonicalEmbedding,collectionIdentity} from './s02-identity.js';
import {CollectionRegistry} from './s02-registry.js';
import {M3CutoverJournal} from './m3-cutover-journal.js';
const error=(code,status=409)=>Object.assign(new Error(code),{code,status});
export async function inspectPB23CollectionStatus(req,body,deps={}){
 const ctx=req?.s03;
 if(!ctx?.userScopeId||!path.isAbsolute(ctx.vectorsPath??'')||!req?.user?.directories)
  throw error('PB23_HOST_AUTH_REQUIRED',403);
 const owner=await (deps.attest??attestHostSource)(req,body.source);
 if(owner?.status!=='HOST_FILE_OWNED'||owner.hostSourceOwnerVerified!==true||
    owner.scope?.userScopeId!==ctx.userScopeId)throw error('PB23_SOURCE_UNVERIFIED',403);
 const identity=collectionIdentity({backend:body.backend,scope:owner.scope,embedding:canonicalEmbedding(body.embedding)});
 const registry=deps.registry??new CollectionRegistry(path.join(ctx.vectorsPath,'.similharity'));
 const entry=await registry.lookup(identity);
 const common={backend:body.backend,collectionName:identity.physicalName,collectionKey:identity.key,
  registryVerified:true,sourceVerified:true,physicalPresenceVerified:false,
  physicalCollectionProvisioned:false,productionWritesEnabled:false,backendCertified:false,
  inventoryVerified:false,productionCertified:false};
 if(!entry)return {...common,collectionState:'UNPROVISIONED',receiptState:'NO_F03_RECEIPT',receiptCode:null,routingGeneration:null};
 if(entry.key!==identity.key||entry.physicalName!==identity.physicalName||entry.backend!==body.backend)
  throw error('PB23_REGISTRY_MISMATCH');
 // S02 DELETE requires proof when recorded. A later external write is still
 // possible, so a tombstone is NOT evidence of current physical absence.
 if(entry.status==='DELETED')return {...common,collectionState:'DELETED_TOMBSTONED',
  receiptState:'NOT_APPLICABLE',receiptCode:null,routingGeneration:null};
 if(entry.status!=='RESERVED_NOT_ACTIVE')throw error('PB23_REGISTRY_STATE_UNVERIFIED');
 const binding={authorized:true,provenance:'SERVER_VERIFIED',backend:body.backend,
  scope:owner.scope,embedding:identity.embedding,collection:{key:entry.key,physicalName:entry.physicalName}};
 // Journal can refuse an interrupted/locked transition; never silently fall
 // back to canonical routing or declare a collection empty on that error.
 const active=await (deps.resolve??(async()=>new M3CutoverJournal(ctx,{backend:body.backend,
  logicalKey:entry.key}).resolve(binding)))(binding);
 if(active?.logicalKey!==entry.key||!Number.isSafeInteger(active.generation)||active.generation<0||
    typeof active.physicalName!=='string')throw error('PB23_ROUTING_UNVERIFIED');
 if(typeof deps.receipt!=='function')throw error('PB23_RECEIPT_READER_REQUIRED');
 const receipt=await deps.receipt(ctx,binding);
 const state=!receipt?'RESERVED_NO_RECEIPT':receipt.state==='UNCERTAIN'||receipt.state==='PREPARED'
  ?'PROVISION_UNCERTAIN':receipt.state==='SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED'
  ?'SCHEMA_RECEIPT_ONLY':'PROVISION_UNVERIFIED';
 return {...common,collectionState:state,receiptState:receipt?.state??'NO_F03_RECEIPT',
  receiptCode:receipt?.code??null,routingGeneration:active.generation};
}
