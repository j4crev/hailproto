<script lang="ts">
  import ConnectionCodes from "$lib/ConnectionCodes.svelte";
  let {data}=$props();
</script>
<svelte:head><title>Connections · Haili</title></svelte:head>
<div class="mx-auto max-w-[860px]">
  <header class="page-heading"><h1 class="hail-title">Connections</h1></header>
  <ConnectionCodes owner={data.account.did} initialList={data.initialList} avatars={data.avatars} />
</div>
