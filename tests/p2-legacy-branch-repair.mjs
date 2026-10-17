/** P2 #59: repair only the fork's VectHare identity after opt-in. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const code=fs.readFileSync(new URL('../core/chat-identity-ledger.js',import.meta.url),'utf8')
 .replace(/^import .*?;\s*$/gm,'').replace(/^export /gm,'');
const state={file:'main',scope:8,metadata:{integrity:'copied'},extensions:{vecthare:{}},writes:0,fail:false};
const context={console,Date,Error,String,globalThis:null,
 extension_settings:state.extensions,chat_metadata:state.metadata,
 getCurrentChatId:()=>state.file,
 getContext:()=>({characterId:state.scope,chatMetadata:state.metadata,
  async saveMetadata(){if(state.fail)throw new Error('save denied');state.writes++;}}),
 saveVectHareSettingsDebounced(){}
};
context.globalThis={crypto:{randomUUID:()=>`repaired-${state.writes+1}`}};
const ctx=vm.createContext(context);vm.runInContext(code,ctx);
assert.equal(ctx.recordCurrentChatIdentity().verified,true);
state.file='branch';
assert.equal(ctx.recordCurrentChatIdentity().verified,false);
let result=await ctx.repairCurrentLegacyBranchIdentity({confirm:async()=>false});
assert.equal(result.cancelled,true);assert.equal(state.metadata.vecthare_instance_uuid,undefined);
state.fail=true;
await assert.rejects(ctx.repairCurrentLegacyBranchIdentity({confirm:async()=>true}),/did not acknowledge/);
assert.equal(state.metadata.vecthare_instance_uuid,undefined);
state.fail=false;
result=await ctx.repairCurrentLegacyBranchIdentity({confirm:async()=>true});
assert.equal(result.pending,true);
assert.equal(state.metadata.integrity,'copied','host integrity must remain untouched');
assert.equal(ctx.recordCurrentChatIdentity().verified,false,'writer quarantined until reopen');
assert.equal(ctx.confirmReopenedLegacyBranchIdentity().verified,false,'same-session event is not a real reopen');
state.file='main';ctx.observeChatIdentityTransition();
state.file='branch';ctx.observeChatIdentityTransition();
assert.equal(ctx.confirmReopenedLegacyBranchIdentity().verified,true);
assert.equal(ctx.recordCurrentChatIdentity().verified,true);
assert.equal(Object.keys(state.extensions.vecthare.chatCollectionBindings||{}).length,0);
assert.equal(state.extensions.vecthare.vecthare_collection_registry,undefined);
// SillyTavern 1.19+ inherits arbitrary custom metadata but refreshes its
// integrity UUID on branching: parent VectHare override must be ignored.
state.file='new-modern-branch';state.metadata.integrity='fresh-host-id';
assert.equal(ctx.recordCurrentChatIdentity().verified,true);
assert.ok(state.extensions.vecthare.chatIdentityLedger['fresh-host-id']);

console.log('PASS legacy copied branch repair requires consent, acknowledged metadata save and reopened identity, without creating vectors');
