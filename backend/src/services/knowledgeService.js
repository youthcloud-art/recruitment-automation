const PersistentVectorService = require('./persistentVectorService');
const DocumentService = require('./documentService');
const fs = require('fs').promises;

/**
 * 知识库服务类
 * 整合文档处理和向量检索，提供统一的知识库管理接口
 */
class KnowledgeService {
  constructor(dbManager) {
    this.vectorService = new PersistentVectorService(dbManager);
    this.documentService = new DocumentService(dbManager);
    this.dbManager = dbManager;
  }

  /**
   * 上传并处理文档
   */
  async uploadDocument(file, companyId, title) {
    let documentId = null;
    try {
      console.log(`开始处理文档: ${file.originalname}`);

      // 1. 保存文档记录
      const document = await this.documentService.saveDocument(file, companyId, title);
      documentId = document.id;
      console.log(`文档记录已保存，ID: ${document.id}`);

      // 2. 解析文档内容
      const content = await this.documentService.parseDocument(file.path, file.mimetype);
      console.log(`文档解析完成，内容长度: ${content.length}`);

      // 3. 文档分块
      const chunks = this.documentService.chunkDocument(content);
      console.log(`文档分块完成，共 ${chunks.length} 个块`);

      if (chunks.length === 0) {
        throw new Error('文档中没有可检索的文字内容，请上传包含文字的文件');
      }

      // 4. 保存文档块到数据库
      await this.documentService.saveDocumentChunks(document.id, chunks);
      console.log(`文档块已保存到数据库`);

      // 文档块是检索的持久化数据源。旧的本地 TF-IDF 实现在较大文档上
      // 会长时间阻塞上传，而且查询时会改变词汇表；仅显式开启时保留它。
      if (process.env.KNOWLEDGE_ENABLE_VECTORS === 'true') {
        try {
          await this.vectorService.storeDocumentVectors(chunks, document.id, {
            document_id: document.id,
            document_title: document.title,
            company_id: companyId,
            file_type: document.file_type
          });
        } catch (vectorError) {
          console.warn('向量化失败，仍可使用文档检索:', vectorError.message);
        }
      }

      // 6. 更新文档状态
      await this.documentService.updateDocumentStatus(document.id, 'processed');

      return {
        success: true,
        documentId: document.id,
        title: document.title,
        chunks: chunks.length,
        message: '文档处理完成'
      };

    } catch (error) {
      console.error('文档处理失败:', error);

      // Upload is synchronous. On failure remove the row and temporary upload,
      // so the library does not retain an unusable document or orphaned file.
      if (documentId) {
        try {
          await this.vectorService.deleteDocumentVectors(documentId);
          await this.documentService.deleteDocument(documentId);
        } catch (cleanupError) {
          console.error('清理失败的文档记录失败:', cleanupError);
        }
      }
      if (file?.path) await fs.unlink(file.path).catch(() => {});

      throw new Error(`文档处理失败: ${error.message}`);
    }
  }

  /**
   * 智能检索知识库
   */
  async retrieveKnowledge(query, companyId, limit = 5) {
    try {
      const text = String(query || '').trim().toLowerCase();
      if (!text) return [];
      const boundedLimit = Math.min(Math.max(Number(limit) || 5, 1), 30);
      const terms = this.getSearchTerms(text);
      if (terms.length === 0) return [];

      // 从所属公司的已处理文档检索；禁止用其它公司的片段补足结果。
      // 直接查文档块，也能检索尚未生成向量的旧文档或向量化失败的文档。
      const rows = await this.dbManager.all(`
        SELECT dc.id AS chunk_id, dc.content, dc.chunk_index,
               d.id AS document_id, d.title, d.file_type, d.file_size, d.upload_time
        FROM document_chunks dc
        JOIN documents d ON d.id = dc.document_id
        WHERE d.company_id = ? AND d.status = 'processed'
      `, [companyId]);

      const results = rows.map(row => {
        const content = String(row.content || '').toLowerCase();
        const title = String(row.title || '').toLowerCase();
        const matched = terms.filter(term => content.includes(term) || title.includes(term));
        if (matched.length === 0) return null;

        const fullPhrase = content.includes(text) || title.includes(text);
        const titleMatches = terms.some(term => title.includes(term));
        const similarity = Math.min(1, matched.length / terms.length * 0.75 +
          (fullPhrase ? 0.2 : 0) + (titleMatches ? 0.05 : 0));
        return {
          id: row.chunk_id,
          content: row.content,
          similarity: Number(similarity.toFixed(3)),
          metadata: {
            document_id: row.document_id,
            document_title: row.title,
            file_type: row.file_type,
            file_size: row.file_size,
            upload_time: row.upload_time,
            chunk_index: row.chunk_index
          }
        };
      }).filter(Boolean).sort((a, b) => b.similarity - a.similarity)
        .slice(0, boundedLimit);

      await this.logRetrieval(text, results);
      return results;

    } catch (error) {
      console.error('知识库检索失败:', error);
      throw new Error(`检索失败: ${error.message}`);
    }
  }

