export const E2E_DATABASE_NAME = "qysub_next_e2e";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function assertE2eResetTarget(database: string, host: string): void {
  if (database !== E2E_DATABASE_NAME) {
    throw new Error(`E2E 重置只允许目标数据库 ${E2E_DATABASE_NAME}`);
  }
  if (!LOOPBACK_HOSTS.has(host.toLowerCase())) {
    throw new Error("E2E 重置只允许连接本机 MySQL");
  }
}
