// The official 51job detail header can expose a surname-style alias while
// withholding the person's full name. Require its specific header structure
// so unrelated names in work history are never promoted to identity.
function qcwyHeaderAlias(originalText) {
  const header = String(originalText || '').slice(0, 1000);
  const match = /(?:^|\r?\n)\s*扫码分享\s*\r?\n\s*([\u4e00-\u9fff]{1,2}(?:先生|女士|同学))\s*(?=\r?\n)/u.exec(header);
  return match?.[1] || '';
}

module.exports = { qcwyHeaderAlias };
