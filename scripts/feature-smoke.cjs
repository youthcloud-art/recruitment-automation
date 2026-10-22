// Read-only live smoke check for the local IT recruiting workflow. The Excel
// preview endpoint parses an in-memory workbook without applying it as a job.
const assert = require('node:assert/strict');
const XLSX = require('../backend/node_modules/xlsx');

const base = 'http://127.0.0.1:5001/api';

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(20000), ...options });
  assert.equal(response.status, 200, `${path}: HTTP ${response.status}`);
  return response;
}

async function json(path, options) {
  const result = await (await request(path, options)).json();
  assert.equal(result.success, true, `${path}: ${result.message || 'request failed'}`);
  return result.data;
}

async function main() {
  const original = await json('/recruitment-pipeline/active-job');
  assert.equal(original.title, 'IT网络运维');

  const positions = await json('/positions');
  assert.ok(positions.some(position => position.title === original.title), 'local IT position missing');

  const template = await request('/recruitment-pipeline/active-job/template');
  assert.match(template.headers.get('content-type') || '', /spreadsheetml/);
  const workbook = XLSX.read(Buffer.from(await template.arrayBuffer()), { type: 'buffer' });
  const sheet = workbook.Sheets['岗位筛选条件'];
  assert.ok(sheet, 'template worksheet missing');
  sheet.B7 = { t: 's', v: original.title };
  sheet.B9 = { t: 'n', v: 3 };
  sheet.B10 = { t: 's', v: '大专' };
  sheet.B11 = { t: 's', v: '网络故障排查、Linux 运维' };
  const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), '岗位条件模板.xlsx');
  const preview = await json('/recruitment-pipeline/active-job/preview-import', { method: 'POST', body: form });
  assert.equal(preview.title, original.title);
  assert.equal(preview.updatedAt, null);
  assert.match(preview.jobRequirements, /网络故障排查/);

  const recommendation = await json('/recruitment-pipeline/recommendations?minScore=70&limit=3');
  assert.equal(recommendation.job.title, original.title);
  assert.ok(Array.isArray(recommendation.recommendations));
  const analytics = await json('/recruitment-pipeline/analytics?scope=active');
  assert.equal(analytics.job.title, original.title);

  const report = await request('/recruitment-pipeline/report?format=docx&topN=3');
  assert.match(report.headers.get('content-type') || '', /wordprocessingml/);
  const reportBytes = Buffer.from(await report.arrayBuffer());
  assert.equal(reportBytes.subarray(0, 2).toString(), 'PK');

  const docs = await json('/knowledge/documents?companyId=1');
  const after = await json('/recruitment-pipeline/active-job');
  assert.deepEqual(after, original, 'smoke check unexpectedly changed the active job');
  console.log(JSON.stringify({ position: original.title, positions: positions.length,
    templatePreview: preview.title, recommendations: recommendation.recommendations.length,
    eligibleRecommendations: recommendation.qualifiedCount,
    analyticsResumes: analytics.metrics.total, wordReportBytes: reportBytes.length,
    knowledgeDocuments: docs.length, activeJobUnchanged: true }));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
