export interface ComposeBlock {
  _type: "block";
  style: "h1" | "normal";
  children: { _type: "span"; text: string; marks: [] }[];
  markDefs: [];
}

export function composeBlocks(title: string, text: string): ComposeBlock[] {
  return [
    ...(title ? [{ _type:"block",style:"h1",children:[{_type:"span",text:title,marks:[]}],markDefs:[] }] as ComposeBlock[] : []),
    ...text.split(/\n\s*\n/).map(value=>value.trim()).filter(Boolean).map(text=>({
      _type:"block" as const,style:"normal" as const,children:[{_type:"span" as const,text,marks:[] as []}],markDefs:[] as [],
    })),
  ];
}
