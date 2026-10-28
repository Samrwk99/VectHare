/** S05 read-only, mock-testable adapters for NEW v2 physical schema.
 * MUST be invoked only using an independently server-attested binding, never
 * directly with a raw HTTP body. Not registered on public routes in S05. */
import {requireReadBinding,ownedRecord,verifyPage,validateSearchOptions,readPageOptions,ReadError} from './s05-contract.js';
import {recordIdentity} from './s02-identity.js';

function qdrantFilter(scope,recordId=null){
 const must=['userScopeId','collectionId','type','sourceId'].map(key=>({key,match:{value:scope[key]}}));
 if(scope.branchId!==undefined) must.push({key:'branchId',match:{value:scope.branchId}});
 else must.push({key:'branchId',match:{value:''}}); // v2 stores explicit empty-string branch
 if(recordId!==null) must.push({key:'recordId',match:{value:recordId}});
 return {must};
}
function qdrantRow(point){
 if (point?.payload?.physicalId!==undefined && point.payload.physicalId!==point.id) throw new ReadError('S05_PHYSICAL_ID_MISMATCH','Qdrant payload and point ID conflict');
 if (!point || typeof point!=='object' || !point.payload) throw new ReadError('S05_BACKEND_RESPONSE_INVALID','Qdrant point missing payload');
 return {...point.payload,physicalId:point.id,vector:point.vector??undefined};
}
export function qdrantV2Reads(backend,binding) {
 const b=requireReadBinding(binding);
 if(!backend || typeof backend._request!=='function') throw new ReadError('S05_BACKEND_INVALID','Qdrant transport missing');
 const path=`/collections/${b.physicalName}/points/scroll`;
 return Object.freeze({
   async getRecord(recordId){
     const record=recordIdentity(b.scope,recordId);
     const response=await backend._request('POST',path,{filter:qdrantFilter(b.scope,record.recordId),limit:2,with_payload:true,with_vector:true});
     const points=response?.result?.points;
     if(!Array.isArray(points)) throw new ReadError('S05_BACKEND_RESPONSE_INVALID','Qdrant result missing points');
     if(points.length===0) return null;
     if(points.length!==1) throw new ReadError('S05_DUPLICATE_RECORD','Multiple points with a single record identity');
     return ownedRecord(qdrantRow(points[0]),binding,{includeVector:true});
   },
   async listPage(options={}) {
     const o=readPageOptions(options), request={limit:o.limit,with_payload:true,with_vector:o.includeVectors,filter:qdrantFilter(b.scope)};
     if(o.cursor!==null) request.offset=o.cursor;
     const response=await backend._request('POST',path,request), points=response?.result?.points;
     if(!Array.isArray(points)) throw new ReadError('S05_BACKEND_RESPONSE_INVALID','Qdrant result missing points');
     const nextCursor=response.result.next_page_offset??null;
     return verifyPage({items:points.map(qdrantRow),nextCursor,hasMore:nextCursor!==null},binding,o);
   },
   async query(input){
     const o=validateSearchOptions(input,binding);
     const response=await backend._request('POST',`/collections/${b.physicalName}/points/search`,{
       vector:o.vector,limit:o.topK,with_payload:true,with_vector:false,filter:qdrantFilter(b.scope)});
     if(!Array.isArray(response?.result)) throw new ReadError('S05_BACKEND_RESPONSE_INVALID','Qdrant search malformed');
     return response.result.map(p=>{
       const record=ownedRecord(qdrantRow(p),binding);
       if(typeof p.score!=='number'||!Number.isFinite(p.score)) throw new ReadError('S05_SCORE_INVALID','Invalid search score');
       return {...record,score:p.score};
     });
   }
 });
}
const MILVUS_COLUMNS=['recordId','physicalId','userScopeId','collectionId','type','sourceId','branchId','revision','text','textHash','metadata','metadataHash','embedding','vectorHash'];
function milvusQuoted(s){if(typeof s!=='string') throw new ReadError('S05_SCOPE_INVALID','Missing filter value');return JSON.stringify(s);}
function milvusExpr(scope,recordId=null){
 const clauses=['userScopeId','collectionId','type','sourceId'].map(k=>`${k} == ${milvusQuoted(scope[k])}`);
 clauses.push(scope.branchId!==undefined ? `branchId == ${milvusQuoted(scope.branchId)}` : 'branchId == ""');
 if(recordId!==null) clauses.push(`recordId == ${milvusQuoted(recordId)}`);
 return clauses.join(' && ');
}
function milvusRows(response){
 if(!Array.isArray(response?.data)) throw new ReadError('S05_BACKEND_RESPONSE_INVALID','Milvus query missing data array');
 return response.data;
}
export function milvusV2Reads(backend,binding){
 const b=requireReadBinding(binding),client=backend?.client;
 if(!client||typeof client.query!=='function'||typeof client.search!=='function') throw new ReadError('S05_BACKEND_INVALID','Milvus client missing');
 return Object.freeze({
   async getRecord(recordId){
     const record=recordIdentity(b.scope,recordId);
     const response=await client.query({collection_name:b.physicalName,filter:milvusExpr(b.scope,record.recordId),
       output_fields:[...MILVUS_COLUMNS,'vector'],limit:2});
     const rows=milvusRows(response);
     if(!rows.length) return null;
     if(rows.length!==1) throw new ReadError('S05_DUPLICATE_RECORD','Multiple Milvus records matched');
     return ownedRecord(rows[0],binding,{includeVector:true});
   },
   async listPage(options={}){
     const o=readPageOptions(options);
     // Offset pagination has no stable consistency guarantee and is NOT a certified
     // full inventory. Fetch one extra item solely to discover hasMore.
     const offset=o.cursor??0;
     if(!Number.isSafeInteger(offset)||offset<0||offset>100000) throw new ReadError('S05_CURSOR_INVALID','Milvus offset invalid',400);
     const response=await client.query({collection_name:b.physicalName,filter:milvusExpr(b.scope),
       output_fields:o.includeVectors?[...MILVUS_COLUMNS,'vector']:MILVUS_COLUMNS,
       limit:o.limit+1,offset});
     const rows=milvusRows(response),hasMore=rows.length>o.limit;
     return verifyPage({items:rows.slice(0,o.limit),nextCursor:hasMore?offset+o.limit:null,hasMore},binding,o);
   },
   async query(input){
     const o=validateSearchOptions(input,binding);
     const response=await client.search({collection_name:b.physicalName,vector:o.vector,
       filter:milvusExpr(b.scope),limit:o.topK,output_fields:MILVUS_COLUMNS});
     const rows=response?.results;
     if(!Array.isArray(rows)) throw new ReadError('S05_BACKEND_RESPONSE_INVALID','Milvus search missing results');
     return rows.map(row=>{
       const record=ownedRecord(row,binding);
       const score=row.score;
       if(typeof score!=='number'||!Number.isFinite(score)) throw new ReadError('S05_SCORE_INVALID','Invalid search score');
       return {...record,score};
     });
   }
 });
}
