const multer = require('multer');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const xlsx = require('xlsx');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const { portableBasename } = require('../utils/portablePath');

/**
 * 文档处理服务类
 * 负责文档上传、解析、分块等功能
 */
class DocumentService {
  constructor(dbManager) {
    this.dbManager = dbManager;
    this.uploadDir = path.join(__dirname, '../../uploads');
    // Multer may receive a request immediately after service construction.
    fsSync.mkdirSync(this.uploadDir, { recursive: true });
  }

  /**
   * 确保上传目录存在
   */
  async ensureUploadDir() {
    try {
      await fs.access(this.uploadDir);
    } catch (error) {
      await fs.mkdir(this.uploadDir, { recursive: true });
    }
  }

  resolveDocumentPath(storedPath) {
    // Keep compatibility with older absolute paths while they still exist on
    // this host; after a move, resolve their basename in the new uploads dir.
    if (path.isAbsolute(String(storedPath || '')) && fsSync.existsSync(storedPath)) {
      return storedPath;
    }
    const candidate = path.resolve(this.uploadDir, portableBasename(storedPath));
    if (path.dirname(candidate) !== path.resolve(this.uploadDir)) {
      throw new Error('文档路径无效');
    }
    // Old rows held an absolute path. A restored library uses the same file
    // basename in its new upload directory, without editing historical rows.
    return candidate;
  }

  /**
   * 设置文件上传配置
   */
  setupUpload() {
    return multer({
      storage: multer.diskStorage({
        destination: this.uploadDir,
        filename: (req, file, cb) => {
          const safeName = path.basename(file.originalname.replace(/\\/g, '/'));
          const uniqueName = `${Date.now()}-${crypto.randomUUID()}-${safeName}`;
          cb(null, uniqueName);
        }
      }),
      limits: { 
        fileSize: 50 * 1024 * 1024, // 50MB
        files: 10 // 最多10个文件
      },
      fileFilter: (req, file, cb) => {
        const types = {
          '.pdf': 'application/pdf',
          '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          '.txt': 'text/plain',
          '.md': 'text/markdown'
        };
        const extension = path.extname(file.originalname).toLowerCase();
        if (!types[extension]) return cb(new Error('仅支持 PDF、DOCX、XLSX、TXT 和 MD 文件'), false);
        // Some browsers use application/octet-stream for TXT/Markdown.
        file.mimetype = types[extension];
        cb(null, true);
      }
    });
  }

  /**
   * 保存文档记录到数据库
   */
  async saveDocument(file, companyId, title) {
    const storedPath = path.dirname(path.resolve(file.path)) === path.resolve(this.uploadDir)
      ? portableBasename(file.path) : file.path;
    const sql = `
      INSERT INTO documents (company_id, title, file_path, file_type, file_size, status)
      VALUES (?, ?, ?, ?, ?, 'processing')
    `;
    
    const result = await this.dbManager.run(sql, [
      companyId,
      title || file.originalname,
      storedPath,
      file.mimetype,
      file.size
    ]);

    return {
      id: result.id,
      title: title || file.originalname,
      file_path: this.resolveDocumentPath(file.path),
      file_type: file.mimetype,
      file_size: file.size
    };
  }

  /**
   * 解析文档内容
   */
  async parseDocument(filePath, fileType) {
    try {
      switch (fileType) {
        case 'application/pdf':
          return await this.parsePDF(filePath);
        case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
          return await this.parseDOCX(filePath);
        case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
          return await this.parseXLSX(filePath);
        case 'text/plain':
        case 'text/markdown':
          return await this.parseTXT(filePath);
        default:
          throw new Error('不支持的文件类型');
      }
    } catch (error) {
      console.error('文档解析失败:', error);
      throw new Error(`文档解析失败: ${error.message}`);
    }
  }

  /**
   * 解析PDF文档
   */
  async parsePDF(filePath) {
    const dataBuffer = await fs.readFile(filePath);
    const data = await pdfParse(dataBuffer);
    return data.text;
  }

  /**
   * 解析Word文档
   */
  async parseDOCX(filePath) {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }

  /**
   * 解析Excel文档
   */
  async parseXLSX(filePath) {
    const workbook = xlsx.readFile(filePath);
    let content = '';
    
    for (const sheetName of workbook.SheetNames) {
      const worksheet = workbook.Sheets[sheetName];
      const jsonData = xlsx.utils.sheet_to_json(worksheet, { header: 1 });
      
      content += `工作表: ${sheetName}\n`;
      for (const row of jsonData) {
        if (row.length > 0) {
          content += row.join('\t') + '\n';
        }
      }
      content += '\n';
    }
    
    return content;
  }

