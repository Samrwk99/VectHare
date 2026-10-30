/** M3 versioned binding: only a verified host journal can manufacture an alias.
 * The private WeakMap is process-local, never serializable or request-controlled.
 * This module verifies the *identity contract*, not physical schema/backup or
 * permission to perform a collection mutation.
 */
import {collectionIdentity} from './s02-identity.js';
const verified=new WeakMap();
const BAD=code=>Object.assign(new Error(code),{code,status:409});
const PHYSICAL=/^vh2_[a-f0-9]{48}$/;
/** Called only by the authenticated server-side journal resolver. */
export function markM3ResolvedBinding(binding,attestation){
 const original=collectionIdentity({backend:binding.backend,scope:binding.scope,embedding:binding.embedding});
 if(binding?.authorized!==true||binding?.provenance!=='SERVER_VERIFIED'||original.key!==binding.collection?.key||binding.collection?.physicalName!==original.physicalName||
  !PHYSICAL.test(attestation?.physicalName??'')||attestation?.canonicalName!==original.physicalName||
  attestation?.logicalKey!==original.key||!Number.isSafeInteger(attestation.generation)||attestation.generation<0||
  (attestation.generation===0&&attestation.physicalName!==original.physicalName)||
  (attestation.generation>0&&attestation.physicalName===undefined))throw BAD('M3_VERSIONED_BINDING_INVALID');
 const result=Object.freeze({...binding,collection:Object.freeze({key:original.key,
  physicalName:attestation.physicalName,generation:attestation.generation})});
 verified.set(result,Object.freeze({key:original.key,name:attestation.physicalName,generation:attestation.generation}));
 return result;
}
export function assertM3VersionedBinding(binding){
 const proof=verified.get(binding);
 if(!proof||proof.key!==binding.collection?.key||proof.name!==binding.collection?.physicalName||
  proof.generation!==binding.collection?.generation)throw BAD('M3_VERSIONED_BINDING_NOT_ATTESTED');
 return proof;
}
export function isM3VersionedBinding(binding){return verified.has(binding);}
