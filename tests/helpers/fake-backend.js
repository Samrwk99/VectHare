/** Deterministic in-memory fault backend. NEVER evidence of a real server contract. */
export class FaultBackend {
  constructor(){this.collections=new Map();this.faults=[];this.history=[];}
  seed(key,ids){this.collections.set(key,new Set(ids.map(String)));}
  queueFault(kind,mode){this.faults.push({kind,mode});}
  next(kind){const at=this.faults.findIndex(f=>f.kind===kind);return at<0?null:this.faults.splice(at,1)[0].mode;}
  ids(key){return [...(this.collections.get(key)||new Set())].sort();}
  async insert(key,ids){
    ids=ids.map(String);this.history.push({kind:'insert',key,ids});const mode=this.next('insert');
    if(mode==='reject')return {status:'failed'};
    if(mode==='throw-precommit')throw Error('transport failed before commit');
    const dest=this.collections.get(key)||new Set();this.collections.set(key,dest);
    for(const id of (mode==='partial'?ids.slice(0,1):ids))dest.add(id);
    if(mode==='commit-lost-ack')throw Error('ACK lost after commit');
    if(mode==='partial')return {status:'uncertain',accepted:1};
    if(mode==='ambiguous-200')return {status:'uncertain'};
    return {status:'confirmed',accepted:ids.length};
  }
  async verify(key,ids){this.history.push({kind:'verify',key,ids});const mode=this.next('verify');
    if(mode==='throw')throw Error('inventory timed out');
    if(mode==='incomplete')return {complete:false,ids:this.ids(key)};
    if(mode==='cross-tenant')return {complete:false,scope:'wrong-tenant',ids:this.ids(key)};
    return {complete:true,scope:key,ids:this.ids(key)};
  }
  async remove(key,ids){ids=ids.map(String);this.history.push({kind:'remove',key,ids});const mode=this.next('remove');
    if(mode==='reject')return {status:'failed'};
    if(mode==='throw-precommit')throw Error('remove transport failed');
    const target=this.collections.get(key)||new Set();for(const id of (mode==='partial'?ids.slice(0,1):ids))target.delete(id);
    if(mode==='commit-lost-ack')throw Error('remove committed but ACK lost');
    if(mode==='partial'||mode==='ambiguous-200')return {status:'uncertain'};
    return {status:'confirmed',deleted:ids.length};
  }
  async purge(key){this.history.push({kind:'purge',key});const mode=this.next('purge');
    if(mode==='reject')return {status:'failed'};
    this.collections.delete(key);
    if(mode==='commit-lost-ack')throw Error('purge ACK lost');
    return mode==='ambiguous-200'?{status:'uncertain'}:{status:'confirmed'};
  }
}
