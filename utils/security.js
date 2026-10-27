/** Redact outgoing diagnostic/report data only; never alter request credentials. */
const KEY_RE = /(?:api[_-]?key|authorization|access[_-]?token|token|secret|password|passwd|credential|bearer|client[_-]?secret|private[_-]?key|auth[_-]?token)/i;
const MASK='[REDACTED]';
function scrubString(value) {
    return value
        .replace(/(\b(?:Bearer|Basic)\s+)[A-Za-z0-9+/._~=-]+/gi, `$1${MASK}`)
        .replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, `$1${MASK}@`)
        .replace(/([?&](?:api[_-]?key|token|access_token|secret|password|auth|key)=)[^&#\s]+/gi, `$1${MASK}`)
        .replace(/("?(?:api[_-]?key|token|password|secret|authorization)"?\s*[:=]\s*["']?)[^\s"',}]+/gi, `$1${MASK}`);
}
export function redactSecrets(value,{mask=MASK,maxDepth=16}={}) {
    const seen=new WeakSet();
    function walk(v,depth) {
        if(typeof v==='string') return scrubString(v).replaceAll(MASK,mask);
        if(!v || typeof v!=='object') return v;
        if(depth>=maxDepth) return '[TRUNCATED]';
        if(seen.has(v)) return '[CIRCULAR]';seen.add(v);
        if(v instanceof Error) return {name:v.name,message:walk(v.message,depth+1)};
        if(Array.isArray(v)) return v.map(x=>walk(x,depth+1));
        const result={};
        for(const [key,item] of Object.entries(v)) result[key]=KEY_RE.test(key)?mask:walk(item,depth+1);
        return result;
    }
    return walk(value,0);
}
export function redactError(error) {return redactSecrets(error instanceof Error?error:{message:String(error)});}
