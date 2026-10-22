import {error} from "@sveltejs/kit";

export async function boundedJson(request:Request,limit=65_536){
  if(request.headers.get("content-type")!=="application/json"||request.headers.has("content-encoding"))error(415,"JSON required");
  const reader=request.body?.getReader();if(!reader)error(400,"Request body required");
  const chunks:Uint8Array[]=[];let size=0;
  while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>limit){await reader.cancel();error(413,"Request too large");}chunks.push(next.value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  try{return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}catch{error(400,"Invalid JSON");}
}