  /**
   * 解析文本文件
   */
  async parseTXT(filePath) {
    const content = await fs.readFile(filePath, 'utf-8');
    return content;
  }

  /**
   * 文档分块
   */
  chunkDocument(content, chunkSize = 1000) {
    const source = String(content || '');
    if (!source.trim()) return [];

    const requestedLength = Number(chunkSize);
    const maxLength = Number.isFinite(requestedLength)
      ? Math.max(2, Math.floor(requestedLength)) : 1000;
    const chunks = [];

    // Find a sentence/line ending when possible, but still split a single
    // punctuation-free Excel cell or TXT paragraph at the hard size limit.
    // Preserve the original text so searches can match punctuation and lines.
    for (let start = 0; start < source.length;) {
      let end = Math.min(start + maxLength, source.length);
      if (end < source.length) {
        // Avoid cutting a UTF-16 surrogate pair (e.g. emoji) in half.
        const lastCodeUnit = source.charCodeAt(end - 1);
        if (lastCodeUnit >= 0xD800 && lastCodeUnit <= 0xDBFF) end -= 1;

        const window = source.slice(start, end);
        const boundaries = [...window.matchAll(/[。！？.!?\r\n]/g)];
        const boundary = boundaries.at(-1);
        if (boundary && boundary.index + boundary[0].length >= maxLength / 2) {
          end = start + boundary.index + boundary[0].length;
        }
      }
      const chunk = source.slice(start, end);
      if (chunk.trim()) chunks.push(chunk);
      start = end;
    }

    return chunks;
  }

  /**
   * 保存文档块到数据库
   */
  async saveDocumentChunks(documentId, chunks) {
    const sql = `
      INSERT INTO document_chunks (document_id, content, chunk_index, tags)
      VALUES (?, ?, ?, ?)
    `;

    for (let i = 0; i < chunks.length; i++) {
      await this.dbManager.run(sql, [
        documentId,
        chunks[i],
        i,
        JSON.stringify({ chunk_index: i, total_chunks: chunks.length })
      ]);
    }
  }

  /**
   * 更新文档状态
   */
  async updateDocumentStatus(documentId, status) {
    const sql = `UPDATE documents SET status = ? WHERE id = ?`;
    await this.dbManager.run(sql, [status, documentId]);
  }

  /**
   * 获取文档列表
   */
  async getDocuments(companyId) {
    const sql = `
      SELECT id, title, file_type, file_size, upload_time, status, file_path
      FROM documents 
      WHERE company_id = ?
      ORDER BY upload_time DESC
    `;
    
    const rows = await this.dbManager.all(sql, [companyId]);
    return rows.map(row => ({ ...row, file_path: this.resolveDocumentPath(row.file_path) }));
  }

  /**
   * 获取文档详情
   */
  async getDocument(documentId) {
    const sql = `SELECT * FROM documents WHERE id = ?`;
    const row = await this.dbManager.get(sql, [documentId]);
    return row ? { ...row, file_path: this.resolveDocumentPath(row.file_path) } : null;
  }

  /**
   * 获取文档块
   */
  async getDocumentChunks(documentId) {
    const sql = `
      SELECT * FROM document_chunks 
      WHERE document_id = ?
      ORDER BY chunk_index
    `;
    
    return await this.dbManager.all(sql, [documentId]);
  }

  /**
   * 删除文档
   */
  async deleteDocument(documentId) {
    // 获取文档信息
    const document = await this.getDocument(documentId);
    if (!document) {
      throw new Error('文档不存在');
    }

    console.log(`删除文档: ${document.title}, 状态: ${document.status}`);

    // 删除文件
    try {
      await fs.unlink(document.file_path);
      console.log(`文件删除成功: ${document.file_path}`);
    } catch (error) {
      console.warn('删除文件失败:', error);
      // 文件不存在或已被删除，继续执行
    }

    // 删除数据库记录
    try {
      await this.dbManager.run('DELETE FROM document_chunks WHERE document_id = ?', [documentId]);
      console.log(`文档块删除成功: document_id=${documentId}`);
    } catch (error) {
      console.warn('删除文档块失败:', error);
    }

    try {
      await this.dbManager.run('DELETE FROM documents WHERE id = ?', [documentId]);
      console.log(`文档记录删除成功: id=${documentId}`);
    } catch (error) {
      console.error('删除文档记录失败:', error);
      throw error;
    }
  }
}

module.exports = DocumentService;
