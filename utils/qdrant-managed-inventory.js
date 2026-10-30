/** Qdrant managed-v2 source inventory diagnostics only.
 * No generic legacy getSavedHashes() unlock, no browser-named physical scope.
 */
import {getCurrentChatId,getRequestHeaders} from '../../../../../script.js';
import {f02CurrentChatSelector} from './f02-public-read-client.js';
import {guardedVectorFetch} from './e02-vector-request-gateway.js';
import {getChatCollectionId} from '../core/chat-vectorization.js';
const KEY=/^[a-f0-9]{64}$/;
export async function qdrantManagedInventory(settings,{collectionId,fetchImpl=globalThis.fetch}={}){
 if(settings?.vector_backend!=='qdrant')throw Error('M3_QDRANT_ONLY');
 if(collectionId!==undefined&&collectionId!==getChatCollectionId())
  throw Error('M3_DIAGNOSTIC_SOURCE_MISMATCH');
 const source=await f02CurrentChatSelector({getChatId:getCurrentChatId,
  getContext:()=>globalThis.SillyTavern?.getContext?.()});
 const response=await guardedVectorFetch('/api/plugins/similharity/v2/m3/collections/managed-inventory',{
  method:'POST',credentials:'same-origin',cache:'no-store',
  headers:{...getRequestHeaders(),'Content-Type':'application/json'},
  body:JSON.stringify({backend:'qdrant',source,configId:settings?.qdrant_use_cloud===true?'default':'local'})
 },fetchImpl);
 let data;try{data=await response.json();}catch{throw Error('M3_INVENTORY_RESPONSE_INVALID');}
 if(!response.ok||data?.success!==true)throw Error(data?.code??'M3_INVENTORY_READ_REFUSED');
 if(data.backend!=='qdrant'||data.inventoryVerified!==true||data.managedV2Only!==true||
  data.entirePhysicalCollectionVerified!==true||data.exclusiveOwner!==true||data.readOnly!==true||
  data.legacySharedCollectionsVerified!==false||data.repairAuthorized!==false||
  data.deleteAuthorized!==false||data.productionCertified!==false||!KEY.test(data.logicalKey??'')||
  !KEY.test(data.inventoryDigest??'')||
  ![data.recordCount,data.uniqueContentHashCount,data.repeatedContentHashGroups,
    data.repeatedContentHashExtraRecords,data.routingGeneration].every(n=>Number.isSafeInteger(n)&&n>=0)||
  data.uniqueContentHashCount>data.recordCount||
  data.repeatedContentHashExtraRecords!==data.recordCount-data.uniqueContentHashCount)
  throw Error('M3_INVENTORY_PROOF_UNTRUSTED');
 return data;
}
