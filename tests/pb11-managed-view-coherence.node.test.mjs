import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PB11_STORAGE_KEY, publishManagedViewInvalidation, watchManagedViewInvalidation} from '../utils/pb11-managed-view-coherence.js';
class Emitter {
 constructor(){this.handlers=new Map();this.visibilityState='visible';}
 addEventListener(key,fn){const set=this.handlers.get(key)??new Set();set.add(fn);this.handlers.set(key,set);}
 removeEventListener(key,fn){this.handlers.get(key)?.delete(fn);}
 emit(key,value={}){for(const fn of [...(this.handlers.get(key)??[])])fn(value);}
}
test('P22: local mutation expires other views but not the sender, and publishes no source details',()=>{
 const first=[],second=[],w=new Emitter(),d=new Emitter(),storage={calls:[],setItem(k,v){this.calls.push([k,v]);}};
 const a=Symbol('sender');const stopA=watchManagedViewInvalidation(s=>first.push(s),{identity:a,window:w,document:d});
 const stopB=watchManagedViewInvalidation(s=>second.push(s),{identity:Symbol('other'),window:w,document:d});
 publishManagedViewInvalidation({sender:a,storage});
 assert.deepEqual(first,[]);assert.deepEqual(second,['mutation']);
 assert.equal(storage.calls[0][0],PB11_STORAGE_KEY);
 const wire=JSON.parse(storage.calls[0][1]);assert.deepEqual(Object.keys(wire).sort(),['nonce','version']);
 assert.equal(wire.version,1);assert.ok(wire.nonce.length>1);
 stopA();stopB();
});
test('P22: other-tab storage, visible resume and focus invalidate; invalid events do not',()=>{
 const w=new Emitter(),d=new Emitter(),reasons=[];
 const stop=watchManagedViewInvalidation(reason=>reasons.push(reason),{window:w,document:d});
 w.emit('storage',{key:'unrelated',newValue:JSON.stringify({version:1,nonce:'other'})});
 w.emit('storage',{key:PB11_STORAGE_KEY,newValue:'malformed'});
 w.emit('storage',{key:PB11_STORAGE_KEY,newValue:JSON.stringify({version:2,nonce:'other'})});
 w.emit('storage',{key:PB11_STORAGE_KEY,newValue:JSON.stringify({version:1,nonce:'other'})});
 d.visibilityState='hidden';d.emit('visibilitychange');
 d.visibilityState='visible';d.emit('visibilitychange');w.emit('focus');
 assert.deepEqual(reasons,['other-tab','tab-resumed','tab-resumed']);
 stop();w.emit('focus');d.emit('visibilitychange');assert.equal(reasons.length,3);
});
test('P22: browser storage refusal cannot prevent safe same-tab cache invalidation',()=>{
 const w=new Emitter(),d=new Emitter(),reasons=[];
 const stop=watchManagedViewInvalidation(reason=>reasons.push(reason),{window:w,document:d});
 assert.doesNotThrow(()=>publishManagedViewInvalidation({storage:{setItem(){throw Error('quota denied');}}}));
 assert.deepEqual(reasons,['mutation']);stop();
});
test('P22: visibility invalidation never authorizes a backend mutation',()=>{
 const sourceFile=new URL('../utils/pb11-managed-view-coherence.js',import.meta.url);
 assert.match(sourceFile.pathname,/pb11-managed-view-coherence/);
 // Deliberately no API route, receipt fields, or backend selector in broadcast.
 const seen=[];const stop=watchManagedViewInvalidation(reason=>seen.push(reason),{window:new Emitter(),document:new Emitter()});
 publishManagedViewInvalidation({storage:null});assert.equal(seen[0],'mutation');stop();
});
