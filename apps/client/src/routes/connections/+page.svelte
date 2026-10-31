<script lang="ts">
  import ConnectionCodes from "$lib/ConnectionCodes.svelte";
  let {data}=$props();
</script>
<svelte:head><title>Connections · Haili</title></svelte:head>
<div class="min-w-0">
  <header class="page-heading"><h1 class="hail-title">Connections</h1></header>
  <p><a href="/settings/conversations">Shared conversation preferences</a></p>
  <ConnectionCodes owner={data.account.did} initialList={data.initialList} avatars={data.avatars} />
</div>
