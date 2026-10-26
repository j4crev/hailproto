<script lang="ts">
  import PasskeySignIn from "$lib/PasskeySignIn.svelte";
  let {data} = $props();
</script>
<svelte:head><title>Sign in · Haili</title></svelte:head>
<section class="hail-card mx-auto mt-8 grid max-w-[520px] gap-6 p-8 sm:p-12">
  <p class="hail-eyebrow">Welcome back</p>
  <h1 class="hail-title">Sign in to Haili</h1>
  <p class="m-0 text-sm text-muted">{data.returnTo !== "/" ? "Sign in to continue. You’ll review any pending action before approving it." : "Your inbox is one passkey away."}</p>
  <PasskeySignIn returnTo={data.returnTo} />
</section>
