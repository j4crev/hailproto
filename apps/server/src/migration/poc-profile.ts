export function assertPrivatePocRegistry(registryOrigin: string, serviceBase: string): void {
  const live = registryOrigin === "http://plc:2582" &&
    ["https://hailproto.app/hail", "https://hailproto.dev/hail"].includes(serviceBase);
  const disposable = process.env.NODE_ENV !== "production" &&
    registryOrigin === "http://plc.fixture:2582" &&
    ["https://source.example.com/hail", "https://target.example.com/hail"].includes(serviceBase);
  if (!live && !disposable) {
    throw new Error("Private POC cutover requires the pinned internal PLC and POC service base");
  }
}
