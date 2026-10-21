export function messageId() {
  const bytes=crypto.getRandomValues(new Uint8Array(16)),now=Date.now();
  for(let index=5,value=now;index>=0;index--){bytes[index]=value&255;value=Math.floor(value/256);}
  bytes[6]=(bytes[6]!&15)|112;bytes[8]=(bytes[8]!&63)|128;
  const hex=Buffer.from(bytes).toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
