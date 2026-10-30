/** M0 public route-registry choke point.
 * Legacy, pilot, diagnostic and schema mutation routes remain readable in
 * source for evidence/migration, but their HTTP execution is refused until
 * migrated through the single trusted gateway. No environment flag overrides.
 */
export const M0_BLOCKED_PATHS=Object.freeze([
 /^\/chunks\/(?:insert|delete|purge)\/?$/,
 /^\/chunks\/[^/]+\/(?:text|metadata)\/?$/,
 /^\/purge-all\/?$/,
 /^\/v2\/records\/(?:pilot-mutate|lancedb-pilot-mutate|vectra-pilot-mutate|milvus-pilot-mutate)\/?$/,
 /^\/v2\/workflows\/(?:chat-sync-pilot-apply|chat-orphan-pilot|chat-lifecycle-pilot|saved-content-pilot)\/?$/,
 /^\/v2\/collections\/provision\/?$/,
 /^\/v2\/diagnostics\/(?:qdrant-contract|qdrant-f05|lancedb-f06|vectra-f07|milvus-f08)\/?$/,
 /^\/v2\/connections\/(?:qdrant|milvus)\/?$/,
 /^\/v2\/embeddings\/profile\/?$/,
]);
export function isBlockedM0Path(method,url){
 if(!['POST','PUT','PATCH','DELETE'].includes(String(method).toUpperCase()))return false;
 const path=String(url).split('?')[0];
 return M0_BLOCKED_PATHS.some(pattern=>pattern.test(path));
}
export function m0WriteBoundary(req,res,next){
 if(!isBlockedM0Path(req.method,req.path??req.url))return next();
 return res.status(409).json({success:false,code:'M0_LEGACY_WRITE_REQUIRES_GATEWAY',
  executionAllowed:false,retryable:false,reason:'M0_TRUSTED_MUTATION_GATEWAY_ONLY'});
}
