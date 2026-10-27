<script lang="ts">
  import ConnectionCodes from "$lib/ConnectionCodes.svelte";
  let {data}=$props();
</script>
<svelte:head><title>Connections · Haili</title></svelte:head>
<div class="mx-auto max-w-[860px]">
  <header class="page-heading"><p class="hail-eyebrow">Better together</p><h1 class="hail-title">Connections</h1><p>Share a code to connect, then talk on your terms.</p></header>
  <ConnectionCodes owner={data.account.did} initialList={data.initialList} avatars={data.avatars} />
</div>
