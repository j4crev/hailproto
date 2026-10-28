<script lang="ts">
  import {onMount} from "svelte";
  import {listDate} from "./list-date.js";
  let {value}: {value: string | number} = $props();
  let now = $state(new Date());
  const date = $derived(new Date(value));
  onMount(() => {
    now = new Date();
    const timer = setInterval(() => now = new Date(), 60_000);
    return () => clearInterval(timer);
  });
</script>

<time datetime={date.toISOString()} title={date.toLocaleString()}>{listDate(date, now)}</time>
