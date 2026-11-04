<script lang="ts">
  import type {StorageStats} from "@racrproto/client-support/provider-contracts";
  let {storage}:{storage:StorageStats|null|undefined}=$props();
  function bytes(value:number){
    if(value<1024)return `${value} B`;
    const unit=Math.min(4,Math.floor(Math.log(value)/Math.log(1024)));
    return `${(value/1024**unit).toLocaleString("en-US",{maximumFractionDigits:1})} ${["B","KiB","MiB","GiB","TiB"][unit]}`;
  }
</script>
<section aria-labelledby="storage-heading">
  <h3 id="storage-heading">Database storage</h3>
  {#if storage}
    <dl>
      <div><dt>Total database</dt><dd>{bytes(storage.databaseBytes)}</dd></div>
      <div><dt>Hail storage</dt><dd>{bytes(storage.applicationBytes)}</dd></div>
      <div><dt>Of which: lookup indexes</dt><dd>{bytes(storage.indexBytes)}</dd></div>
    </dl>
    <p>Lookup indexes are extra structures that speed up database searches. They are already included in Hail storage and category totals.</p>
    <div class="scroll overflow-auto"><table><thead><tr><th scope="col">Category</th><th scope="col">Data & storage overhead</th><th scope="col">Lookup indexes</th><th scope="col">Total</th></tr></thead><tbody>
      {#each storage.categories as category (category.id)}
        <tr><th scope="row">{category.label}</th><td>{bytes(category.tableBytes)}</td><td>{bytes(category.indexBytes)}</td><td>{bytes(category.totalBytes)}</td></tr>
      {/each}
    </tbody></table></div>
    <p>Other database storage: {bytes(storage.otherDatabaseBytes)} (approximately). Includes system catalogs and storage outside application tables.</p>
    <p>Allocated space includes stored content, row overhead, and reusable space from deleted records. Sizes may change during collection.</p>
    <p>Message bodies and attachments live in the database and are included in message content. Migration history may contain additional copies of messages.</p>
    <p>This is a current storage snapshot, independent of the activity period. Backups, PostgreSQL transaction logs, and host disk capacity are not included.</p>
  {:else}<p role="status">Storage statistics are temporarily unavailable.</p>{/if}
</section>
<style lang="postcss">
  @reference "../app.css";

  section { @apply [margin:28px_0] [border-top:1px_solid_var(--color-line)] pt-[8px]; }
  h3 { @apply text-[16px]; }
  dl { @apply flex flex-wrap gap-[24px]; }
  dt { @apply text-[13px] text-muted; }
  dd { @apply [margin:8px_0] text-[24px] font-[650]; }
  table { @apply w-full border-collapse text-[13px] text-left; }
  th,td { @apply [padding:12px_10px] [border-bottom:1px_solid_var(--color-line)]; }
  td { @apply whitespace-nowrap; }
  thead th { @apply text-muted; }
  p { @apply text-[13px] leading-[1.6] text-muted; }
</style>
