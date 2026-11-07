import { describe, expect, it } from 'vitest';
import { validatePayload } from '../src/index.js';
import { envelope } from './fixtures.js';

describe('bounded envelope retention',()=>{
  it('accepts the exact 31-day availability and token boundary',()=>{
    const value=structuredClone(envelope);
    value.body.available_until=value.body.access.expires_at=value.created_at+2_678_400;
    expect(()=>validatePayload('hail.envelope',value)).not.toThrow();
  });
  it.each(['availability','token','year-2100'])('rejects overlong %s commitments',kind=>{
    const value=structuredClone(envelope);
    value.body.available_until=value.body.access.expires_at=value.created_at+2_678_400;
    if(kind==='availability')value.body.available_until=value.body.access.expires_at=value.created_at+2_678_401;
    if(kind==='token')value.body.access.expires_at++;
    if(kind==='year-2100')value.body.available_until=value.body.access.expires_at=4_102_444_800;
    expect(()=>validatePayload('hail.envelope',value)).toThrow();
  });
});
