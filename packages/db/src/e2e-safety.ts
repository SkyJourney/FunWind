export const E2E_DATABASE_NAME = "qysub_next_e2e";
/** M12 安装向导 E2E 的 CLI 路径专用库（真实空库 → install:cli 一步安装） */
export const INSTALL_CLI_DATABASE_NAME = "qysub_next_install_cli";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function assertLoopback(host: string): void {
  if (!LOOPBACK_HOSTS.has(host.toLowerCase())) {
    throw new Error("E2E 重置只允许连接本机 MySQL");
  }
}

export function assertE2eResetTarget(database: string, host: string): void {
  if (database !== E2E_DATABASE_NAME) {
    throw new Error(`E2E 重置只允许目标数据库 ${E2E_DATABASE_NAME}`);
  }
  assertLoopback(host);
}

export function assertInstallCliResetTarget(database: string, host: string): void {
  if (database !== INSTALL_CLI_DATABASE_NAME) {
    throw new Error(`安装 CLI E2E 重置只允许目标数据库 ${INSTALL_CLI_DATABASE_NAME}`);
  }
  assertLoopback(host);
}
