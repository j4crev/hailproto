<script lang="ts">
  import type {StorageStats} from "../../../server/src/operator/storage.js";
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
    <div class="scroll"><table><thead><tr><th scope="col">Category</th><th scope="col">Data & storage overhead</th><th scope="col">Lookup indexes</th><th scope="col">Total</th></tr></thead><tbody>
      {#each storage.categories as category (category.id)}
        <tr><th scope="row">{category.label}</th><td>{bytes(category.tableBytes)}</td><td>{bytes(category.indexBytes)}</td><td>{bytes(category.totalBytes)}</td></tr>
      {/each}
    </tbody></table></div>
    <p>Other database storage: {bytes(storage.otherDatabaseBytes)} (approximately). Includes system catalogs and storage outside application tables.</p>
    <p>Allocated space includes stored content, row overhead, and reusable space from deleted records. Sizes may change during collection.</p>
    <p>Message bodies live in the database. Attachments are not supported yet; no separate attachment store is measured. Migration history may contain additional copies of messages.</p>
    <p>This is a current storage snapshot, independent of the activity period. Backups, PostgreSQL transaction logs, and host disk capacity are not included.</p>
  {:else}<p role="status">Storage statistics are temporarily unavailable.</p>{/if}
</section>
<style>
  section{margin:28px 0;border-top:1px solid var(--color-line);padding-top:8px}h3{font-size:16px}dl{display:flex;flex-wrap:wrap;gap:24px}dt{font-size:13px;color:var(--color-muted)}dd{margin:8px 0;font-size:24px;font-weight:650}.scroll{overflow:auto}table{width:100%;border-collapse:collapse;font-size:13px;text-align:left}th,td{padding:12px 10px;border-bottom:1px solid var(--color-line)}td{white-space:nowrap}thead th{color:var(--color-muted)}p{font-size:13px;line-height:1.6;color:var(--color-muted)}
</style>
