import {expect,it} from "vitest";
import {publicationAudiences,publicationStatus,recentPublications} from "./publications.js";

it("accepts bounded category counts and rejects misleading publication status",()=>{
  expect(publicationAudiences({maxRecipients:100,categories:[{category:"general",subscribers:2}]})).toEqual({maxRecipients:100,categories:[{category:"general",subscribers:2}]});
  expect(()=>publicationAudiences({maxRecipients:100,categories:[{category:"general",subscribers:-1}]})).toThrow();
  const status={publicationId:"019a15fd-2bd0-7433-8afa-bd0355e0608d",category:"general",total:2,state:"publishing",
    counts:{pending:2,submitted:0,blocked:0,cancelled:0,expired:0,indeterminate:0},delivery:{accepted:0,delivered:0,"on-hold":0,failed:0,cancelled:0,indeterminate:0},
    targets:[{messageId:"019a15fd-2bd0-7433-8afa-bd0355e0608e",recipient:"did:plc:"+"a".repeat(24),state:"pending",delivery:null},
      {messageId:"019a15fd-2bd0-7433-8afa-bd0355e0608f",recipient:"did:plc:"+"b".repeat(24),state:"pending",delivery:null}],
    createdAt:"2026-10-24T00:00:00Z",expiresAt:"2026-10-25T00:00:00Z"};
  expect(publicationStatus(status)).toEqual(status);
  expect(()=>publicationStatus({...status,state:"finished"})).toThrow();
  expect(()=>publicationStatus({...status,counts:{...status.counts,submitted:1}})).toThrow();
  expect(()=>publicationStatus({...status,delivery:{...status.delivery,delivered:3}})).toThrow();
  expect(recentPublications({publications:[]})).toEqual([]);
  expect(()=>recentPublications({publications:[{publicationId:status.publicationId,category:"general",createdAt:status.createdAt,pending:"yes"}]})).toThrow();
});
