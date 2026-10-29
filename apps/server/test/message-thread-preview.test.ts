import {expect,it} from 'vitest';
import {threadBodyPreview} from '../src/accounts/message-threads.js';
const block=(text:string,style='normal')=>({style,children:[{text}]});
it('previews the response after its preserved title',()=>{
  expect(threadBodyPreview({blocks:[block('Repeated subject','h1'),block('The actual response'),block('Quoted reply','caption'),block('Original content','blockquote')]})).toBe('The actual response');
});
it('skips a header image and title and joins rich text spans',()=>{
  expect(threadBodyPreview({blocks:[{},block('Subject','h1'),{style:'normal',children:[{text:'Hello '},{text:'friend'}]}]})).toBe('Hello friend');
});
it('keeps untitled body content and omits title-only previews',()=>{
  expect(threadBodyPreview({blocks:[block('Plain message')]})).toBe('Plain message');
  expect(threadBodyPreview({blocks:[block('Subject','h1')]})).toBe('');
  expect(threadBodyPreview({blocks:[]})).toBe('');
});
it('normalizes whitespace and bounds previews without splitting Unicode characters',()=>{
  expect(threadBodyPreview({blocks:[block('Hello\n\n  friend')]})).toBe('Hello friend');
  expect(threadBodyPreview({blocks:[block('😀'.repeat(241))]})).toBe('😀'.repeat(239)+'…');
});
