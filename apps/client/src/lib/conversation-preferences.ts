export interface ConversationPreferences {
  allowIntroductions:boolean;
  configured:boolean;
  truncated:boolean;
  connections:{connectionId:string;epoch:number;did:string;address:string;override:boolean|null;effectiveAllowIntroductions:boolean}[];
}
export function parseConversationPreferences(value:unknown):ConversationPreferences {
  const p=value as ConversationPreferences;
  if(!p||typeof p.allowIntroductions!=="boolean"||typeof p.configured!=="boolean"||typeof p.truncated!=="boolean"||
    !Array.isArray(p.connections)||p.connections.length>200||p.connections.some(c=>!c||
      typeof c.connectionId!=="string"||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(c.connectionId)||
      !Number.isSafeInteger(c.epoch)||c.epoch<1||typeof c.did!=="string"||!/^did:plc:[a-z2-7]{24}$/.test(c.did)||
      typeof c.address!=="string"||c.address.length>254||(c.override!==null&&typeof c.override!=="boolean")||
      c.effectiveAllowIntroductions!==(c.override??p.allowIntroductions))||
    new Set(p.connections.map(c=>c.connectionId)).size!==p.connections.length)
    throw new Error("Conversation preferences are unavailable. Please try again.");
  return p;
}
