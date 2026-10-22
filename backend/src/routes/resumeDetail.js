const { publicCandidate } = require('../utils/candidateDisplay');

function createResumeDetailHandler(store) {
  return async (req, res) => {
    // A resume includes personal information. Neither a successful response nor
    // a missing-ID response should be kept by a browser or a shared cache.
    res.set('Cache-Control', 'private, no-store');
    try {
      const { id } = req.params;
      const resume = typeof store.getResumeById === 'function'
        ? await store.getResumeById(id)
        // Compatibility for older injected stores that only expose getResumes.
        : (await store.getResumes()).find(item => item.id === id);
      if (!resume) {
        return res.status(404).json({ success: false, message: '简历不存在' });
      }
      return res.json({ success: true, data: publicCandidate(resume) });
    } catch (error) {
      console.error('获取简历详情失败:', error);
      // Do not echo storage exceptions, which may include private record text.
      return res.status(500).json({ success: false, message: '获取简历详情失败' });
    }
  };
}

module.exports = { createResumeDetailHandler };
