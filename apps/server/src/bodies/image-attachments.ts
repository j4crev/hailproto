/** Bounded container/header checks only. Never decode pixels or rewrite signed bytes. */
export function validateJpegStructure(bytes:Uint8Array):void {
  const invalid=()=>{throw new Error('Invalid or unsupported JPEG structure');};
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(bytes.length<4||bytes[0]!==0xff||bytes[1]!==0xd8)invalid();
  let offset=2,inScan=false,sawScan=false,sawData=false;
  let components:Set<number>|undefined;
  while(offset<bytes.length){
    if(inScan&&bytes[offset]!==0xff){sawData=true;offset++;continue;}
    if(bytes[offset++]!==0xff)invalid();
    while(bytes[offset]===0xff)offset++;
    if(offset>=bytes.length)invalid();
    const marker=bytes[offset++]!;
    if(inScan&&(marker===0||marker>=0xd0&&marker<=0xd7)){
      if(marker===0)sawData=true;
      continue;
    }
    inScan=false;
    if(marker===0xd9){if(!components||!sawScan||!sawData||offset!==bytes.length)invalid();return;}
    if(![0xc0,0xc1,0xc2,0xc4,0xdb,0xdd,0xda,0xfe].includes(marker)&&!(marker>=0xe0&&marker<=0xef))invalid();
    if(offset+2>bytes.length)invalid();
    const length=view.getUint16(offset),start=offset+2,end=offset+length;
    if(length<2||end>bytes.length)invalid();
    if([0xc0,0xc1,0xc2].includes(marker)){
      if(components||length<11||bytes[start]!==8||view.getUint16(start+1)===0||view.getUint16(start+3)===0)invalid();
      const count=bytes[start+5]!;
      if(count<1||count>4||length!==8+3*count)invalid();
      components=new Set();
      for(let i=0;i<count;i++){
        const id=bytes[start+6+3*i]!,sampling=bytes[start+7+3*i]!;
        if(components.has(id)||(sampling>>4)<1||(sampling>>4)>4||(sampling&15)<1||(sampling&15)>4||bytes[start+8+3*i]!>3)invalid();
        components.add(id);
      }
    }else if(marker===0xda){
      if(!components||length<8)invalid();
      const count=bytes[start]!,selected=new Set<number>();
      if(count<1||count>components!.size||length!==6+2*count)invalid();
      for(let i=0;i<count;i++){
        const id=bytes[start+1+2*i]!,tables=bytes[start+2+2*i]!;
        if(!components!.has(id)||selected.has(id)||(tables>>4)>3||(tables&15)>3)invalid();
        selected.add(id);
      }
      if(bytes[end-3]!>63||bytes[end-2]!>63)invalid();
      sawScan=true;inScan=true;
    }else if(marker===0xdd&&length!==4)invalid();
    offset=end;
  }
  invalid();
}

/** RFC 9649: static VP8/VP8L images, optionally in an extended RIFF container. */
export function validateWebpStructure(bytes:Uint8Array):void {
  const invalid=()=>{throw new Error('Invalid or unsupported WebP structure');};
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const fourcc=(offset:number)=>String.fromCharCode(...bytes.subarray(offset,offset+4));
  const uint24=(offset:number)=>bytes[offset]!+bytes[offset+1]!*256+bytes[offset+2]!*65536;
  if(bytes.length<20||fourcc(0)!=='RIFF'||fourcc(8)!=='WEBP'||view.getUint32(4,true)+8!==bytes.length)invalid();
  let offset=12,width=0,height=0,canvasWidth=0,canvasHeight=0,flags=0;
  let extended=false,image=false,alpha=false,icc=false,exif=false,xmp=false,losslessAlpha=false;
  while(offset<bytes.length){
    if(offset+8>bytes.length)invalid();
    const type=fourcc(offset),size=view.getUint32(offset+4,true),start=offset+8,end=start+size,padded=end+(size&1);
    if(padded>bytes.length||size%2&&bytes[end]!==0)invalid();
    if(type==='VP8X'){
      if(offset!==12||size!==10)invalid();
      flags=bytes[start]!;
      if(flags&0xc3||uint24(start+1)!==0)invalid(); // Reserved bits and animation are unsupported.
      canvasWidth=uint24(start+4)+1;canvasHeight=uint24(start+7)+1;
      if(canvasWidth*canvasHeight>0xffffffff)invalid();
      extended=true;
    }else if(type==='ANIM'||type==='ANMF')invalid();
    else if(type==='VP8 '||type==='VP8L'){
      if(image||!extended&&offset!==12)invalid();
      if(type==='VP8 '){
        if(size<=10||bytes[start]!&1||((bytes[start]!>>1)&7)>3||!(bytes[start]!&16)||
          bytes[start+3]!==0x9d||bytes[start+4]!==1||bytes[start+5]!==0x2a)invalid();
        width=view.getUint16(start+6,true)&0x3fff;height=view.getUint16(start+8,true)&0x3fff;
      }else{
        if(alpha||size<=5||bytes[start]!==0x2f)invalid();
        const bits=view.getUint32(start+1,true);
        if(bits>>>29)invalid();
        width=(bits&0x3fff)+1;height=((bits>>>14)&0x3fff)+1;losslessAlpha=!!(bits&0x10000000);
      }
      if(!width||!height||extended&&(width!==canvasWidth||height!==canvasHeight))invalid();
      image=true;
    }else if(type==='ALPH'){
      if(!extended||image||alpha||size<2||bytes[start]!&0xc0||(bytes[start]!&3)>1||((bytes[start]!>>4)&3)>1)invalid();
      if((bytes[start]!&3)===0&&size!==1+canvasWidth*canvasHeight)invalid();
      alpha=true;
    }else if(type==='ICCP'){
      if(!extended||image||alpha||icc||!size)invalid();icc=true;
    }else if(type==='EXIF'||type==='XMP '){
      if(!extended||!image||!size||type==='EXIF'&&exif||type==='XMP '&&xmp)invalid();
      if(type==='EXIF')exif=true;else xmp=true;
    }
    offset=padded;
  }
  if(!image||extended&&(!!(flags&0x20)!==icc||!!(flags&0x08)!==exif||!!(flags&0x04)!==xmp||!!(flags&0x10)!==(alpha||losslessAlpha)))invalid();
}
