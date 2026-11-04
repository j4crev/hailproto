import {expect,it} from 'vitest';
import {encodePayload,decodePayload,fromDiagnosticJson,toDiagnosticJson,type HailAttachment} from '../src/index.js';
const file=(size=1):HailAttachment=>({filename:'report.txt',media_type:'text/plain',size,digest:{algorithm:'sha-256',value:new Uint8Array(32)}});
const body=(attachments:HailAttachment[])=>({version:1 as const,profile:'spt-2' as const,blocks:[],attachments});
it('bounds the entire message attachment list independently of recipient count and body bytes',()=>{
  const value=body([file(25*1024*1024)]),bytes=encodePayload('hail.body.spt-2',value);
  expect(bytes.length).toBeLessThan(300);
  expect(decodePayload('hail.body.spt-2',bytes)).toEqual(value);
  expect(()=>encodePayload('hail.body.spt-2',body([file(25*1024*1024),file()]))).toThrow();
  expect(()=>encodePayload('hail.body.spt-2',body([]))).toThrow();
  expect(()=>encodePayload('hail.body.spt-2',body(Array.from({length:21},()=>file())))).toThrow();
});
it('preserves diagnostic digest bytes and rejects unsafe names, mismatched media and extra fields',()=>{
  const value=body([file()]);expect(fromDiagnosticJson('hail.body.spt-2',toDiagnosticJson('hail.body.spt-2',value))).toEqual(value);
  for(const name of ['../x.txt','x\\y.log','x\n.txt','.hidden.pdf','x.exe','x.html','e\u0301.txt'])expect(()=>encodePayload('hail.body.spt-2',body([{...file(),filename:name}]))).toThrow();
  expect(()=>encodePayload('hail.body.spt-2',body([{...file(),media_type:'application/pdf'}]))).toThrow();
  expect(()=>encodePayload('hail.body.spt-2',body([{...file(),size:0}]))).toThrow();
});
it('matches the frozen detached-file vector',async()=>{
  const {readFile}=await import('node:fs/promises');
  const vector=JSON.parse(await readFile(new URL('../../../spec/vectors/attachments.json',import.meta.url),'utf8'));
  const value=fromDiagnosticJson('hail.body.spt-2',vector.body);
  expect(Buffer.from(encodePayload('hail.body.spt-2',value)).toString('hex')).toBe(vector.bodyHex);
});
it('matches the PNG attachment vector and binds its media type to the extension',async()=>{
  const {readFile}=await import('node:fs/promises');
  const vector=JSON.parse(await readFile(new URL('../../../spec/vectors/attachment-png.json',import.meta.url),'utf8'));
  const value=fromDiagnosticJson('hail.body.spt-2',vector.body);
  expect(Buffer.from(encodePayload('hail.body.spt-2',value)).toString('hex')).toBe(vector.bodyHex);
  value.attachments![0]!.media_type='text/plain';expect(()=>encodePayload('hail.body.spt-2',value)).toThrow();
});
it('matches JPEG and WebP vectors and rejects mismatched extension/media combinations',async()=>{
  const {readFile}=await import('node:fs/promises');
  const vectors=JSON.parse(await readFile(new URL('../../../spec/vectors/attachment-images.json',import.meta.url),'utf8'));
  for(const vector of vectors.records){
    const value=fromDiagnosticJson('hail.body.spt-2',vector.body);
    expect(Buffer.from(encodePayload('hail.body.spt-2',value)).toString('hex')).toBe(vector.bodyHex);
    const file=value.attachments![0]!;file.filename=file.filename.toUpperCase();
    expect(()=>encodePayload('hail.body.spt-2',value)).not.toThrow();
    file.media_type='image/png';expect(()=>encodePayload('hail.body.spt-2',value)).toThrow();
  }
});
