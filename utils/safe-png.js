/** Defensive PNG parser for untrusted uploads. Hard caps apply before allocations. */
export const MAX_PNG_BYTES=32*1024*1024;
export const MAX_PNG_CHUNK_BYTES=12*1024*1024;
export const MAX_PNG_TEXT_BYTES=16*1024*1024;
const SIGNATURE=[137,80,78,71,13,10,26,10];
let crcTable;
function crc32(bytes){
    if(!crcTable) crcTable=Uint32Array.from({length:256},(_,i)=>{let c=i;for(let j=0;j<8;j++)c=(c&1)?0xedb88320^(c>>>1):(c>>>1);return c>>>0;});
    let crc=0xffffffff;
    for(const b of bytes)crc=crcTable[(crc^b)&255]^(crc>>>8);
    return (crc^0xffffffff)>>>0;
}
export function parseSafePng(bytes){
    if(!(bytes instanceof Uint8Array) || bytes.length<20 || bytes.length>MAX_PNG_BYTES) throw new Error('PNG exceeds safe size or is truncated');
    if(!SIGNATURE.every((b,i)=>bytes[i]===b)) throw new Error('Invalid PNG signature');
    let offset=8;const chunks=[];let ended=false;
    while(offset<bytes.length){
        if(offset+12>bytes.length)throw new Error('Truncated PNG chunk header');
        const view=new DataView(bytes.buffer,bytes.byteOffset+offset,12+Math.min(bytes.length-offset-12,MAX_PNG_CHUNK_BYTES));
        const length=view.getUint32(0,false);
        if(length>MAX_PNG_CHUNK_BYTES || length>bytes.length-offset-12)throw new Error('Invalid PNG chunk length');
        const typeBytes=bytes.subarray(offset+4,offset+8);
        if(!typeBytes.every(b=>(b>=65&&b<=90)||(b>=97&&b<=122)))throw new Error('Invalid PNG chunk type');
        const type=String.fromCharCode(...typeBytes);
        const expected=view.getUint32(8+length,false); // use full-span view below
        const actual=crc32(bytes.subarray(offset+4,offset+8+length));
        if(expected!==actual)throw new Error('PNG CRC mismatch');
        chunks.push({type,data:bytes.subarray(offset+8,offset+8+length),offset});
        offset+=length+12;
        if(type==='IEND'){if(length!==0)throw new Error('Invalid IEND');ended=true;break;}
    }
    if(!ended || offset!==bytes.length)throw new Error('Invalid PNG terminator');
    return chunks;
}
/** Stream with a decompressed byte ceiling; rejected bombs do not buffer unbounded data. */
export async function readLimitedStream(stream,maxBytes=MAX_PNG_TEXT_BYTES){
    const reader=stream.getReader();const parts=[];let length=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>maxBytes)throw new Error('Decompressed PNG text exceeds safe limit');parts.push(value);}}
    catch(error){await reader.cancel().catch(()=>{});throw error;}
    finally{reader.releaseLock();}
    const out=new Uint8Array(length);let off=0;for(const part of parts){out.set(part,off);off+=part.byteLength;}return out;
}