  getSearchTerms(query) {
    const terms = new Set();
    const stopTerms = new Set(['知识', '文档', '资料', '搜索', '检索', '查询', '查找', '请问', '帮我', '相关', '企业', '公司']);
    const segments = query.match(/[\u3400-\u9fff]{2,}|[a-z0-9][a-z0-9._-]*/g) || [];
    for (const segment of segments) {
      if (/[\u3400-\u9fff]/.test(segment)) {
        if (segment.length <= 8 && !stopTerms.has(segment)) terms.add(segment);
        for (let i = 0; i < segment.length - 1; i++) {
          const pair = segment.slice(i, i + 2);
          if (!stopTerms.has(pair)) terms.add(pair);
        }
        for (let i = 0; i < segment.length - 2; i++) {
          const triple = segment.slice(i, i + 3);
          if (!stopTerms.has(triple)) terms.add(triple);
        }
      } else if (segment.length >= 2) {
        terms.add(segment);
      }
    }
    return Array.from(terms);
  }

  /**
   * 构建上下文信息
   */
  buildContext(retrievedDocs) {
    if (!retrievedDocs || retrievedDocs.length === 0) {
      return '暂无相关信息';
    }

    const contextParts = retrievedDocs.map((doc, index) => {
      const similarity = (doc.similarity * 100).toFixed(1);
      const source = doc.metadata?.document_title || '未知文档';
      
      return `[来源: ${source}, 相关度: ${similarity}%]\n${doc.content}`;
    });

    return contextParts.join('\n\n---\n\n');
  }

  /**
   * 记录检索日志
   */
  async logRetrieval(query, results) {
    try {
      const sql = `
        INSERT INTO retrieval_logs (query, retrieved_chunks, response_quality)
        VALUES (?, ?, ?)
      `;

      const retrievedChunks = JSON.stringify(results.map(r => ({
        content: r.content.substring(0, 200) + '...',
        similarity: r.similarity,
        metadata: r.metadata
      })));

      // 简单的质量评估：基于平均相似度
      const avgSimilarity = results.length > 0 
        ? results.reduce((sum, r) => sum + r.similarity, 0) / results.length 
        : 0;
      const quality = Math.round(avgSimilarity * 100);

      await this.dbManager.run(sql, [query, retrievedChunks, quality]);
    } catch (error) {
      console.warn('记录检索日志失败:', error);
    }
  }

  /**
   * 获取文档列表
   */
  async getDocuments(companyId) {
    return await this.documentService.getDocuments(companyId);
  }

  /**
   * 获取文档详情
   */
  async getDocument(documentId) {
    const document = await this.documentService.getDocument(documentId);
    if (document) {
      const chunks = await this.documentService.getDocumentChunks(documentId);
      return { ...document, chunks };
    }
    return null;
  }

  /**
   * 获取文档块
   */
  async getDocumentChunks(documentId) {
    return await this.documentService.getDocumentChunks(documentId);
  }

  /**
   * 删除文档
   */
  async deleteDocument(documentId) {
    try {
      // 1. 获取文档信息，检查状态
      const document = await this.documentService.getDocument(documentId);
      if (!document) {
        throw new Error('文档不存在');
      }

      console.log(`删除文档: ${document.title}, 状态: ${document.status}`);

      // 2. 如果文档正在处理中，先停止处理（这里可以添加停止处理的逻辑）
      if (document.status === 'processing') {
        console.log(`文档 ${document.title} 正在处理中，立即停止处理`);
        // 可以在这里添加停止异步处理任务的逻辑
      }

      // 3. 删除向量数据（如果存在）
      try {
        await this.vectorService.deleteDocumentVectors(documentId);
      } catch (vectorError) {
        console.warn('删除向量数据失败，继续删除文档:', vectorError);
      }
      
      // 4. 删除文档文件和数据库记录
      await this.documentService.deleteDocument(documentId);

      return { 
        success: true, 
        message: document.status === 'processing' 
          ? '文档删除成功，已停止处理' 
          : '文档删除成功' 
      };
    } catch (error) {
      console.error('删除文档失败:', error);
      throw new Error(`删除文档失败: ${error.message}`);
    }
  }

