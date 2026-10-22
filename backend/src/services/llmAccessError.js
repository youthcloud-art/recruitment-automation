// Only access/charging failures are sticky. Timeouts and rate limits may be
// transient and must keep their existing per-candidate failure behaviour.
const ACCESS_FAILURES = {
  401: { code: 'LLM_AUTH_FAILED', message: '大模型 API 认证失败（401）：请检查 API 密钥，恢复后可用“批量评估岗位匹配”补评；简历已保留。' },
  402: { code: 'LLM_BILLING_REQUIRED', message: '大模型 API 返回 402：需检查余额/计费，恢复后可用“批量评估岗位匹配”补评；简历已保留。' },
  403: { code: 'LLM_ACCESS_FORBIDDEN', message: '大模型 API 拒绝访问（403）：请检查密钥权限与计费，恢复后可用“批量评估岗位匹配”补评；简历已保留。' }
};

function classifyLlmAccessError(error) {
  const status = Number(error?.httpStatus ?? error?.response?.status ?? error?.status);
  if (ACCESS_FAILURES[status]) return { ...ACCESS_FAILURES[status], httpStatus: status };
  const code = String(error?.code || '');
  const byCode = Object.entries(ACCESS_FAILURES).find(([, value]) => value.code === code);
  if (byCode) return { ...byCode[1], httpStatus: Number(byCode[0]) };
  const message = String(error?.message || '');
  const byMessage = message.match(/(?:\bHTTP\s*|\bAPI\s*(?:错误|返回)?\s*)?(401|402|403)\b/i);
  if (byMessage) return { ...ACCESS_FAILURES[Number(byMessage[1])], httpStatus: Number(byMessage[1]) };
  if (/LLM_API_KEY.*(?:未设置|无效|过期)/i.test(message)) {
    return { code: 'LLM_AUTH_FAILED', httpStatus: null,
      message: '大模型 API 密钥未配置或失效：请检查密钥，恢复后可用“批量评估岗位匹配”补评；简历已保留。' };
  }
  return null;
}

module.exports = { classifyLlmAccessError };
