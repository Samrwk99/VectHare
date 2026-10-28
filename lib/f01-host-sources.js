/** F01 — authenticated, file-backed SillyTavern source attestation.
 * Selection is client supplied; authorization comes ONLY from req.user directories
 * and fresh server-side filesystem inspection. No vector execution is enabled.
 * A chat's first-line integrity is advisory: branches may duplicate it.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {AccessError,trustedUserId} from './s03-security.js';
import {canonicalScope} from './s02-identity.js';

const REGISTRY='f01-host-sources.json', ANCHOR='f01-host-sources.initialized', LOCK='f01-host-sources.lock';
const MAX_REGISTRY=4*1024*1024, MAX_ENTRIES=10000, MAX_HEADER=65536;
const hash=value=>createHash('sha256').update(value).digest('hex');
const refusal=(code,message,status=409)=>new AccessError(code,message,status);
function safeSegment(value){
    if(typeof value!=='string'||!value||value.length>220||value!==value.trim()||
       value==='.'||value==='..'||/[\\/\0\r\n\x00-\x1f]/u.test(value)||/[. ]$/u.test(value)||
       /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value)||
       value.includes(':'))throw refusal('F01_INVALID_SELECTOR','Invalid source selector',400);
    return value;
}
function exactKeys(input,allowed){
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!allowed.includes(k)))
        throw refusal('F01_INVALID_SELECTOR','Unexpected source selector fields',400);
}
function selector(input){
    exactKeys(input,['kind','chatFile','avatar','name','groupId']);
    const kind=input.kind;
    if(kind==='chat'){
        if(input.name!==undefined||input.groupId!==undefined)throw refusal('F01_INVALID_SELECTOR','Unexpected chat selector',400);
        const avatar=safeSegment(input.avatar);
        if(!avatar.endsWith('.png'))throw refusal('F01_INVALID_SELECTOR','Character avatar filename required',400);
        const characterFolder=avatar.slice(0,-4);
        safeSegment(characterFolder);
        const chatFile=safeSegment(input.chatFile);
        return {kind,category:'chats',relative:path.join(characterFolder,`${chatFile}.jsonl`),characterFolder,chatFile};
    }
    if(kind==='group-chat'){
        if(input.avatar!==undefined||input.name!==undefined)throw refusal('F01_INVALID_SELECTOR','Unexpected group selector',400);
        const chatFile=safeSegment(input.chatFile),groupId=safeSegment(input.groupId);
        return {kind,category:'groupChats',relative:`${chatFile}.jsonl`,chatFile,groupId};
    }
    if(kind==='lorebook'){
        if(input.avatar!==undefined||input.chatFile!==undefined||input.groupId!==undefined)throw refusal('F01_INVALID_SELECTOR','Unexpected lorebook selector',400);
        const name=safeSegment(input.name);
        return {kind,category:'worlds',relative:`${name}.json`,name};
    }
    throw refusal('F01_KIND_UNSUPPORTED','No trusted host source adapter for this kind',409);
}
function under(root,full){const rel=path.relative(root,full);return !!rel&&!rel.startsWith(`..${path.sep}`)&&rel!=='..'&&!path.isAbsolute(rel);}
async function inspectOwnedFile(req,input){
    const spec=selector(input);
    const dirs=req.user?.directories;
    const declared=dirs?.[spec.category];
    if(typeof declared!=='string'||!declared.trim())throw refusal('F01_HOST_DIRECTORY_UNAVAILABLE','Host did not supply source directory');
    const base=path.resolve(declared);
    const userRoot=typeof dirs?.root==='string'&&dirs.root.trim() ? dirs.root : path.dirname(req.s03.vectorsPath);
    if(typeof userRoot==='string'&&userRoot.trim()){
        const realUserRoot=await fs.realpath(path.resolve(userRoot)).catch(()=>{throw refusal('F01_HOST_DIRECTORY_UNAVAILABLE','User root unavailable');});
        if(!under(realUserRoot,base))throw refusal('F01_SOURCE_OUTSIDE_USER_ROOT','Source directory outside host user root');
    }
    // Explicitly reject directory symlinks. This is stricter than ordinary ST
    // behavior, but avoids resolving a nominal user folder to another account.
    const baseStat=await fs.lstat(base).catch(()=>{throw refusal('F01_HOST_DIRECTORY_UNAVAILABLE','Source directory unavailable');});
    if(!baseStat.isDirectory()||baseStat.isSymbolicLink())throw refusal('F01_SOURCE_LINK_REJECTED','Source directory is not regular');
    const realBase=await fs.realpath(base);
    if(typeof userRoot==='string'&&userRoot.trim()){
        const realUserRoot=await fs.realpath(path.resolve(userRoot));
        if(!under(realUserRoot,realBase))throw refusal('F01_SOURCE_OUTSIDE_USER_ROOT','Source directory escapes user root');
    }
    const filepath=path.resolve(base,spec.relative);
    if(!under(realBase,filepath))throw refusal('F01_SOURCE_PATH_ESCAPE','Source escapes user directory',400);
    if(spec.kind==='chat'){
        const folder=path.join(base,spec.characterFolder);
        const s=await fs.lstat(folder).catch(()=>{throw refusal('F01_SOURCE_NOT_FOUND','Chat character directory not found',404);});
        if(!s.isDirectory()||s.isSymbolicLink())throw refusal('F01_SOURCE_LINK_REJECTED','Character chat folder is not regular');
    }
    // Solo-chat authorization requires the matching user-owned character
    // avatar: orphan folders alone are not proof of an active character.
    if(spec.kind==='chat'){
        const avatars=dirs?.characters;
        if(typeof avatars!=='string'||!avatars.trim())throw refusal('F01_HOST_DIRECTORY_UNAVAILABLE','Character directory unavailable');
        const avatarRoot=path.resolve(avatars);
        const avatarRootStat=await fs.lstat(avatarRoot).catch(()=>{throw refusal('F01_CHARACTER_UNVERIFIED','Character directory unavailable');});
        if(!avatarRootStat.isDirectory()||avatarRootStat.isSymbolicLink()||
           !under(await fs.realpath(path.resolve(userRoot)),await fs.realpath(avatarRoot)))
            throw refusal('F01_SOURCE_OUTSIDE_USER_ROOT','Character directory outside user root');
        const avatarPath=path.join(avatarRoot,`${spec.characterFolder}.png`);
        const a=await fs.lstat(avatarPath).catch(()=>{throw refusal('F01_CHARACTER_UNVERIFIED','Character avatar does not exist');});
        if(!a.isFile()||a.isSymbolicLink()||a.nlink>1)throw refusal('F01_CHARACTER_UNVERIFIED','Character avatar cannot be verified');
        if(!under(await fs.realpath(avatarRoot),await fs.realpath(avatarPath)))throw refusal('F01_CHARACTER_UNVERIFIED','Character avatar is outside user directory');
    }
    // A group chat must be listed in an actual group owned by this user.
    if(spec.kind==='group-chat'){
        const groups=dirs?.groups;
        if(typeof groups!=='string'||!groups.trim())throw refusal('F01_HOST_DIRECTORY_UNAVAILABLE','Group directory unavailable');
        const groupsRoot=path.resolve(groups);
        const groupRootStat=await fs.lstat(groupsRoot).catch(()=>{throw refusal('F01_GROUP_UNVERIFIED','Group directory unavailable');});
        if(!groupRootStat.isDirectory()||groupRootStat.isSymbolicLink()||
           !under(await fs.realpath(path.resolve(userRoot)),await fs.realpath(groupsRoot)))
            throw refusal('F01_SOURCE_OUTSIDE_USER_ROOT','Group directory outside user root');
        const groupPath=path.join(groupsRoot,`${spec.groupId}.json`);
        const gs=await fs.lstat(groupPath).catch(()=>{throw refusal('F01_GROUP_UNVERIFIED','Group record not found');});
        if(!gs.isFile()||gs.isSymbolicLink()||gs.size>2*1024*1024)throw refusal('F01_GROUP_UNVERIFIED','Group record invalid');
        let group;
        try{group=JSON.parse(await fs.readFile(groupPath,'utf8'));}catch{throw refusal('F01_GROUP_UNVERIFIED','Group record invalid');}
        if(String(group?.id)!==spec.groupId||!Array.isArray(group.chats)||!group.chats.includes(spec.chatFile))
            throw refusal('F01_GROUP_UNVERIFIED','Chat not listed in authenticated group');
    }
    const st=await fs.lstat(filepath).catch(()=>{throw refusal('F01_SOURCE_NOT_FOUND','Host source file not found',404);});
    if(!st.isFile()||st.isSymbolicLink()||st.nlink>1)throw refusal('F01_SOURCE_LINK_REJECTED','Source is not an independent regular file');
    const resolved=await fs.realpath(filepath);
    if(resolved!==filepath||!under(realBase,resolved))throw refusal('F01_SOURCE_PATH_ESCAPE','Source file escapes user directory');
    // A pre/post stat prevents accepting a path swapped during the inspection.
    let integrity=null, mainChat=null;
    if(spec.kind!=='lorebook'){
        const handle=await fs.open(filepath,'r');
        try{
            const buffer=Buffer.alloc(MAX_HEADER+1);
            const {bytesRead}=await handle.read(buffer,0,buffer.length,0);
            const nl=buffer.subarray(0,bytesRead).indexOf(10);
            const headerEnd=nl>=0?nl:(bytesRead<=MAX_HEADER?bytesRead:-1);
            if(headerEnd<0||headerEnd>MAX_HEADER)throw refusal('F01_CHAT_HEADER_UNVERIFIED','Chat metadata header too large or missing');
            let header;
            try{header=JSON.parse(buffer.subarray(0,headerEnd).toString('utf8'));}catch{throw refusal('F01_CHAT_HEADER_UNVERIFIED','Chat metadata header invalid');}
            if(!header||typeof header.chat_metadata!=='object'||Array.isArray(header.chat_metadata))
                throw refusal('F01_CHAT_HEADER_UNVERIFIED','Chat metadata header absent');
            const md=header.chat_metadata;
            if(md.integrity!==undefined&&md.integrity!==null){
                if(typeof md.integrity!=='string'||md.integrity.length>256)throw refusal('F01_CHAT_HEADER_UNVERIFIED','Invalid chat integrity');
                integrity=md.integrity;
            }
            if(md.main_chat!==undefined&&md.main_chat!==null){
                if(typeof md.main_chat!=='string'||md.main_chat.length>256)throw refusal('F01_CHAT_HEADER_UNVERIFIED','Invalid branch parent');
                mainChat=md.main_chat;
            }
        }finally{await handle.close();}
    }
    const after=await fs.lstat(filepath);
    if(!after.isFile()||after.isSymbolicLink()||after.nlink>1||after.dev!==st.dev||after.ino!==st.ino)
        throw refusal('F01_SOURCE_CHANGED','Source changed during verification');
    const locationKey=hash(JSON.stringify([spec.category,spec.relative,spec.groupId??null]));
    const fileKey=st.ino&&Number.isFinite(st.birthtimeMs)&&st.birthtimeMs>0
        ?hash(JSON.stringify([spec.category,String(st.dev),String(st.ino),String(st.birthtimeMs)])) :null;
    return {spec,locationKey,fileKey,integrity,mainChat,filepath,base};
}
function empty(){return {schemaVersion:1,entries:[]};}
async function readRegistry(directory){
    const filename=path.join(directory,REGISTRY);
    let value;
    try{
        const st=await fs.lstat(filename);
        if(!st.isFile()||st.isSymbolicLink()||st.size>MAX_REGISTRY)throw Error('invalid registry file');
        value=JSON.parse(await fs.readFile(filename,'utf8'));
    }catch(err){
        if(err.code==='ENOENT'){
            const anchor=await fs.lstat(path.join(directory,ANCHOR)).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});
            if(anchor)throw refusal('F01_REGISTRY_LOST','Previously initialized source registry is missing');
            return empty();
        }
        throw refusal('F01_REGISTRY_UNVERIFIABLE','Host source registry could not be verified');
    }
    if(value?.schemaVersion!==1||!Array.isArray(value.entries)||value.entries.length>MAX_ENTRIES)
        throw refusal('F01_REGISTRY_UNVERIFIABLE','Invalid registry contents');
    const locations=new Set(), sources=new Set();
    for(const e of value.entries){
        if(!e||!['chat','group-chat','lorebook'].includes(e.kind)||
            !/^[a-f0-9]{64}$/.test(e.locationKey||'')||!/^f01_[0-9a-f-]{36}$/.test(e.sourceId||'')||
            (e.fileKey!==null&& !/^[a-f0-9]{64}$/.test(e.fileKey||''))||
            (e.integrity!==null&&typeof e.integrity!=='string')||
            (e.mainChat!==null&&typeof e.mainChat!=='string')||
            (e.groupId!==null&&typeof e.groupId!=='string')||
            typeof e.relative!=='string'||!['chats','groupChats','worlds'].includes(e.category)||
            hash(JSON.stringify([e.category,e.relative,e.groupId??null]))!==e.locationKey||
            locations.has(e.locationKey)||sources.has(e.sourceId))throw refusal('F01_REGISTRY_UNVERIFIABLE','Invalid or colliding source registry');
        locations.add(e.locationKey); sources.add(e.sourceId);
    }
    return value;
}
async function persist(directory,next){
    const payload=JSON.stringify(next,null,2)+'\n';
    if(Buffer.byteLength(payload)>MAX_REGISTRY)throw refusal('F01_REGISTRY_LIMIT','Source registry limit exceeded');
    const temp=path.join(directory,`.f01-${randomUUID()}.tmp`);
    try{
        const file=await fs.open(temp,'wx',0o600);
        try{await file.writeFile(payload);await file.sync();}finally{await file.close();}
        await fs.rename(temp,path.join(directory,REGISTRY));
        const marker=await fs.open(path.join(directory,ANCHOR),'a',0o600);
        try{await marker.sync();}finally{await marker.close();}
    }finally{await fs.rm(temp,{force:true});}
}
export async function attestHostSource(req,input){
    if(!req.s03?.userScopeId||!req.s03?.vectorsPath||!req.user ||
        trustedUserId(req)!==req.s03.userScopeId || path.resolve(req.user?.directories?.vectors||'')!==path.resolve(req.s03.vectorsPath))
        throw refusal('F01_AUTH_REQUIRED','Trusted host identity required',401);
    const observed=await inspectOwnedFile(req,input);
    const directory=path.join(req.s03.vectorsPath,'.similharity');
    await fs.mkdir(directory,{recursive:true,mode:0o700});
    const lock=path.join(directory,LOCK);
    try{await fs.mkdir(lock,{mode:0o700});}catch(err){if(err.code==='EEXIST')throw refusal('F01_REGISTRY_BUSY','Source registry busy');throw err;}
    try{
        const state=await readRegistry(directory);
        let entry=state.entries.find(x=>x.locationKey===observed.locationKey);
        if(entry){
            if(entry.kind!==observed.spec.kind ||
              (entry.integrity&&observed.integrity&&entry.integrity!==observed.integrity))
                throw refusal('F01_SOURCE_CHANGED','Bound source identity changed; manual review required');
            if(entry.mainChat!==observed.mainChat)
                throw refusal('F01_BRANCH_METADATA_CHANGED','Branch relationship changed; manual review required');
            // Atomic SillyTavern saves may replace inode; path + stable chat
            // metadata remain the source anchor, not mutable inode identity.
        }else{
            // For a rename, preserve the ID only when the old pathname has
            // disappeared AND the strong file identity still matches uniquely.
            const matches=observed.fileKey?state.entries.filter(x=>x.fileKey===observed.fileKey&&x.kind===observed.spec.kind&&x.groupId===(observed.spec.groupId??null)):[];
            if(matches.length>1)throw refusal('F01_AMBIGUOUS_RENAME','Ambiguous source rename');
            if(matches.length===1){
                const candidate=matches[0];
                const oldPath=path.resolve(observed.base,candidate.relative);
                const oldExists=await fs.lstat(oldPath).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});
                if(oldExists)throw refusal('F01_DUPLICATE_FILE_IDENTITY','A source file is shared by multiple paths');
                if(candidate.integrity&&observed.integrity&&candidate.integrity!==observed.integrity)
                    throw refusal('F01_AMBIGUOUS_RENAME','Renamed file metadata differs');
                if(candidate.mainChat!==observed.mainChat)throw refusal('F01_AMBIGUOUS_RENAME','Renamed branch metadata differs');
                entry=candidate;
                entry.locationKey=observed.locationKey;
                entry.relative=observed.spec.relative;
            }else{
                if(state.entries.length>=MAX_ENTRIES)throw refusal('F01_REGISTRY_LIMIT','Source registry capacity reached');
                entry={kind:observed.spec.kind,category:observed.spec.category,relative:observed.spec.relative,
                    locationKey:observed.locationKey,fileKey:observed.fileKey,groupId:observed.spec.groupId??null,sourceId:`f01_${randomUUID()}`,
                    integrity:observed.integrity,mainChat:observed.mainChat};
                state.entries.push(entry);
            }
            await persist(directory,state);
        }
        // Do not leak chat contents, file paths, or other source identities.
        const isChat=entry.kind!=='lorebook';
        const scope=canonicalScope({userScopeId:req.s03.userScopeId,
            collectionId:entry.sourceId,type:isChat?'chat':'lore',sourceId:entry.sourceId,
            ...(isChat&&entry.mainChat ? {branchId:entry.sourceId}:{})});
        const duplicateIntegrity=!!entry.integrity && state.entries.some(x=>x.sourceId!==entry.sourceId&&x.integrity===entry.integrity);
        return {schemaVersion:1,status:'HOST_FILE_OWNED',scope,
            sourceId:entry.sourceId,kind:entry.kind,isBranch:isChat&&!!entry.mainChat,
            copiedIntegrityObserved:duplicateIntegrity,
            hostSourceOwnerVerified:true,activeChatVerified:false,
            publicReadsEnabled:false,publicWritesEnabled:false,
            sourceBinding:'PERSISTED_PER_USER_FILE_MAPPING',
            limitations:['host-active-chat-not-authenticated','backend-record-contract-not-certified']};
    }finally{await fs.rmdir(lock);}
}
export function registerF01HostRoutes(router){
    router.post('/v2/sources/attest',async(req,res)=>{
        try{
            const result=await attestHostSource(req,req.body);
            res.json({success:true,...result});
        }catch(error){
            res.status(error.status||409).json({success:false,code:error.code||'F01_ATTESTATION_FAILED',
                error:'Source ownership could not be verified',publicReadsEnabled:false,publicWritesEnabled:false});
        }
    });
}

/** Internal trusted-file helper for F09b. Never expose the returned path on the HTTP wire. */
export async function inspectF01OwnedFile(req,input){
 return inspectOwnedFile(req,input);
}
