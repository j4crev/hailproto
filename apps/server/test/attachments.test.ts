import {createHash} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {encodePayload,type HailEnvelope} from '@racrproto/codec';
import {bodyDigest} from '../src/bodies/service.js';
import {BodyRetriever} from '../src/delivery/retriever.js';
import {validateAttachmentBytes} from '../src/bodies/attachments.js';
const data=new TextEncoder().encode('log entry\n'),file={filename:'test.log',media_type:'text/plain' as const,size:data.length,digest:{algorithm:'sha-256' as const,value:createHash('sha256').update(data).digest()}};
const body=encodePayload('hail.body.spt-2',{version:1,profile:'spt-2',blocks:[],attachments:[file]});
const envelope={from:'did:plc:'+'a'.repeat(24),body:{profile:'spt-2',media_type:'application/hail-body+cbor',size:body.length,digest:{algorithm:'sha-256',value:bodyDigest(body)},access:{token:new Uint8Array(32)}}} as HailEnvelope;
const response=(bytes:Uint8Array,type:string)=>new Response(Uint8Array.from(bytes),{headers:{'Content-Type':type}});
function setup(attachment:Response){const fetch=vi.fn().mockResolvedValueOnce(response(body,'application/hail-body+cbor')).mockResolvedValueOnce(attachment);return {fetch,retriever:new BodyRetriever({resolve:async()=>({serviceBase:'https://sender.example/hail'})} as never,fetch,async()=>{})};}
it('retrieves files before reporting success, without a reader request to the sender',async()=>{
  const {retriever,fetch}=setup(response(data,'application/octet-stream'));
  const result=await retriever.retrieve(envelope);expect(result).toEqual({kind:'success',bytes:Uint8Array.from(body),attachments:[data]});
  expect(fetch.mock.calls[1]![0].url).toContain('/attachments/');expect(fetch.mock.calls[1]![0].headers.get('authorization')).toBe(fetch.mock.calls[0]![0].headers.get('authorization'));
});
it('retries missing/interrupted bytes and rejects corruption and compressed files',async()=>{
  expect((await setup(new Response(null,{status:503})).retriever.retrieve(envelope)).kind).toBe('retry');
  expect(await setup(response(new Uint8Array(data.length),'application/octet-stream')).retriever.retrieve(envelope)).toEqual({kind:'fail',reason:'body-integrity-failed'});
  const compressed=response(data,'application/octet-stream');compressed.headers.set('Content-Encoding','gzip');
  expect((await setup(compressed).retriever.retrieve(envelope)).kind).toBe('fail');
});
it('rejects invalid text and PDF signatures despite matching digests',()=>{
  for(const [bytes,media] of [[new Uint8Array([0]),'text/plain'],[new Uint8Array([255]),'text/plain'],[data,'application/pdf']] as const){
    expect(()=>validateAttachmentBytes({...file,media_type:media,size:bytes.length,digest:{algorithm:'sha-256',value:bodyDigest(bytes)}},bytes)).toThrow();
  }
});

it('accepts structurally valid PNG files beyond the header budget and rejects corruption and animation',()=>{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
  const chunk=(type:string,data:Uint8Array)=>{
    const bytes=Buffer.alloc(data.length+12);bytes.writeUInt32BE(data.length);bytes.write(type,4);bytes.set(data,8);
    let crc=0xffffffff;for(const byte of bytes.subarray(4,-4)){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
    bytes.writeUInt32BE((crc^0xffffffff)>>>0,bytes.length-4);return bytes;
  };
  const validate=(bytes:Uint8Array)=>validateAttachmentBytes({...file,filename:'screenshot.png',media_type:'image/png',size:bytes.length,digest:{algorithm:'sha-256',value:bodyDigest(bytes)}},bytes);
  const large=Buffer.concat([png.subarray(0,33),chunk('tEXt',Buffer.from('Comment\0'+'x'.repeat(200000))),png.subarray(33)]);
  expect(large.length).toBeGreaterThan(192*1024);expect(()=>validate(large)).not.toThrow();
  expect(()=>validate(png)).not.toThrow();
  const corrupt=Buffer.from(png);corrupt[29]!^=1;expect(()=>validate(corrupt)).toThrow('CRC');
  expect(()=>validate(png.subarray(0,-1))).toThrow();
  expect(()=>validate(data)).toThrow('PNG');
  const animated=Buffer.concat([png.subarray(0,33),chunk('acTL',new Uint8Array(8)),png.subarray(33)]);
  expect(()=>validate(animated)).toThrow('animated');
});
