<script lang="ts">
  import {loadThreadCount} from './thread-count.js';
  let {thread}:{thread:{sender:string;messageId:string}}=$props();
  let summary=$state<{count:number;truncated:boolean}|null>(null);
  $effect(()=>{
    const {sender,messageId}=thread;
    const controller=new AbortController();
    summary=null;
    void loadThreadCount(sender,messageId,AbortSignal.any([controller.signal,AbortSignal.timeout(8000)]))
      .then(value=>{if(!controller.signal.aborted)summary=value;});
    return ()=>controller.abort();
  });
</script>
{#if summary}<span class="thread-count" title={`${summary.truncated?'At least ':''}${summary.count} unread messages in this thread`}><span aria-hidden="true">({summary.count}{summary.truncated?'+':''})</span><span class="sr-only">{summary.truncated?'At least ':''}{summary.count} unread messages in this thread</span></span>{/if}
<style>
  .thread-count { flex-shrink:0; color:var(--color-muted); font-size:12px; font-weight:400; white-space:nowrap; }
</style>
