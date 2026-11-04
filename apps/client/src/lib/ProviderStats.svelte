<script lang="ts">
  import ProviderStorage from "./ProviderStorage.svelte";
  import type {OperatorStats} from "@racrproto/client-support/provider-contracts";
  let {stats,range}:{stats:OperatorStats|null;range:string}=$props();
  const number=(value:number)=>value.toLocaleString("en-US");
  const label=(start:string)=>range==="day"?`${start.slice(11,16)} UTC`:start.slice(0,10);
  let peak=$derived(Math.max(1,...(stats?.activity.map(bucket=>bucket.sent+bucket.received)??[])));
</script>
<section class="hail-card panel" aria-labelledby="statistics">
  <div class="heading flex items-center justify-between gap-[16px] flex-wrap"><h2 id="statistics">Provider statistics</h2><a class="hail-button-secondary" href={`/admin?range=${range}`} data-sveltekit-reload>Refresh</a></div>
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
  {#if stats}<ProviderStorage storage={stats.storage} />{/if}
  <div class="heading flex items-center justify-between gap-[16px] flex-wrap"><h3>Message activity</h3><nav aria-label="Activity period">
    {#each [["day","24 hours"],["week","7 days"],["month","30 days"]] as [value,title]}
      <a href={`/admin?range=${value}`} aria-current={range===value?"page":undefined}>{title}</a>
    {/each}
  </nav></div>
  {#if stats}
    <p class="legend"><span><i class="sent [fill:var(--color-chart-sent)] [background:var(--color-chart-sent)]"></i> Sent</span><span><i class="received [fill:var(--color-chart-received)] [background:var(--color-chart-received)]"></i> Received</span></p>
    <div class="chart-scroll overflow-x-auto">
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
            <rect class="sent [fill:var(--color-chart-sent)] [background:var(--color-chart-sent)]" x={60+index*step} y={200-sentHeight} width={step-5} height={sentHeight} />
            <rect class="received [fill:var(--color-chart-received)] [background:var(--color-chart-received)]" x={60+index*step} y={200-sentHeight-receivedHeight} width={step-5} height={receivedHeight} />
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
<style lang="postcss">
  @reference "../app.css";

  .panel { @apply p-[28px] mb-[24px]; }
  h2 { @apply text-[20px] m-0; }
  h3 { @apply text-[16px]; }
  p { @apply leading-[1.6]; }
  .hint,small { @apply text-muted text-[13px]; }
  .metrics { @apply grid grid-cols-[repeat(4,minmax(0,1fr))] gap-[20px] [margin:28px_0]; }
  dt { @apply text-[13px]; }
  dd { @apply text-[32px] font-[650] [margin:8px_0]; }
  small { @apply block; }
  nav { @apply flex gap-[8px]; }
  nav a { @apply p-[8px] rounded-[8px] text-[13px]; }
  nav a[aria-current] { @apply [background:var(--color-ink)] text-canvas; }
  .legend,.legend span { @apply flex items-center gap-[8px]; }
  .legend { @apply gap-[20px] text-[13px]; }
  .legend i { @apply w-[12px] h-[12px] rounded-[3px]; }
  svg { @apply block w-full min-w-[560px] text-muted; }
  svg text { @apply [fill:currentColor] text-[11px]; }
  summary { @apply cursor-pointer text-[13px]; }
  table { @apply w-full border-collapse text-[13px] text-left; }
  th,td { @apply p-[10px] [border-bottom:1px_solid_var(--color-line)]; }
  @media (max-width:650px) {
    .metrics { @apply grid-cols-[repeat(2,minmax(0,1fr))]; }
    .panel { @apply p-[20px]; }
  }
</style>
