<script lang="ts">
  let {files=[],sender,messageId}:{files?:{filename:string;size:number;digest:{value:string}}[];sender:string;messageId:string}=$props();
</script>
{#if files.length}
  <section aria-label="Attachments" class="my-5 border-t border-line pt-4">
    <h2 class="text-sm font-semibold">Attachments</h2>
    <ul>{#each files as file,index}<li class="my-2"><a download href={`/attachments/${encodeURIComponent(sender)}/${encodeURIComponent(messageId)}/${encodeURIComponent(file.digest.value)}?index=${index}`}>{file.filename}</a> <span class="text-sm text-muted">({file.size.toLocaleString()} bytes)</span></li>{/each}</ul>
  </section>
{/if}
