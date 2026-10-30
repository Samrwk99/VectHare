/** P-B.5: saved-chat-first managed record text editing.
 * This module NEVER posts browser-supplied text to the vector backend. Instead
 * it persists the host's chat, re-reads that chat from the authenticated plugin,
 * and asks M1 to embed the bytes that the server just read itself.
 */
const LOCATOR_KEYS=['sendDate','name','isUser'];
export function locateSavedChatMessage(chat, locator, previousText){
 if(!Array.isArray(chat)||!locator||typeof locator!=='object'||
    Object.keys(locator).sort().join('|')!==LOCATOR_KEYS.slice().sort().join('|')||
    (typeof locator.sendDate!=='string'&&typeof locator.sendDate!=='number')||
    typeof locator.name!=='string'||typeof locator.isUser!=='boolean'||
    typeof previousText!=='string')throw Error('PB5_CHAT_IDENTITY_INVALID');
 const found=chat.filter(m=>m&&m.is_system!==true&&m.extra?.is_system!==true&&
  String(m.send_date)===String(locator.sendDate)&&m.name===locator.name&&m.is_user===locator.isUser);
 if(found.length!==1)throw Error('PB5_CHAT_MESSAGE_AMBIGUOUS');
 if(found[0].mes!==previousText)throw Error('PB5_CHAT_MESSAGE_CHANGED');
 return found[0];
}
/** Atomicity boundary: the host chat save happens BEFORE the vector write. A
 * failure after host acceptance reports `sourceSaved:true` so the user can
 * invoke Repair, not retry or roll back a potentially durable chat save.
 */
export async function commitSavedChatTextEdit({source,locator,previousText,newText,recordId,
 expectedFingerprint,context,getSource,checkBeforeSave,readAfterSave,plan,apply,verify,confirm}={}){
 if(!['chat','group-chat'].includes(source?.kind)||typeof context?.saveChat!=='function'||
  !Array.isArray(context?.chat)||!recordId||!/^([a-f0-9]{64})$/i.test(expectedFingerprint??'')||
  typeof newText!=='string'||!newText.trim()||newText.length>8192||newText===previousText)
  throw Error('PB5_CHAT_EDIT_INVALID');
 const identity=JSON.stringify(source);
 const assertSource=async()=>{if(JSON.stringify(await getSource())!==identity)throw Error('PB5_SOURCE_SWITCHED');};
 await assertSource();
 const target=locateSavedChatMessage(context.chat,locator,previousText);
 // Source revision AND current registry/physical state rechecked before save.
 await checkBeforeSave({recordId,expectedFingerprint,previousText});
 await assertSource();
 if(!await confirm())return {status:'CANCELLED',sourceSaved:false};
 await assertSource();locateSavedChatMessage(context.chat,locator,previousText);
 // A throwing host-save API is an UNKNOWN outcome (it may have written the
 // chat before failing). Never restore the in-memory old text or claim no save.
 target.mes=newText;
 try{
  const result=await context.saveChat();
  if(result===false)throw Error('PB5_HOST_SAVE_REFUSED_OR_UNCERTAIN');
 }catch(err){
  const uncertain=new Error(`PB5_HOST_SAVE_OUTCOME_UNCERTAIN: ${err?.message||err}`);
  uncertain.code='PB5_HOST_SAVE_OUTCOME_UNCERTAIN';uncertain.sourceSaveUncertain=true;
  throw uncertain;
 }

 try{
  await assertSource();
  const current=await readAfterSave(recordId);
  if(current.fileFingerprint===expectedFingerprint||current.row?.savedText!==newText||
    current.row?.savedTextTruncated||!current.row?.availableActions?.includes('update')||
    current.row?.physicalState!=='VERIFIED')throw Error('PB5_SAVED_SOURCE_NOT_READY_FOR_UPDATE');
  // The M1 plan re-reads the same server-owned saved file, matches this
  // fingerprint and checks the current registry and physical revision.
  const ticket=await plan(current.fileFingerprint);
  await assertSource();
  const receipt=await apply(ticket.operationId);
  if(receipt?.state!=='VERIFIED')throw Error('PB5_M1_RECEIPT_UNVERIFIED');
  await verify(recordId);
  await assertSource();
  return {status:'VERIFIED',sourceSaved:true,operationId:receipt.operationId};
 }catch(err){
  const wrapped=new Error(`PB5_CHAT_SAVED_VECTOR_NOT_VERIFIED: ${err?.message||err}`);
  wrapped.code='PB5_CHAT_SAVED_VECTOR_NOT_VERIFIED';wrapped.sourceSaved=true;
  throw wrapped;
 }
}
