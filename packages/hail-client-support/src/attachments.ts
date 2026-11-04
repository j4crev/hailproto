export type AttachmentMetadata={filename:string;media_type:'application/pdf'|'text/plain'|'image/png'|'image/jpeg'|'image/webp';size:number;digest:{algorithm:'sha-256';value:string}};
/** Browser-safe diagnostic metadata checks; providers independently validate codec payloads and bytes. */
export function parseAttachments(value:unknown):AttachmentMetadata[]{
  const invalid=():never=>{throw new Error('Invalid attachments');};
  const object=(v:unknown,keys:string[]):Record<string,unknown>=>{
    if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||!keys.every(k=>Object.hasOwn(v,k)))invalid();
    return v as Record<string,unknown>;
  };
  if(!Array.isArray(value)||value.length>20)return invalid();
  let total=0;
  for(const entry of value){
    const file=object(entry,['filename','media_type','size','digest']),name=file.filename;
    if(typeof name!=='string'||name.normalize('NFC')!==name||/[\uD800-\uDFFF]/u.test(name)||new TextEncoder().encode(name).length>255||/[\\/\x00-\x1f\x7f]/.test(name)||!/^[^.].*\.(pdf|txt|log|png|jpg|jpeg|webp)$/i.test(name))return invalid();
    const media=/\.pdf$/i.test(name)?'application/pdf':/\.png$/i.test(name)?'image/png':/\.jpe?g$/i.test(name)?'image/jpeg':/\.webp$/i.test(name)?'image/webp':'text/plain';
    if(file.media_type!==media||typeof file.size!=='number'||!Number.isSafeInteger(file.size)||file.size<1)return invalid();
    total+=file.size;
    const digest=object(file.digest,['algorithm','value']);
    // A 32-byte digest has 43 unpadded base64url characters, with two zero pad bits.
    if(digest.algorithm!=='sha-256'||typeof digest.value!=='string'||!/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(digest.value))return invalid();
  }
  if(total>25*1024*1024)return invalid();
  return value as AttachmentMetadata[];
}
