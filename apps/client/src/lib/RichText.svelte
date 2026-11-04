<script lang="ts">
  import Renderer from '@racrproto/content-builder/renderer';
  import type {MessageBlock,MessageImage} from './messages.js';
  let {blocks,header=null}:{blocks:MessageBlock[];header?:MessageImage|null}=$props();
</script>
<Renderer {blocks} {header}/>
