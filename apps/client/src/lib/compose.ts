export interface ComposeBlock {
  _type: "block";
  style: "h1" | "h2" | "h3" | "normal" | "blockquote";
  listItem?: "bullet" | "number";
  level?: number;
  children: { _type: "span"; text: string; marks: string[] }[];
  markDefs: { _key:string;_type:"spt.link";href:string }[];
}

const INLINE=/`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)/g;
const BLOCK=/^(#{1,3}|>|-|\d+\.)[ \t]+(\S.*)$/;

function paragraph(text:string):ComposeBlock {
  const children:ComposeBlock["children"]=[],markDefs:ComposeBlock["markDefs"]=[];
  let offset=0,match:RegExpExecArray|null;
  const span=(text:string,marks:string[]=[])=>{if(text)children.push({_type:"span",text,marks});};
  while((match=INLINE.exec(text))){
    span(text.slice(offset,match.index));
    if(match[1])span(match[1],["code"]);
    else if(match[2])span(match[2],["strong"]);
    else if(match[3])span(match[3],["em"]);
    else if(match[4]&&match[5]){
      try {const url=new URL(match[5]);if(url.protocol!=="https:"||url.username||url.password)throw new Error();
        const key=`link-${markDefs.length+1}`;markDefs.push({_key:key,_type:"spt.link",href:url.href});span(match[4],[key]);}
      catch {span(match[0]);}
    }
    offset=match.index+match[0].length;
  }
  span(text.slice(offset));
  return {_type:"block",style:"normal",children,markDefs};
}

export function composeBlocks(title: string, text: string): ComposeBlock[] {
  const blocks:ComposeBlock[]=title?[{_type:"block",style:"h1",children:[{_type:"span",text:title,marks:[]}],markDefs:[]}]:[];
  let lines:string[]=[];
  const flush=()=>{if(lines.length){blocks.push(paragraph(lines.join("\n").trim()));lines=[];}};
  for(const line of text.replace(/\r\n?/g,"\n").split("\n")){
    const match=BLOCK.exec(line);
    if(!line.trim()||match){
      flush();
      if(match){
        const block=paragraph(match[2].trimEnd()),marker=match[1];
        if(marker.startsWith("#"))block.style=`h${marker.length}` as "h1"|"h2"|"h3";
        else if(marker===">")block.style="blockquote";
        else {block.listItem=marker==="-"?"bullet":"number";block.level=1;}
        blocks.push(block);
      }
    }else lines.push(line);
  }
  flush();
  return blocks;
}

// ponytail: flat lists only; add level controls when nested authoring is needed.
export function formatLines(text:string,start:number,end:number,prefix:string) {
  const from=text.slice(0,start).lastIndexOf("\n")+1;
  const last=end>start&&text[end-1]==="\n"?end-1:end;
  const newline=text.indexOf("\n",last),to=newline<0?text.length:newline;
  const value=text.slice(from,to).split("\n").map(line=>prefix+line.replace(/^(?:#{1,3}|>|-|\d+\.)[ \t]+/,"")).join("\n");
  return {text:text.slice(0,from)+value+text.slice(to),start:from,end:from+value.length};
}
