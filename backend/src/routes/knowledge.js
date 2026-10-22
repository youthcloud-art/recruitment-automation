const express = require('express');
const router = express.Router();
const DatabaseManager = require('../database/init');
const KnowledgeService = require('../services/knowledgeService');
const LLMService = require('../services/llmService');

// 初始化服务
let dbManager, knowledgeService, llmService;
let initializationPromise;

async function scopedDocument(req) {
  const companyId = req.query.companyId;
  if (!companyId) return null;
  const document = await knowledgeService.documentService.getDocument(req.params.id);
  return document && String(document.company_id) === String(companyId) ? document : null;
}

// 初始化函数
function initializeServices() {
  if (!initializationPromise) {
    initializationPromise = (async () => {
      const nextDbManager = new DatabaseManager();
      try {
        await nextDbManager.init();
        const nextKnowledgeService = new KnowledgeService(nextDbManager);
        await nextKnowledgeService.vectorService.initTables();
        const nextLlmService = process.env.LLM_API_KEY ? new LLMService() : null;

        // 所有表和服务就绪后再发布，避免并发请求读取部分初始化状态。
        dbManager = nextDbManager;
        knowledgeService = nextKnowledgeService;
        llmService = nextLlmService;
      } catch (error) {
        if (nextDbManager.db) {
          await new Promise(resolve => nextDbManager.db.close(() => resolve()));
        }
        throw error;
      }
    })().catch(error => {
      initializationPromise = null;
      throw error;
    });
  }
  return initializationPromise;
}

// 中间件：确保服务已初始化
router.use(async (req, res, next) => {
  try {
    await initializeServices();
    next();
  } catch (error) {
    console.error('服务初始化失败:', error);
    res.status(500).json({ error: '服务初始化失败' });
  }
});

/**
 * 文档上传
 * POST /api/knowledge/upload
 */
router.post('/upload', async (req, res) => {
  try {
    const upload = knowledgeService.documentService.setupUpload();
    upload.single('document')(req, res, async (err) => {
      if (err) {
        return res.status(400).json({ error: '文件上传失败', message: err.message });
      }
      
      try {
        const { companyId, title } = req.body;
        const file = req.file;

        if (!file) {
          return res.status(400).json({ error: '请选择要上传的文件' });
        }

        if (!companyId) {
          await require('fs').promises.unlink(file.path).catch(() => {});
          return res.status(400).json({ error: '请提供公司ID' });
        }

        console.log(`收到文档上传请求: ${file.originalname}, 公司ID: ${companyId}`);

        const result = await knowledgeService.uploadDocument(file, companyId, title);

        res.json({
          success: true,
          data: result,
          message: '文档上传成功'
        });
      } catch (error) {
        console.error('文档上传失败:', error);
        res.status(422).json({
          error: '文档上传失败',
          message: error.message
        });
      }
    });
  } catch (error) {
    console.error('上传中间件初始化失败:', error);
    res.status(500).json({
      error: '上传中间件初始化失败',
      message: error.message
    });
  }
});

/**
 * 获取文档列表
 * GET /api/knowledge/documents?companyId=1
 */
router.get('/documents', async (req, res) => {
  try {
    const { companyId } = req.query;

    if (!companyId) {
      return res.status(400).json({ error: '请提供公司ID' });
    }

    const documents = await knowledgeService.getDocuments(companyId);

    res.json({
      success: true,
      data: documents
    });

  } catch (error) {
    console.error('获取文档列表失败:', error);
    res.status(500).json({
      error: '获取文档列表失败',
      message: error.message
    });
  }
});

/**
 * 获取文档详情
 * GET /api/knowledge/documents/:id
 */
router.get('/documents/:id', async (req, res) => {
  try {
    if (!req.query.companyId) return res.status(400).json({ error: '请提供公司ID' });
    const document = await scopedDocument(req);

    if (!document) {
      return res.status(404).json({ error: '文档不存在' });
    }

    res.json({
      success: true,
      data: document
    });

  } catch (error) {
    console.error('获取文档详情失败:', error);
    res.status(500).json({
      error: '获取文档详情失败',
      message: error.message
    });
  }
});

/**
 * 获取文档块内容
 * GET /api/knowledge/documents/:id/chunks
 */
router.get('/documents/:id/chunks', async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.query.companyId) return res.status(400).json({ error: '请提供公司ID' });
    if (!await scopedDocument(req)) {
      return res.status(404).json({ error: '文档不存在' });
    }
    const chunks = await knowledgeService.getDocumentChunks(id);

    res.json({
      success: true,
      data: chunks
    });

  } catch (error) {
    console.error('获取文档块失败:', error);
    res.status(500).json({
      error: '获取文档块失败',
      message: error.message
    });
  }
});

/**
 * 下载文档文件
 * GET /api/knowledge/documents/:id/download
 */
router.get('/documents/:id/download', async (req, res) => {
  try {
    if (!req.query.companyId) return res.status(400).json({ error: '请提供公司ID' });
    const document = await scopedDocument(req);

    if (!document) {
      return res.status(404).json({ error: '文档不存在' });
    }

    // 检查文件是否存在
    const fs = require('fs');
    if (!fs.existsSync(document.file_path)) {
      return res.status(404).json({ error: '文件不存在' });
    }

    res.download(document.file_path, document.title);

  } catch (error) {
    console.error('下载文档失败:', error);
    res.status(500).json({
      error: '下载文档失败',
      message: error.message
    });
  }
});

