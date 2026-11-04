<script lang="ts">
  import type {Snippet} from 'svelte';
  import Icon from '$lib/Icon.svelte';
  let {label,count,locked=false,busy=false,onclear,onselectall,actions,children}: {
    label:string;count?:number;locked?:boolean;busy?:boolean;onclear?:()=>void;onselectall?:()=>void;
    actions:Snippet;children?:Snippet;
  }=$props();
</script>
<section class="selection-actions" aria-label={label} aria-busy={busy}>
  <div class="action-row flex flex-wrap items-center gap-[8px]">
    <span class="action-count flex-1 text-[14px] font-[600] whitespace-nowrap" role="status">{count===undefined?label:`${count} selected`}</span>
    {#if onselectall}<button class="hail-button-secondary" disabled={locked} onclick={onselectall}>Select all</button>{/if}
    {@render actions()}
    {#if onclear}<button class="hail-icon-button" type="button" aria-label="Clear selection" title="Clear selection" disabled={locked} onclick={onclear}><Icon name="close" /></button>{/if}
  </div>
  {#if children}{@render children()}{/if}
</section>
<style lang="postcss">
  @reference "../app.css";

  .selection-actions {
    @apply sticky top-[16px] z-[5] grid gap-[12px] mb-[20px] [padding:12px_16px] [border:1px_solid_var(--color-line)]
      rounded-[14px] [background:var(--color-surface)] [box-shadow:0_4px_20px_#172b2d0d];
  }
  @media (max-width:900px) {
    .selection-actions {
      @apply fixed [inset:auto_0_0] z-[11] m-0 [border-radius:16px_16px_0_0]
        [padding:12px_max(18px,_env(safe-area-inset-right))_max(12px,_env(safe-area-inset-bottom))_max(18px,_env(safe-area-inset-left))]
        max-h-[50dvh] overflow-y-auto;
    }
  }
</style>
