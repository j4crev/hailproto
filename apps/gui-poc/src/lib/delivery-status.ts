import type {SentItem} from "./messages.js";

export const deliveryIcon=(state:SentItem["state"])=>state==="accepted"?"✓":state==="delivered"?"✓✓":state==="on-hold"?"…":state==="indeterminate"?"?":"!";

const words=(reason:string|null)=>reason?.replaceAll("-"," ")??"unspecified reason";

export function deliveryDescription(message:Pick<SentItem,"state"|"reason"|"retryAt">):string {
  switch(message.state){
    case "indeterminate":return "No authenticated receipt yet. Retrying the same message is safe.";
    case "accepted":return "The recipient accepted this message and is processing delivery.";
    case "delivered":return "Delivered to the recipient inbox.";
    case "on-hold":return `Delivery is paused: ${words(message.reason)}.${message.retryAt?` The recipient plans to retry ${new Date(message.retryAt*1000).toLocaleString()}.`:""}`;
    case "failed":return `Delivery failed permanently: ${words(message.reason)}. Send a new message if it is still needed.`;
    case "cancelled":return `Delivery was cancelled: ${words(message.reason)}. Send a new message if it is still needed.`;
  }
}
