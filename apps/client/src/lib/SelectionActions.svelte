<script lang="ts">
  import type {Snippet} from 'svelte';
  import Icon from '$lib/Icon.svelte';
  let {label,count,locked=false,busy=false,onclear,onselectall,actions,children}: {
    label:string;count?:number;locked?:boolean;busy?:boolean;onclear?:()=>void;onselectall?:()=>void;
    actions:Snippet;children?:Snippet;
  }=$props();
</script>
<section class="selection-actions" aria-label={label} aria-busy={busy}>
  <div class="action-row">
    <span class="action-count" role="status">{count===undefined?label:`${count} selected`}</span>
    {#if onselectall}<button class="hail-button-secondary" disabled={locked} onclick={onselectall}>Select all</button>{/if}
    {@render actions()}
    {#if onclear}<button class="hail-button-secondary" type="button" aria-label="Clear selection" title="Clear selection" disabled={locked} onclick={onclear}><Icon name="close" /></button>{/if}
  </div>
  {#if children}{@render children()}{/if}
</section>
<style>
  .selection-actions { position:sticky; top:16px; z-index:5; display:grid; gap:12px; margin-bottom:20px; padding:12px 16px; border:1px solid var(--color-line); border-radius:14px; background:var(--color-surface); box-shadow:0 4px 20px #172b2d0d; }
  .action-row { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
  .action-count { flex:1; font-size:14px; font-weight:600; white-space:nowrap; }
  @media(max-width:900px) {
    .selection-actions { position:fixed; inset:auto 0 0; z-index:11; margin:0; border-radius:16px 16px 0 0; padding:12px max(18px, env(safe-area-inset-right)) max(12px, env(safe-area-inset-bottom)) max(18px, env(safe-area-inset-left)); max-height:50dvh; overflow-y:auto; }
  }
</style>
