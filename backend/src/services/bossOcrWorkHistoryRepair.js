'use strict';

const resumeModel=require('../models/resumeModel');
const {extractBossOcrWorkExperience}=require('./bossOcrWorkExperience');

// Fill only empty, OCR-derived BOSS history fields from the already saved
// resume text. Small batches yield to the HTTP server between SQLite pages.
async function repairBossOcrWorkHistory({store=resumeModel,maxCandidates=5000,
  yieldTurn=()=>new Promise(resolve=>setImmediate(resolve))}={}) {
  let scanned=0,updated=0;
  const pageSize=100;
  for (let offset=0;offset<maxCandidates;offset+=pageSize) {
    const page=store.getResumesPage({source:'boss',limit:pageSize,offset});
    for (const item of page.items) {
      scanned++;
      if (item.parseMethod!=='ocr' || item.workExperience?.length ||
          !item.originalText || item.parseStatus!=='completed') continue;
      const history=extractBossOcrWorkExperience(item.originalText);
      if (!history.length) continue;
      store.updateCandidateMetadata(item.id,{workExperience:history});
      updated++;
    }
    if (page.items.length<pageSize) break;
    await yieldTurn();
  }
  return {scanned,updated};
}

module.exports={repairBossOcrWorkHistory};
