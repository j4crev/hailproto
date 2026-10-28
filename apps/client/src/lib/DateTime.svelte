<script lang="ts">
  import {onMount} from "svelte";
  import {listDate} from "./list-date.js";
  let {value, format = "full"}: {value: string | number; format?: "full" | "list"} = $props();
  let now = $state<Date | null>(null);
  const date = $derived(new Date(value));
  const valid = $derived(Number.isFinite(date.getTime()));
  // The server cannot know the browser's timezone. Format only after mounting,
  // and refresh relative day labels when a page remains open across midnight.
  onMount(() => {
    now = new Date();
    if (format !== "list") return;
    const timer = setInterval(() => now = new Date(), 60_000);
    return () => clearInterval(timer);
  });
  const full = $derived(now && valid ? new Intl.DateTimeFormat(undefined, {dateStyle: "long", timeStyle: "short"}).format(date) : undefined);
</script>

<time datetime={valid ? date.toISOString() : undefined} title={full}>{!valid ? "Unknown date" : now ? format === "list" ? listDate(date, now) : full : "…"}</time>
