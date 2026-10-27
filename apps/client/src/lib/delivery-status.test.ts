import {describe,expect,it} from "vitest";
import {deliveryDescription,deliveryIcon} from "./delivery-status.js";

describe("delivery status presentation",()=>{
  it("distinguishes retryable uncertainty from terminal failure",()=>{
    expect(deliveryIcon("accepted")).toBe("✓");expect(deliveryIcon("delivered")).toBe("✓✓");
    expect(deliveryDescription({state:"indeterminate",reason:null,retryAt:null})).toContain("safe");
    expect(deliveryDescription({state:"failed",reason:"body-invalid",retryAt:null})).toContain("permanently");
  });
});
