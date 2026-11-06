<script lang="ts">
  import type {Snippet} from 'svelte';
  import {notices, dismissNotice} from '$lib/notices.js';
  let {message, children, error = false}: {message: string; children?: Snippet; error?: boolean} = $props();
  $effect(() => {
    if (!message) return;
    const id = Symbol();
    notices.update(items => [...items, {id, message, children, error}]);
    const timer = error ? undefined : setTimeout(() => dismissNotice(id), 7000);
    return () => {clearTimeout(timer); dismissNotice(id);};
  });
</script>