/**
 * 删除文档
 * DELETE /api/knowledge/documents/:id
 */
router.delete('/documents/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.query.companyId) return res.status(400).json({ error: '请提供公司ID' });
    if (!await scopedDocument(req)) {
      return res.status(404).json({ error: '文档不存在' });
    }
    const result = await knowledgeService.deleteDocument(id);

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('删除文档失败:', error);
    res.status(500).json({
      error: '删除文档失败',
      message: error.message
    });
  }
});

/**
 * 知识库检索
 * POST /api/knowledge/retrieve
 */
router.post('/retrieve', async (req, res) => {
  try {
    const { query, companyId, limit = 5 } = req.body;

    if (!query || !companyId) {
      return res.status(400).json({ error: '请提供查询内容和公司ID' });
    }

    console.log(`收到检索请求: ${query}, 公司ID: ${companyId}`);

    const results = await knowledgeService.retrieveKnowledge(query, companyId, limit);
    const context = knowledgeService.buildContext(results);

    res.json({
      success: true,
      data: {
        query,
        results,
        context,
        total: results.length
      }
    });

  } catch (error) {
    console.error('知识库检索失败:', error);
    res.status(500).json({
      error: '知识库检索失败',
      message: error.message
    });
  }
});

/**
 * 带知识库的AI对话
 * POST /api/knowledge/chat
 */
router.post('/chat', async (req, res) => {
  try {
    const { query, companyId, thinkingCallback, finalAnswerCallback } = req.body;

    if (!query || !companyId) {
      return res.status(400).json({ error: '请提供查询内容和公司ID' });
    }

    const currentLlmService = process.env.LLM_API_KEY ? new LLMService() : null;
    if (!currentLlmService) {
      return res.status(503).json({
        error: 'AI服务尚未配置',
        message: '请在智能招聘助手的“模型配置”中填写 DeepSeek API Key'
      });
    }

    console.log(`收到AI对话请求: ${query}, 公司ID: ${companyId}`);

    // 1. 检索相关知识
    const results = await knowledgeService.retrieveKnowledge(query, companyId, 5);
    const context = knowledgeService.buildContext(results);

    // 2. 使用LLM生成回答
    const response = await currentLlmService.chatWithKnowledgeBase(
      query,
      context,
      thinkingCallback,
      finalAnswerCallback
    );

    res.json({
      success: true,
      data: {
        query,
        response,
        context,
        retrievedDocs: results
      }
    });

  } catch (error) {
    console.error('AI对话失败:', error);
    res.status(500).json({
      error: 'AI对话失败',
      message: error.message
    });
  }
});

/**
 * 搜索文档
 * GET /api/knowledge/search?q=关键词&companyId=1
 */
router.get('/search', async (req, res) => {
  try {
    const { q, companyId, limit = 10 } = req.query;

    if (!q || !companyId) {
      return res.status(400).json({ error: '请提供搜索关键词和公司ID' });
    }

    const results = await knowledgeService.searchDocuments(q, companyId, limit);

    res.json({
      success: true,
      data: {
        query: q,
        results,
        total: results.length
      }
    });

  } catch (error) {
    console.error('搜索文档失败:', error);
    res.status(500).json({
      error: '搜索文档失败',
      message: error.message
    });
  }
});

/**
 * 获取知识库统计信息
 * GET /api/knowledge/stats?companyId=1
 */
router.get('/stats', async (req, res) => {
  try {
    const { companyId } = req.query;

    if (!companyId) {
      return res.status(400).json({ error: '请提供公司ID' });
    }

    const stats = await knowledgeService.getStats(companyId);

    res.json({
      success: true,
      data: stats
    });

  } catch (error) {
    console.error('获取统计信息失败:', error);
    res.status(500).json({
      error: '获取统计信息失败',
      message: error.message
    });
  }
});

/**
 * 重新处理失败的文档
 * POST /api/knowledge/reprocess?companyId=1
 */
router.post('/reprocess', async (req, res) => {
  try {
    const { companyId } = req.query;

    if (!companyId) {
      return res.status(400).json({ error: '请提供公司ID' });
    }

    const results = await knowledgeService.reprocessFailedDocuments(companyId);

    res.json({
      success: true,
      data: {
        results,
        total: results.length
      }
    });

  } catch (error) {
    console.error('重新处理文档失败:', error);
    res.status(500).json({
      error: '重新处理文档失败',
      message: error.message
    });
  }
});

/**
 * 健康检查
 * GET /api/knowledge/health
 */
router.get('/health', async (req, res) => {
  try {
    const stats = await knowledgeService.vectorService.getStats();
    
    res.json({
      success: true,
      data: {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        vectorStats: stats
      }
    });

  } catch (error) {
    console.error('健康检查失败:', error);
    res.status(500).json({
      error: '健康检查失败',
      message: error.message
    });
  }
});

module.exports = router;
