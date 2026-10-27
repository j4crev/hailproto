import {describe,it,expect} from "vitest";
import {OperatorStatistics} from "../src/operator/stats.js";
import type {SQL} from "bun";

const integration=process.env.DATABASE_URL?describe:describe.skip;
integration("Operator statistics PostgreSQL aggregation",()=>{
  it("counts retained records, terminal outcomes, UTC boundaries and zero-filled periods",async()=>{
    const {SQL}=await import("bun");
    const sql=new SQL(process.env.DATABASE_URL!);
    try{await sql.begin(async tx=>{
      // Temporary tables isolate fixtures from any existing provider records.
      await tx`CREATE TEMP TABLE provider_accounts(onboarding_state text) ON COMMIT DROP`;
      await tx`CREATE TEMP TABLE sent_envelopes(sender_did text,message_id text,created_at timestamptz) ON COMMIT DROP`;
      await tx`CREATE TEMP TABLE received_envelopes(outcome text,accepted_at timestamptz,created_at timestamptz) ON COMMIT DROP`;
      await tx`CREATE TEMP TABLE sent_delivery_status(sender_did text,message_id text,current_state text) ON COMMIT DROP`;
      const stats=new OperatorStatistics(tx as unknown as SQL),now=new Date("2026-10-27T12:30:00Z");
      const empty=await stats.read("day",now);
      expect(empty.totals).toEqual({users:0,pendingUsers:0,sent:0,received:0,rejected:0,delivered:0,failed:0,pending:0,deliveryRate:null});
      expect(empty.activity).toHaveLength(24);expect(empty.activity.every(b=>b.sent===0&&b.received===0)).toBe(true);
      await tx`INSERT INTO provider_accounts VALUES ('active'),('active'),('prepared')`;
      await tx`INSERT INTO sent_envelopes VALUES
        ('a','1','2026-10-27T12:00:00Z'),('a','2','2026-10-27T12:15:00Z'),
        ('a','3','2026-10-26T13:00:00Z'),('a','4','2026-10-26T12:59:59Z'),
        ('a','5','2026-09-01T00:00:00Z'),('a','6','2026-10-27T12:30:01Z')`;
      await tx`INSERT INTO sent_delivery_status VALUES ('a','1','delivered'),('a','2','delivered'),('a','3','failed'),('a','4','cancelled'),('a','5','on-hold')`;
      await tx`INSERT INTO received_envelopes VALUES
        ('accepted','2026-10-27T12:00:00Z','2026-10-27T11:59:59Z'),
        ('accepted','2026-10-26T13:00:00Z','2026-10-26T12:59:59Z'),
        ('unauthorized',NULL,'2026-10-27T12:00:00Z'),('message-expired',NULL,'2026-10-27T12:00:00Z')`;
      const day=await stats.read("day",now);
      expect(day.totals).toEqual({users:2,pendingUsers:1,sent:6,received:2,rejected:2,delivered:2,failed:2,pending:2,deliveryRate:50});
      expect(day.activity[0]).toEqual({start:"2026-10-26T13:00:00Z",sent:1,received:1});
      expect(day.activity.at(-1)).toEqual({start:"2026-10-27T12:00:00Z",sent:2,received:1});
      expect(day.activity.reduce((sum,b)=>sum+b.sent,0)).toBe(3);
      for(const [range,length,first] of [["week",7,"2026-10-21T00:00:00Z"],["month",30,"2026-09-28T00:00:00Z"]] as const){
        const result=await stats.read(range,now);
        expect(result.activity).toHaveLength(length);expect(result.activity[0]!.start).toBe(first);
        expect(result.activity.at(-2)).toEqual({start:"2026-10-26T00:00:00Z",sent:2,received:1});
        expect(result.activity.at(-1)).toEqual({start:"2026-10-27T00:00:00Z",sent:2,received:1});
      }
    });}finally{await sql.close();}
  });
});
