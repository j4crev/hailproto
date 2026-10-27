<script lang="ts">
  import Icon from "./Icon.svelte";
  import {deliveryIcon} from "./delivery-status.js";
  import type {SentItem} from "./messages.js";
  let {state}: {state: SentItem["state"]} = $props();
</script>

<span class="inline-flex align-middle" aria-hidden="true">
  {#if state === "delivered"}<Icon name="double-check" size={16} />
  {:else}<b>{deliveryIcon(state)}</b>{/if}
</span>
