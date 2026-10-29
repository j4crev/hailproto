import {randomUUID} from "node:crypto";
import {describe,it,expect} from "vitest";
import {ProviderDatabase} from "../src/db/database.js";
const integration=process.env.DATABASE_URL?describe:describe.skip;
integration("delivery cursor commit ordering",()=>{
  it("rolls back cursor storage without removing existing delivered messages",async()=>{
    const db=new ProviderDatabase(process.env.DATABASE_URL!);
    try{
      await db.migrate();
      const before=await db.sql`SELECT recipient_did,sender_did,message_id FROM delivered_messages ORDER BY recipient_did,sender_did,message_id`;
      await expect(db.sql.begin(async tx=>{
        await tx.unsafe(await Bun.file(new URL("../migrations/rollback/0084_inbox_delivery_cursor.sql",import.meta.url)).text());
        expect(await tx`SELECT recipient_did,sender_did,message_id FROM delivered_messages ORDER BY recipient_did,sender_did,message_id`).toEqual(before);
        throw new Error("rollback-proof-complete");
      })).rejects.toThrow("rollback-proof-complete");
      await db.sql`SELECT delivery_sequence FROM delivered_messages LIMIT 1`;
    }finally{await db.close();}
  });

  it("serializes concurrent deliveries to one recipient before allocating their cursors",async()=>{
    const db=new ProviderDatabase(process.env.DATABASE_URL!);
    await db.migrate();
    const table=`cursor_test_${randomUUID().replaceAll("-","")}`;
    let release!:()=>void,inserted!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{inserted=resolve;});
    let first:Promise<unknown>|undefined,second:Promise<unknown>|undefined;
    try{
      await db.sql.unsafe(`CREATE TABLE ${table}(recipient_did text, delivery_sequence bigint)`);
      await db.sql.unsafe(`CREATE TRIGGER delivery_cursor BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION hail_assign_delivery_sequence()`);
      first=db.sql.begin(async tx=>{await tx.unsafe(`INSERT INTO ${table}(recipient_did) VALUES ('cursor-recipient')`);inserted();await gate;});
      await ready;
      second=db.sql.unsafe(`INSERT INTO ${table}(recipient_did) VALUES ('cursor-recipient') RETURNING delivery_sequence::text AS sequence`).execute();
      expect(await db.sql.unsafe(`SELECT * FROM ${table}`)).toHaveLength(0);
      release();await first;await second;
      const rows=await db.sql.unsafe(`SELECT delivery_sequence::text AS sequence FROM ${table} ORDER BY delivery_sequence`);
      expect(rows).toHaveLength(2);expect(BigInt(rows[1].sequence)).toBeGreaterThan(BigInt(rows[0].sequence));
    }finally{release();await Promise.allSettled([first,second]);await db.sql.unsafe(`DROP TABLE IF EXISTS ${table}`);await db.close();}
  });
});