  /**
   * 获取知识库统计信息
   */
  async getStats(companyId) {
    try {
      // 文档统计
      const documents = await this.documentService.getDocuments(companyId);
      const totalDocuments = documents.length;
      const processedDocuments = documents.filter(d => d.status === 'processed').length;
      const failedDocuments = documents.filter(d => d.status === 'failed').length;

      // 向量统计
      const vectorStats = await this.vectorService.getStats();

      // 检索统计
      const retrievalStats = await this.getRetrievalStats(companyId);

      return {
        documents: {
          total: totalDocuments,
          processed: processedDocuments,
          failed: failedDocuments
        },
        vectors: vectorStats,
        retrieval: retrievalStats
      };
    } catch (error) {
      console.error('获取统计信息失败:', error);
      throw error;
    }
  }

  /**
   * 获取检索统计信息
   */
  async getRetrievalStats(companyId) {
    try {
      const sql = `
        SELECT 
          COUNT(*) as total_queries,
          AVG(response_quality) as avg_quality,
          MAX(timestamp) as last_query_time
        FROM retrieval_logs
        WHERE timestamp >= datetime('now', '-7 days')
      `;

      const stats = await this.dbManager.get(sql);
      return stats || { total_queries: 0, avg_quality: 0, last_query_time: null };
    } catch (error) {
      console.warn('获取检索统计失败:', error);
      return { total_queries: 0, avg_quality: 0, last_query_time: null };
    }
  }

  /**
   * 搜索文档（简单文本搜索）
   */
  async searchDocuments(query, companyId, limit = 10) {
    try {
      const sql = `
        SELECT d.*, 
               GROUP_CONCAT(dc.content, ' ') as content_preview
        FROM documents d
        LEFT JOIN document_chunks dc ON d.id = dc.document_id
        WHERE d.company_id = ? 
          AND (d.title LIKE ? OR dc.content LIKE ?)
        GROUP BY d.id
        ORDER BY d.upload_time DESC
        LIMIT ?
      `;

      const searchTerm = `%${query}%`;
      const results = await this.dbManager.all(sql, [companyId, searchTerm, searchTerm, limit]);

      return results.map(doc => ({
        ...doc,
        content_preview: doc.content_preview 
          ? doc.content_preview.substring(0, 200) + '...' 
          : ''
      }));
    } catch (error) {
      console.error('搜索文档失败:', error);
      throw error;
    }
  }

  /**
   * 重新处理失败的文档
   */
  async reprocessFailedDocuments(companyId) {
    try {
      const documents = await this.documentService.getDocuments(companyId);
      const toReprocess = documents.filter(d => d.status === 'failed');
      
      const results = [];
      for (const doc of toReprocess) {
        try {
          console.log(`重新处理文档: ${doc.title} (状态: ${doc.status})`);
          
          await this.documentService.updateDocumentStatus(doc.id, 'processing');
          const content = await this.documentService.parseDocument(doc.file_path, doc.file_type);
          const chunks = this.documentService.chunkDocument(content);
          if (chunks.length === 0) throw new Error('文档中没有可检索的文字内容');
          await this.vectorService.deleteDocumentVectors(doc.id);
          await this.dbManager.run('DELETE FROM document_chunks WHERE document_id = ?', [doc.id]);
          await this.documentService.saveDocumentChunks(doc.id, chunks);
          await this.documentService.updateDocumentStatus(doc.id, 'processed');
          results.push({ id: doc.id, status: 'success' });
        } catch (error) {
          await this.documentService.updateDocumentStatus(doc.id, 'failed');
          console.error(`重新处理文档失败: ${doc.title}`, error);
          results.push({ id: doc.id, status: 'failed', error: error.message });
        }
      }

      return results;
    } catch (error) {
      console.error('重新处理失败文档失败:', error);
      throw error;
    }
  }
}

module.exports = KnowledgeService;
