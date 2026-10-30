/** P-B.7 — Source-first managed lorebook edit.
 * The host owns the saved World Info source; the plugin reopens that source
 * and M1 generates the replacement embedding. Browser text is NEVER sent to M1.
 * No physical vector mutation is performed before a confirmed host save.
 */
const HASH=/^[a-f0-9]{64}$/i;
export function locateSavedLorebookEntry(world,uid,previousText){
 if(!world||typeof world!=='object'||!world.entries||typeof world.entries!=='object'||
  !Number.isSafeInteger(uid)||uid<0||typeof previousText!=='string')
  throw Error('PB7_LORE_IDENTITY_INVALID');
 const found=Object.values(world.entries).filter(entry=>entry&&typeof entry==='object'&&entry.uid===uid);
 if(found.length!==1)throw Error('PB7_LORE_UID_AMBIGUOUS');
 if(found[0].disable===true)throw Error('PB7_LORE_ENTRY_DISABLED');
 if(found[0].content!==previousText)throw Error('PB7_LORE_CONTENT_CHANGED');
 return found[0];
}
export async function commitSavedLorebookTextEdit({source,uid,previousText,newText,recordId,
 expectedFingerprint,loadWorldInfo,saveWorldInfo,getSource,checkBeforeSave,readAfterSave,
 plan,apply,verify,confirm}={}){
 if(source?.kind!=='lorebook'||typeof source.name!=='string'||!source.name.trim()||
  typeof loadWorldInfo!=='function'||typeof saveWorldInfo!=='function'||
  typeof getSource!=='function'||typeof checkBeforeSave!=='function'||
  typeof readAfterSave!=='function'||typeof plan!=='function'||typeof apply!=='function'||
  typeof verify!=='function'||typeof confirm!=='function'||!recordId||
  !HASH.test(expectedFingerprint??'')||!Number.isSafeInteger(uid)||uid<0||
  typeof newText!=='string'||!newText.trim()||newText.length>8192||
  newText===previousText)throw Error('PB7_LORE_EDIT_INVALID');
 const identity=JSON.stringify(source);
 const assertSource=async()=>{
  if(JSON.stringify(await getSource())!==identity)throw Error('PB7_LORE_SOURCE_SWITCHED');
 };
 await assertSource();
 await checkBeforeSave({recordId,expectedFingerprint,previousText,uid});
 await assertSource();
 if(!await confirm())return {status:'CANCELLED',sourceSaved:false};
 await assertSource();
 const world=await loadWorldInfo(source.name);
 const entry=locateSavedLorebookEntry(world,uid,previousText);
 // Avoid modifying a cached World Info object before the save is accepted.
 // The host writes the complete world, preserving other entries and metadata.
 const edited=structuredClone(world);
 locateSavedLorebookEntry(edited,uid,previousText).content=newText;
 await checkBeforeSave({recordId,expectedFingerprint,previousText,uid});
 await assertSource();
 try{
  const result=await saveWorldInfo(source.name,edited,true);
  if(result===false)throw Error('PB7_HOST_SAVE_REFUSED_OR_UNCERTAIN');
 }catch(err){
  const uncertain=new Error(`PB7_LORE_SAVE_OUTCOME_UNCERTAIN: ${err?.message||err}`);
  uncertain.code='PB7_LORE_SAVE_OUTCOME_UNCERTAIN';uncertain.sourceSaveUncertain=true;
  throw uncertain;
 }
 try{
  await assertSource();
  const current=await readAfterSave(recordId);
  if(!HASH.test(current?.fileFingerprint??'')||current.fileFingerprint===expectedFingerprint||
   current.row?.lorebookUid!==uid||current.row?.savedText!==newText||
   current.row?.savedTextTruncated||current.row?.physicalState!=='VERIFIED'||
   !current.row?.availableActions?.includes('update'))
   throw Error('PB7_LORE_SAVED_SOURCE_NOT_READY_FOR_UPDATE');
  // M1 re-reads and embeds *server-owned bytes*, with a pinned file hash.
  const ticket=await plan(current.fileFingerprint);
  await assertSource();
  const receipt=await apply(ticket.operationId);
  if(receipt?.state!=='VERIFIED')throw Error('PB7_M1_RECEIPT_UNVERIFIED');
  await verify(recordId);
  await assertSource();
  return {status:'VERIFIED',sourceSaved:true,operationId:receipt.operationId};
 }catch(err){
  const incomplete=new Error(`PB7_LORE_SAVED_VECTOR_NOT_VERIFIED: ${err?.message||err}`);
  incomplete.code='PB7_LORE_SAVED_VECTOR_NOT_VERIFIED';incomplete.sourceSaved=true;
  throw incomplete;
 }
}
