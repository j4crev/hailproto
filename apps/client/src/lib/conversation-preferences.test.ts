import {expect,it} from "vitest";
import {parseConversationPreferences} from "./conversation-preferences.js";

const connection={connectionId:"01954144-8097-7a9d-a7a8-ef29a823eaf1",epoch:1,did:"did:plc:"+"a".repeat(24),address:"alice@example.com",override:null,effectiveAllowIntroductions:false};
const preferences={allowIntroductions:false,configured:true,truncated:false,connections:[connection]};
it("preserves explicit denial and distinguishes inheritance from an override",()=>{
  expect(parseConversationPreferences(preferences)).toEqual(preferences);
  expect(parseConversationPreferences({...preferences,allowIntroductions:true,configured:false,connections:[{...connection,effectiveAllowIntroductions:true}]}).allowIntroductions).toBe(true);
  expect(parseConversationPreferences({...preferences,allowIntroductions:true,configured:true,connections:[{...connection,override:false}]}).connections[0]!.override).toBe(false);
  expect(parseConversationPreferences({...preferences,connections:[{...connection,override:true,effectiveAllowIntroductions:true}]}).connections[0]!.override).toBe(true);
});
it("rejects incomplete, contradictory, duplicated and malformed policy responses",()=>{
  for(const value of [null,{}, {...preferences,allowIntroductions:"true"},{...preferences,configured:undefined},
    {...preferences,connections:[{...connection,override:undefined}]}, {...preferences,connections:[{...connection,effectiveAllowIntroductions:true}]},
    {...preferences,connections:[{...connection,epoch:0}]},{...preferences,connections:[{...connection,did:"invalid"}]},
    {...preferences,connections:[connection,connection]}])expect(()=>parseConversationPreferences(value)).toThrow("Conversation preferences are unavailable");
});
