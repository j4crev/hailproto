import {expect,it} from 'vitest';
import {fromDiagnosticJson,type HailAttachment} from '@racrproto/codec';
import vectors from '../../../spec/vectors/attachment-images.json';
import {bodyDigest} from '../src/bodies/service.js';
import {validateAttachmentBytes} from '../src/bodies/attachments.js';
import {validateJpegStructure,validateWebpStructure} from '../src/bodies/image-attachments.js';

for(const vector of vectors.records)it(`accepts the frozen ${vector.id} bytes without transcoding`,()=>{
  const bytes=Buffer.from(vector.fileHex,'hex');
  const file=fromDiagnosticJson('hail.body.spt-2',vector.body).attachments![0]!;
  expect(()=>validateAttachmentBytes(file,bytes)).not.toThrow();
  const corrupted=Buffer.from(bytes);corrupted[corrupted.length-1]!^=1;
  expect(()=>validateAttachmentBytes(file,corrupted)).toThrow('integrity');
  for(let length=0;length<bytes.length;length++){
    const shortened=bytes.subarray(0,length),metadata={...file,size:shortened.length,digest:{algorithm:'sha-256' as const,value:bodyDigest(shortened)}};
    expect(()=>validateAttachmentBytes(metadata,shortened)).toThrow();
  }
});
const fixture=(id:string)=>Buffer.from(vectors.records.find(v=>v.id===id)!.fileHex,'hex');
it('rejects JPEG marker/segment damage, zero dimensions and appended data',()=>{
  const jpeg=fixture('baseline.jpg'),frame=jpeg.indexOf(Buffer.from([255,192]));expect(frame).toBeGreaterThan(0);
  const zero=Buffer.from(jpeg);zero.writeUInt16BE(0,frame+7);expect(()=>validateJpegStructure(zero)).toThrow();
  const overrun=Buffer.from(jpeg);overrun.writeUInt16BE(65535,frame+2);expect(()=>validateJpegStructure(overrun)).toThrow();
  expect(()=>validateJpegStructure(Buffer.concat([jpeg,Buffer.from('extra')]))).toThrow();
  expect(()=>validateJpegStructure(Buffer.from([255,216,255,217]))).toThrow();
});
it('rejects WebP container/bitstream mismatches, animation and appended data',()=>{
  const webp=fixture('transparent.webp');expect(webp.subarray(12,16).toString()).toBe('VP8X');
  const animation=Buffer.from(webp);animation[20]!|=2;expect(()=>validateWebpStructure(animation)).toThrow();
  const dimensions=Buffer.from(webp);dimensions[24]!^=1;expect(()=>validateWebpStructure(dimensions)).toThrow();
  const overrun=Buffer.from(webp);overrun.writeUInt32LE(0xffffffff,16);expect(()=>validateWebpStructure(overrun)).toThrow();
  expect(()=>validateWebpStructure(Buffer.concat([webp,Buffer.from('extra')]))).toThrow();
  const simple=fixture('lossless.webp'),duplicate=Buffer.concat([simple,simple.subarray(12)]);duplicate.writeUInt32LE(duplicate.length-8,4);
  expect(()=>validateWebpStructure(duplicate)).toThrow();
});
it('rejects renamed images and text even with independently matching content digests',()=>{
  const jpg=fixture('baseline.jpg'),webp=fixture('lossless.webp');
  for(const [bytes,media] of [[jpg,'image/webp'],[webp,'image/jpeg'],[Buffer.from('text'),'image/jpeg'],[Buffer.from('text'),'image/webp']] as const){
    const file:HailAttachment={filename:'fixture',media_type:media,size:bytes.length,digest:{algorithm:'sha-256',value:bodyDigest(bytes)}};
    expect(()=>validateAttachmentBytes(file,bytes)).toThrow();
  }
});
