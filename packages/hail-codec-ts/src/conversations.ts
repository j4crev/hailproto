import {createHash,timingSafeEqual} from "node:crypto";
import {HailCodecError} from "./errors.js";
import type {HailConversation,HailConversationRevival} from "./models.js";
import type {VerifiedHailObject} from "./types.js";

/** Check cross-object bindings after signature verification. This grants nothing:
 * the receiver must still check freshness, connection policy, lease/leave state
 * and the persisted request replay record transactionally. */
export function validateConversationRevivalBinding(
  descriptor:VerifiedHailObject<HailConversation>,request:VerifiedHailObject<HailConversationRevival>,
):void {
  const conversation=descriptor.payload,revival=request.payload;
  const hash=createHash("sha256").update(descriptor.representationBytes).digest();
  if(descriptor.type!=="hail.conversation"||request.type!=="hail.conversation-revival"||
    revival.from!==conversation.from||revival.conversation_id!==conversation.conversation_id||
    !conversation.participants.includes(revival.to)||revival.issued_at<conversation.created_at||
    revival.descriptor_hash.value.length!==hash.length||!timingSafeEqual(revival.descriptor_hash.value,hash))
    throw new HailCodecError("schema-violation","revival must bind the original creator, roster and exact signed descriptor","$");
}
