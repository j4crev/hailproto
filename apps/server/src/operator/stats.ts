import type {SQL} from "bun";
import {readStorage, type StorageStats} from "./storage.js";

export const statsRanges = {day: {buckets:24, seconds:3600}, week:{buckets:7, seconds:86400}, month:{buckets:30, seconds:86400}} as const;
export type StatsRange = keyof typeof statsRanges;
export type OperatorStats = {
  range:StatsRange; generatedAt:string; storage:StorageStats|null;
  totals:{users:number; pendingUsers:number; sent:number; received:number; rejected:number; delivered:number; failed:number; pending:number; deliveryRate:number|null};
  activity:{start:string; sent:number; received:number}[];
};

export class OperatorStatistics {
  constructor(private readonly sql:SQL){}
  async read(range:StatsRange, now=new Date()):Promise<OperatorStats>{
    const {buckets,seconds}=statsRanges[range];
    const end=new Date((Math.floor(now.getTime()/1000/seconds)+1)*seconds*1000);
    const start=new Date(end.getTime()-buckets*seconds*1000);
    // One statement gives totals and buckets a consistent PostgreSQL snapshot. These
    // are retained records (including imported history), not lifetime traffic counters.
    const [result]=await this.sql<{totals:OperatorStats["totals"]; activity:OperatorStats["activity"]}[]>`
      WITH outbound AS (
        SELECT count(*)::float8 AS sent,
          count(*) FILTER (WHERE s.current_state='delivered')::float8 AS delivered,
          count(*) FILTER (WHERE s.current_state IN ('failed','cancelled'))::float8 AS failed
        FROM sent_envelopes e LEFT JOIN sent_delivery_status s USING(sender_did,message_id)
      ), inbound AS (
        SELECT count(*) FILTER (WHERE outcome='accepted')::float8 AS received,
          count(*) FILTER (WHERE outcome<>'accepted')::float8 AS rejected FROM received_envelopes
      ), users AS (
        SELECT count(*) FILTER (WHERE onboarding_state='active')::float8 AS users,
          count(*) FILTER (WHERE onboarding_state<>'active')::float8 AS pending FROM provider_accounts
      ), events AS (
        SELECT created_at AS at, 1 AS sent, 0 AS received FROM sent_envelopes
          WHERE created_at>=${start} AND created_at<=${now}
        UNION ALL
        SELECT accepted_at AS at, 0 AS sent, 1 AS received FROM received_envelopes
          WHERE outcome='accepted' AND accepted_at>=${start} AND accepted_at<=${now}
      ), counts AS (
        SELECT floor(extract(epoch FROM at)/${seconds})*${seconds} AS bucket,
          sum(sent)::float8 AS sent, sum(received)::float8 AS received FROM events GROUP BY 1
      ), activity AS (
        SELECT to_char(to_timestamp(b.bucket) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS start,
          coalesce(c.sent,0) AS sent, coalesce(c.received,0) AS received
        FROM generate_series(${start.getTime()/1000}::bigint,${end.getTime()/1000-seconds}::bigint,${seconds}::bigint) b(bucket)
        LEFT JOIN counts c ON c.bucket=b.bucket ORDER BY b.bucket
      )
      SELECT json_build_object('users',u.users,'pendingUsers',u.pending,'sent',o.sent,'received',i.received,
        'rejected',i.rejected,'delivered',o.delivered,'failed',o.failed,'pending',o.sent-o.delivered-o.failed,
        'deliveryRate',CASE WHEN o.delivered+o.failed>0 THEN round((100*o.delivered/(o.delivered+o.failed))::numeric,1) ELSE NULL END) AS totals,
        (SELECT json_agg(activity) FROM activity) AS activity
      FROM outbound o CROSS JOIN inbound i CROSS JOIN users u`;
    // Storage collection must not take down message stats or invitations.
    const storage=await readStorage(this.sql).catch(()=>null);
    return {range,generatedAt:now.toISOString(),...result!,storage};
  }
}
