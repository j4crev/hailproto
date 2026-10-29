import {parseBody, parseMessage, type MessageView} from './messages.js';
import {composeBlocks} from './compose.js';

// A source reference is local inbox identity, not reply authorization. Never copy
// the original envelope or reply capability into the outgoing connection send.
export interface MessageReference {sender: string; messageId: string}
export function forwardHref(source: MessageReference): string {
  return `/compose?${new URLSearchParams({audience: 'connections', forwardSender: source.sender, forwardMessage: source.messageId})}`;
}
export function forwardSource(value: unknown, reference: MessageReference) {
  const message = parseMessage(value);
  if (message.sender !== reference.sender || message.messageId !== reference.messageId || message.trashedAt) {
    throw new Error('Forward source unavailable');
  }
  return {message, body: (value as {body: Record<string, unknown>}).body};
}
function literal(text: string) {
  return {_type: 'block', style: 'normal', children: [{_type: 'span', text, marks: []}], markDefs: []};
}
export function forwardBody(source: {message: MessageView; body: Record<string, unknown>}, note: string) {
  const {message, body} = source;
  // Keep bundled assets and their required first image block intact.
  const original = structuredClone(body.blocks as Record<string, unknown>[]);
  const image = body.profile === 'spt-3' ? original.shift() : null;
  const subject = original[0]?.style === 'h1' ? original.shift() : null;
  const result = {...body, profile: body.profile === 'spt-1' ? 'spt-2' : body.profile,
    blocks: [...(image ? [image] : []), ...(subject ? [subject] : []), ...composeBlocks('', note),
      literal('Forwarded message'),
      literal(`From: ${message.senderAddress ?? message.sender}\nSender DID: ${message.sender}\nOriginally received: ${message.deliveredAt}\nMessage ID: ${message.messageId}`),
      ...original]};
  parseBody(result);
  return result;
}
