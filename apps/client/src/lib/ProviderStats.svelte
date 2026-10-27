<script lang="ts">
  import type {OperatorStats} from "../../../server/src/operator/stats.js";
  let {stats,range}:{stats:OperatorStats|null;range:string}=$props();
  const number=(value:number)=>value.toLocaleString("en-US");
  const label=(start:string)=>range==="day"?`${start.slice(11,16)} UTC`:start.slice(0,10);
  let peak=$derived(Math.max(1,...(stats?.activity.map(bucket=>bucket.sent+bucket.received)??[])));
</script>
<section class="hail-card panel" aria-labelledby="statistics">
  <div class="heading"><h2 id="statistics">Provider statistics</h2><a class="hail-button-secondary" href={`/admin?range=${range}`} data-sveltekit-reload>Refresh</a></div>
  {#if stats}
    <p class="hint">Snapshot: {stats.generatedAt.replace("T"," ").slice(0,19)} UTC. Totals cover retained records, including imported history; they are not lifetime traffic counters.</p>
    <dl class="metrics">
      <div><dt>Total users</dt><dd>{number(stats.totals.users)}</dd><small>Completed onboarding</small></div>
      <div><dt>Messages sent</dt><dd>{number(stats.totals.sent)}</dd><small>Outbound envelopes recorded</small></div>
      <div><dt>Messages received</dt><dd>{number(stats.totals.received)}</dd><small>Inbound envelopes accepted</small></div>
      <div><dt>Delivery success</dt><dd>{stats.totals.deliveryRate===null?"—":`${stats.totals.deliveryRate}%`}</dd><small>Delivered ÷ terminal outbound outcomes</small></div>
    </dl>
    <p class="hint">{number(stats.totals.pendingUsers)} accounts onboarding · {number(stats.totals.delivered)} outbound delivered · {number(stats.totals.failed)} failed or cancelled · {number(stats.totals.pending)} awaiting a terminal outcome · {number(stats.totals.rejected)} inbound rejected</p>
    <p class="hint">Delivery success excludes outstanding messages and measures confirmed delivery, not reads. “Sent” does not confirm network acceptance; “received” does not confirm body delivery.</p>
  {/if}
  <div class="heading"><h3>Message activity</h3><nav aria-label="Activity period">
    {#each [["day","24 hours"],["week","7 days"],["month","30 days"]] as [value,title]}
      <a href={`/admin?range=${value}`} aria-current={range===value?"page":undefined}>{title}</a>
    {/each}
  </nav></div>
  {#if stats}
    <p class="legend"><span><i class="sent"></i> Sent</span><span><i class="received"></i> Received</span></p>
    <div class="chart-scroll">
      <svg viewBox="0 0 900 240" role="img" aria-labelledby="activity-title activity-description">
        <title id="activity-title">Sent and received messages, {range==="day"?"hourly":"daily"}</title>
        <desc id="activity-description">Stacked counts in UTC. Peak scale {number(peak)} messages. Exact counts are available in the activity table below.</desc>
        {#each [0,1] as fraction}
          <line x1="55" x2="890" y1={200-fraction*175} y2={200-fraction*175} stroke="currentColor" opacity="0.15" />
          <text x="45" y={204-fraction*175} text-anchor="end">{number(peak*fraction)}</text>
        {/each}
        {#each stats.activity as bucket,index}
          {@const step=830/stats.activity.length}
          {@const sentHeight=bucket.sent/peak*175}
          {@const receivedHeight=bucket.received/peak*175}
          <g><title>{label(bucket.start)}: {number(bucket.sent)} sent, {number(bucket.received)} received</title>
            <rect class="sent" x={60+index*step} y={200-sentHeight} width={step-5} height={sentHeight} />
            <rect class="received" x={60+index*step} y={200-sentHeight-receivedHeight} width={step-5} height={receivedHeight} />
          </g>
          {#if index===0||index===stats.activity.length-1||index===Math.floor(stats.activity.length/2)}
            <text x={60+index*step} y="225" text-anchor={index===stats.activity.length-1?"end":"start"}>{label(bucket.start)}</text>
          {/if}
        {/each}
      </svg>
    </div>
    {#if !stats.activity.some(bucket=>bucket.sent||bucket.received)}<p>No message activity in this period.</p>{/if}
    <p class="hint">UTC {range==="day"?"hours":"days"}; the latest bucket is partial. Local messages count once in each direction. Stacked height represents both directions, not unique messages.</p>
    <details><summary>View activity counts</summary><table><thead><tr><th scope="col">Period (UTC)</th><th scope="col">Sent</th><th scope="col">Received</th></tr></thead><tbody>
      {#each stats.activity as bucket}<tr><th scope="row">{bucket.start.replace("T"," ").slice(0,16)}</th><td>{number(bucket.sent)}</td><td>{number(bucket.received)}</td></tr>{/each}
    </tbody></table></details>
  {:else}<p role="status">Statistics are temporarily unavailable. Refresh to try again; invitations are still available below.</p>{/if}
</section>
<style>
  .panel{padding:28px;margin-bottom:24px}.heading{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}h2{font-size:20px;margin:0}h3{font-size:16px}p{line-height:1.6}.hint,small{color:var(--color-muted);font-size:13px}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:20px;margin:28px 0}dt{font-size:13px}dd{font-size:32px;font-weight:650;margin:8px 0}small{display:block}nav{display:flex;gap:8px}nav a{padding:8px;border-radius:8px;font-size:13px}nav a[aria-current]{background:var(--color-ink);color:var(--color-canvas)}.legend,.legend span{display:flex;align-items:center;gap:8px}.legend{gap:20px;font-size:13px}.legend i{width:12px;height:12px;border-radius:3px}.sent{fill:#6366f1;background:#6366f1}.received{fill:#14b8a6;background:#14b8a6}.chart-scroll{overflow-x:auto}svg{display:block;width:100%;min-width:560px;color:var(--color-muted)}svg text{fill:currentColor;font-size:11px}summary{cursor:pointer;font-size:13px}table{width:100%;border-collapse:collapse;font-size:13px;text-align:left}th,td{padding:10px;border-bottom:1px solid var(--color-line)}@media(max-width:650px){.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.panel{padding:20px}}
</style>
