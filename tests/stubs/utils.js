export function getStringHash(str=''){ let h=0; for (let i=0;i<str.length;i++) h=((h<<5)-h)+str.charCodeAt(i)|0; return h; }
export function uuidv4(){ return '00000000-0000-4000-8000-000000000000'; }
export function waitUntilCondition(){ return Promise.resolve(true); }
export function onlyUnique(value,index,array){ return array.indexOf(value)===index; }
