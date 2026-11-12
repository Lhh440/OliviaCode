/**
 * 只读环境变量，供开发或自托管时预置模型连接。
 * 密钥不从仓库、不落磁盘，只经 IPC 交给渲染层内存。
 */
function readEnv() {
  return {
    baseUrl: process.env.OLIVIA_BASE_URL || '',
    apiKey: process.env.OLIVIA_API_KEY || '',
    model: process.env.OLIVIA_MODEL || '',
  };
}

module.exports = { readEnv };
