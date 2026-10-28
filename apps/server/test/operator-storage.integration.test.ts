import {describe,it,expect} from "vitest";
import {randomUUID} from "node:crypto";
import {readStorage} from "../src/operator/storage.js";
import type {SQL} from "bun";
const integration=process.env.DATABASE_URL?describe:describe.skip;
integration('Operator storage PostgreSQL sizes',()=>{
  it('includes table overflow storage and indexes once, without inspecting row contents',async()=>{
    const {SQL}=await import('bun');const sql=new SQL(process.env.DATABASE_URL!);
    const name=`stats_size_${randomUUID().replaceAll('-','')}`;
    try{await sql.begin(async tx=>{
      // Unique, transactional fixture; deliberately roll back even after success.
      await tx.unsafe(`CREATE TABLE public.${name} (id integer PRIMARY KEY, payload text)`);
      await tx.unsafe(`ALTER TABLE public.${name} ALTER COLUMN payload SET STORAGE EXTERNAL`);
      await tx.unsafe(`INSERT INTO public.${name} SELECT i,repeat(md5(i::text),1000) FROM generate_series(1,20) i`);
      const before=await readStorage(tx as unknown as SQL);
      const [sizes]=await tx`SELECT pg_table_size(${`public.${name}`}::regclass)::float8 AS data,
        pg_indexes_size(${`public.${name}`}::regclass)::float8 AS indexes,
        pg_relation_size(${`public.${name}`}::regclass)::float8 AS heap`;
      expect(sizes!.data).toBeGreaterThan(sizes!.heap);expect(sizes!.indexes).toBeGreaterThan(0);
      await tx.unsafe(`DROP TABLE public.${name}`);
      const after=await readStorage(tx as unknown as SQL);
      expect(before.applicationBytes-after.applicationBytes).toBe(sizes!.data+sizes!.indexes);
      expect(before.indexBytes-after.indexBytes).toBe(sizes!.indexes);
      expect(before.categories.find(c=>c.id==='other')!.totalBytes-after.categories.find(c=>c.id==='other')!.totalBytes).toBe(sizes!.data+sizes!.indexes);
      expect(before.databaseBytes).toBeGreaterThan(0);
      expect(before.categories.reduce((n,c)=>n+c.totalBytes,0)).toBe(before.applicationBytes);
      throw new Error('fixture rollback');
    }).catch(error=>{if(error.message!=='fixture rollback')throw error;});}finally{await sql.close();}
  });
});
