export interface ComposeBlock {
  _type: "block";
  style: "h1" | "normal";
  children: { _type: "span"; text: string; marks: string[] }[];
  markDefs: { _key:string;_type:"spt.link";href:string }[];
}

const INLINE=/`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)/g;

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
  return [
    ...(title ? [{ _type:"block",style:"h1",children:[{_type:"span",text:title,marks:[]}],markDefs:[] }] as ComposeBlock[] : []),
    ...text.split(/\n\s*\n/).map(value=>value.trim()).filter(Boolean).map(paragraph),
  ];
}
