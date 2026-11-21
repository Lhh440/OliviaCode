/**
 * 把模型端点吐出来的原始错误翻成人话。
 *
 * 端点的报错形态太多：`{"error":{"code":"insufficient_quota"}}`、纯文本 502、
 * 被 fetch 包装的 ECONNREFUSED……直接把原文甩给用户等于没说。
 * 这里只做一层「认得出就说得明白，认不出就保留原文尾部」的映射，不猜细节。
 */

export interface HumanError {
  /** 面向用户的一句话 */
  message: string;
  /** 值得重试（超时、限流、端点抖动） */
  retryable: boolean;
  /** 认出的错误类型，便于埋点/测试 */
  code?: string;
}

interface Rule {
  code: string;
  match: RegExp;
  message: string;
  retryable: boolean;
}

const RULES: Rule[] = [
  {
    code: 'insufficient_quota',
    match: /insufficient_quota|insufficient balance|余额不足|quota exceeded/i,
    message: '账号余额或额度不足：到提供商控制台充值，或换一个模型/提供商再试。',
    retryable: false,
  },
  {
    code: 'invalid_api_key',
    match: /invalid[_ ]?api[_ ]?key|incorrect api key|unauthorized|401/i,
    message: 'API Key 无效或已过期：到「设置 → 模型接入」重新保存密钥。',
    retryable: false,
  },
  {
    code: 'rate_limit',
    match: /rate[_ ]?limit|too many requests|429/i,
    message: '请求太频繁被限流了：等几秒再重试。',
    retryable: true,
  },
  {
    code: 'model_not_found',
    match: /model[_ ]?not[_ ]?found|does not exist|unknown model|404/i,
    message: '端点没有这个模型：检查模型 ID 是否和提供商目录一致。',
    retryable: false,
  },
  {
    code: 'context_length',
    match: /context[_ ]length|maximum context|too many tokens|超出上下文/i,
    message: '这次请求超出模型上下文：先整理任务记忆，或另开一个任务。',
    retryable: false,
  },
  {
    code: 'connection_refused',
    match: /ECONNREFUSED|connect ECONN|fetch failed|连接被拒绝/i,
    message: '连不上模型端点：本地模型是不是还没启动？确认地址和端口后再试。',
    retryable: true,
  },
  {
    code: 'timeout',
    match: /ETIMEDOUT|timed? ?out|超时/i,
    message: '模型端点响应超时：本地模型加载慢时可以先等一会儿再重试。',
    retryable: true,
  },
  {
    code: 'server_error',
    match: /\b50[0234]\b|bad gateway|service unavailable|internal server error/i,
    message: '模型端点暂时不可用（服务端错误）：稍后重试。',
    retryable: true,
  },
  {
    code: 'payment_required',
    match: /余额不足 402|402/i,
    message: '端点返回 402（需要付费或额度不足）：检查账户余额。',
    retryable: false,
  },
];

/** 从 `{"error":{"message":"..."}}` 这类报文里取出最能说明问题的一句话。 */
function extractDetail(raw: string): string {
  const text = raw.trim();
  const jsonStart = text.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(text.slice(jsonStart)) as {
        error?: { message?: string; code?: string; type?: string } | string;
        message?: string;
      };
      if (typeof parsed.error === 'string') return parsed.error;
      const inner = parsed.error?.message ?? parsed.message;
      if (typeof inner === 'string' && inner.trim()) return inner.trim();
      if (parsed.error?.code) return String(parsed.error.code);
    } catch {
      // 不是完整 JSON，按纯文本处理
    }
  }
  return text.replace(/\s+/g, ' ').slice(0, 240);
}

export function humanizeModelError(raw: string | undefined | null): HumanError {
  const text = (raw ?? '').trim();
  if (!text) return { message: '模型调用失败，没有更多信息。', retryable: true };

  for (const rule of RULES) {
    if (rule.match.test(text)) {
      const detail = extractDetail(text);
      const extra = detail && !rule.message.includes(detail) ? `（端点原文：${detail}）` : '';
      return { code: rule.code, message: `${rule.message}${extra}`, retryable: rule.retryable };
    }
  }
  return { message: `模型调用失败：${extractDetail(text)}`, retryable: true };
}
