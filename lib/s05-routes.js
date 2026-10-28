/** S05 read contract inspection and hard gated public endpoints.
 * No browser may claim SERVER_VERIFIED authorization by request payload. */
import {canonicalScope,collectionIdentity} from './s02-identity.js';
import {readPageOptions,validateVector,ReadError} from './s05-contract.js';
export function registerS05Routes(router,{readHandler=null}={}){
 router.post('/v2/reads/preflight',(req,res)=>{
  try {
   const body=req.body;
   if(!body || typeof body!=='object'||Array.isArray(body)||!req.s03) throw new ReadError('S05_PREFLIGHT_INVALID','Request invalid',400);
   if(body.scope && Object.hasOwn(body.scope,'userScopeId') && body.scope.userScopeId!==req.s03.userScopeId) {
    throw new ReadError('S05_OWNER_CONFLICT','Client cannot override server user identity',403);
   }
   const scope=canonicalScope({...body.scope,userScopeId:req.s03.userScopeId});
   const identity=collectionIdentity({backend:body.backend,scope,embedding:body.embedding});
   const page=readPageOptions(body.page??{});
   if(body.queryVector!==undefined) validateVector(body.queryVector,identity.embedding.dimension);
   res.json({success:true,validated:true,authorized:false,executionAllowed:false,
    scope,collectionKey:identity.key,physicalCollectionName:identity.physicalName,
    page:{limit:page.limit,includeVectors:page.includeVectors},
    inventoryVerified:false,reason:'S05_SOURCE_ATTESTATION_NOT_AVAILABLE'});
  }catch(error){res.status(error.status||400).json({success:false,code:error.code||'S05_PREFLIGHT_INVALID',error:'Read contract preflight rejected'});}
 });
 for(const route of ['/v2/reads/get','/v2/reads/list','/v2/reads/query','/v2/reads/inventory']){
  router.post(route,(req,res)=>readHandler && route!=='/v2/reads/inventory' ? readHandler(route.slice('/v2/reads/'.length),req,res) : res.status(409).json({success:false,code:'S05_READ_NOT_ACTIVATED',
   error:'Authoritative host source ownership and live backend contracts have not been certified.',
   inventoryVerified:false,executionAllowed:false}));
 }
}
