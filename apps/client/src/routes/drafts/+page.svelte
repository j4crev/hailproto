<script lang="ts">
  import {page} from '$app/state';
  import DraftList from '$lib/DraftList.svelte';
  import MailboxEmptyState from '$lib/MailboxEmptyState.svelte';
  let {data}=$props();
</script>
<svelte:head><title>Drafts · {page.data.branding?.name??'Hail'}</title></svelte:head>
<div class="min-w-0 pb-28 min-[901px]:pb-0">
  <header class="page-heading"><h1 class="hail-title">Drafts</h1></header>
  <DraftList drafts={data.drafts} address={data.account.address} trashEnabled={data.trashEnabled}/>
  {#if !data.drafts.length}<MailboxEmptyState icon="compose" title="No writer's block here."/>{/if}
  {#if data.paged||data.next}<nav class="mt-6 flex gap-3" aria-label="Draft pages">{#if data.paged}<a href="/drafts">Newest drafts</a>{/if}{#if data.next}<a href={`/drafts?after=${data.next}`}>Older drafts</a>{/if}</nav>{/if}
</div>
