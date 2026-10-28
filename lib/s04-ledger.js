/** S04: per-user durable, fail-closed operation receipts. Not a claim of host
 * durability until filesystem and crash testing on the actual host completes. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { OperationError } from './s04-contract.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha=x=>createHash('sha256').update(x).digest('hex');
const phases={PREPARED:['SUBMITTED','FAILED'],SUBMITTED:['VERIFIED','UNCERTAIN'],UNCERTAIN:['VERIFIED','UNCERTAIN'],VERIFIED:[],FAILED:[]};
const MAX=512*1024;
async function fsyncDir(dir) {const h=await fs.open(dir,'r');try{await h.sync();}finally{await h.close();}}
async function requirePrivateDir(dir) {
    const st=await fs.lstat(dir);
    if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077)) throw new OperationError('S04_LEDGER_DIR_UNTRUSTED','Operation store must be private and nonsymlinked');
}
export class OperationLedger {
    constructor(context) {
        if (!context?.vectorsPath || !path.isAbsolute(context.vectorsPath) || !context.userScopeId) {
            throw new OperationError('S04_LEDGER_SCOPE_INVALID','Trusted context is required');
        }
        this.context=context;
        this.root=path.join(context.vectorsPath,'.similharity','s04-operations');
    }
    async setup() {
        // Require validated S03 context; refuse symlinked app-specific paths.
        await requirePrivateDir(this.context.vectorsPath);
        const parent=path.dirname(this.root);
        try { await fs.mkdir(parent,{mode:0o700}); } catch(e) { if(e.code!=='EEXIST') throw e; }
        await requirePrivateDir(parent);
        try { await fs.mkdir(this.root,{mode:0o700}); } catch(e) { if(e.code!=='EEXIST') throw e; }
        await requirePrivateDir(this.root);
    }
    location(id){
        if(typeof id!=='string'||!UUID.test(id)) throw new OperationError('S04_OPERATION_ID_INVALID','Invalid operation ID',400);
        return path.join(this.root,id.toLowerCase()+'.json');
    }
    async lock(key, callback) {
        await this.setup();
        if(typeof key!=='string'|| !/^[a-f0-9]{64}$/.test(key)) throw new OperationError('S04_LOCK_ID_INVALID','Invalid lock key');
        const dir=path.join(this.root,'.lock-'+key);
        try {await fs.mkdir(dir,{mode:0o700});}
        catch (e) {if (e.code==='EEXIST') throw new OperationError('S04_OPERATION_BUSY','Another operation holds the lock');throw e;}
        try{return await callback();}finally{await fs.rmdir(dir);}
    }
    async withRecordLock(plan,callback) {
        return this.lock(sha(JSON.stringify([plan.collectionKey,plan.physicalId])),callback);
    }
    async writeNew(plan) {
        return this.lock(sha(plan.operationId),async()=>{
            const filename=this.location(plan.operationId);
            const receipt={schemaVersion:4,operationId:plan.operationId,owner:this.context.userScopeId,
                plan,state:'PREPARED',history:[{state:'PREPARED'}]};
            await this.persist(filename,receipt,true);
            return receipt;
        });
    }
    async persist(filename,value,exclusive=false) {
        const copy={...value};delete copy.checksum;
        const payload=JSON.stringify(copy);
        if(Buffer.byteLength(payload)>MAX)throw new OperationError('S04_LEDGER_TOO_LARGE','Receipt too large');
        const data=JSON.stringify({...copy,checksum:sha(payload)})+'\n';
        if(exclusive){
            const h=await fs.open(filename,'wx',0o600);
            try {await h.writeFile(data);await h.sync();}finally{await h.close();}
        }else{
            const existing=await fs.lstat(filename);
            if(!existing.isFile()||existing.isSymbolicLink()||(existing.mode&0o077))throw new OperationError('S04_LEDGER_UNTRUSTED','Untrusted receipt');
            const tmp=path.join(this.root,'.tmp-'+randomUUID());
            try {
                const h=await fs.open(tmp,'wx',0o600);
                try{await h.writeFile(data);await h.sync();}finally{await h.close();}
                await fs.rename(tmp,filename);
            }finally{await fs.rm(tmp,{force:true});}
        }
        await fsyncDir(this.root);
    }
    async read(id) {
        await this.setup();
        const filename=this.location(id);
        const st=await fs.lstat(filename);
        if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)||st.size>MAX)throw new OperationError('S04_LEDGER_UNTRUSTED','Untrusted receipt');
        let doc;
        try{doc=JSON.parse(await fs.readFile(filename,'utf8'));}catch{throw new OperationError('S04_LEDGER_CORRUPT','Unreadable receipt');}
        const {checksum,...data}=doc;
        if(sha(JSON.stringify(data))!==checksum||data.schemaVersion!==4||data.owner!==this.context.userScopeId||data.operationId!==id.toLowerCase()||
           !Object.hasOwn(phases,data.state)|| !data.plan || data.plan.operationId!==data.operationId||
           data.plan.scope?.userScopeId!==this.context.userScopeId) {
            throw new OperationError('S04_LEDGER_CORRUPT','Invalid receipt integrity or ownership');
        }
        return data;
    }
    async advance(id,newState,info={}) {
        return this.lock(sha(id.toLowerCase()),async()=>{
            const current=await this.read(id);
            if(!phases[current.state].includes(newState)) throw new OperationError('S04_TRANSITION_DENIED','Invalid operation-state transition');
            if(!info||typeof info!=='object'||Array.isArray(info)||Object.keys(info).some(k=>!['code','reason'].includes(k))) {
                throw new OperationError('S04_INFO_INVALID','Only sanitized error codes are permitted');
            }
            const next={...current,state:newState,history:[...current.history,{state:newState,...info}]};
            await this.persist(this.location(id),next);
            return next;
        });
    }
}
